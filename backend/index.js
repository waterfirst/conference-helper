const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { TranslationServiceClient } = require('@google-cloud/translate');

dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const REALTIME_MODEL = process.env.REALTIME_TRANSLATION_MODEL || 'gpt-realtime-translate';
const REALTIME_TRANSCRIPTION_MODEL = process.env.REALTIME_TRANSCRIPTION_MODEL || 'gpt-realtime-whisper';
const TEXT_TRANSLATION_MODEL = process.env.TEXT_TRANSLATION_MODEL || 'gpt-5.6-luna';
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'gpt-5.6-terra';
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'user';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 5);
const MAX_TRANSLATION_CHARS = 5000;
const MAX_SUMMARY_CHARS = 160000;

const TARGET_LANGUAGES = new Set([
    'de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'vi', 'zh'
]);

const SOURCE_LANGUAGES = new Set([
    'auto', 'de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'vi', 'zh'
]);

const PLAN_AMOUNTS = new Map([
    [100000, { plan: 'personal', licenses: 1 }],
    [700000, { plan: 'lab', licenses: 10 }]
]);

class AppError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

const asyncHandler = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
};

function normalizeLanguage(value, allowed, fallback) {
    const normalized = String(value || fallback || '')
        .trim()
        .toLowerCase()
        .split('-')[0];
    if (!allowed.has(normalized)) {
        throw new AppError(400, 'UNSUPPORTED_LANGUAGE', `Unsupported language: ${normalized || 'empty'}`);
    }
    return normalized;
}

function normalizeText(value, field, maxLength) {
    if (typeof value !== 'string') {
        throw new AppError(400, 'INVALID_INPUT', `${field} must be a string.`);
    }
    const text = value.trim();
    if (!text) throw new AppError(400, 'INVALID_INPUT', `${field} is required.`);
    if (text.length > maxLength) {
        throw new AppError(413, 'INPUT_TOO_LARGE', `${field} exceeds ${maxLength.toLocaleString()} characters.`);
    }
    return text;
}

function safeIdentifier(user) {
    const source = user.uid || user.email || 'anonymous';
    return crypto.createHash('sha256').update(String(source)).digest('hex');
}

function extractResponseText(response) {
    if (typeof response?.output_text === 'string') return response.output_text;
    const pieces = [];
    for (const item of response?.output || []) {
        for (const content of item?.content || []) {
            if (typeof content?.text === 'string') pieces.push(content.text);
        }
    }
    return pieces.join('').trim();
}

function buildTranscript(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new AppError(400, 'EMPTY_TRANSCRIPT', 'At least one transcript entry is required.');
    }

    const lines = entries.slice(-1200).map((entry, index) => {
        const source = String(entry?.source || '').trim();
        const translated = String(entry?.translated || '').trim();
        const time = String(entry?.time || '').trim() || `#${index + 1}`;
        if (!source && !translated) return '';
        return `[${time}] ${source || '(source unavailable)'}${translated ? `\n→ ${translated}` : ''}`;
    }).filter(Boolean);

    return normalizeText(lines.join('\n\n'), 'transcript', MAX_SUMMARY_CHARS);
}

function summarySchema() {
    return {
        type: 'object',
        additionalProperties: false,
        required: [
            'title', 'executive_summary', 'key_points', 'decisions',
            'action_items', 'open_questions', 'presentation_outline', 'keywords'
        ],
        properties: {
            title: { type: 'string' },
            executive_summary: { type: 'string' },
            key_points: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            action_items: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['owner', 'task', 'due'],
                    properties: {
                        owner: { type: ['string', 'null'] },
                        task: { type: 'string' },
                        due: { type: ['string', 'null'] }
                    }
                }
            },
            open_questions: { type: 'array', items: { type: 'string' } },
            presentation_outline: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['section', 'summary'],
                    properties: {
                        section: { type: 'string' },
                        summary: { type: 'string' }
                    }
                }
            },
            keywords: { type: 'array', items: { type: 'string' } }
        }
    };
}

let firebaseState;

function loadServiceAccount() {
    const configuredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const credentialPath = configuredPath
        ? path.resolve(configuredPath)
        : path.join(__dirname, 'service-account.json');
    if (!fs.existsSync(credentialPath)) return null;
    return JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
}

function getFirebaseServices() {
    if (firebaseState) return firebaseState;

    const serviceAccount = loadServiceAccount();
    if (!admin.apps.length) {
        const options = serviceAccount
            ? { credential: admin.credential.cert(serviceAccount) }
            : {};
        admin.initializeApp(options);
    }

    firebaseState = {
        auth: admin.auth(),
        db: getFirestore(admin.app(), FIRESTORE_DATABASE_ID)
    };
    return firebaseState;
}

async function verifyFirebaseUser(token) {
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in is required.');
    try {
        const { auth } = getFirebaseServices();
        return await auth.verifyIdToken(token);
    } catch (error) {
        console.warn(JSON.stringify({ event: 'auth_failed', reason: error.code || error.message }));
        throw new AppError(401, 'INVALID_TOKEN', 'Your session is invalid or expired.');
    }
}

function adminEmails() {
    return new Set(String(process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean));
}

async function checkUserLicense(user) {
    const email = String(user.email || '').toLowerCase();
    if (!email) throw new AppError(403, 'EMAIL_REQUIRED', 'A verified email is required.');
    if (adminEmails().has(email)) return { valid: true, plan: 'admin', daysRemaining: null };

    const { db } = getFirebaseServices();
    const userRef = db.collection('users').doc(email);
    const snapshot = await userRef.get();

    if (!snapshot.exists) {
        await userRef.set({
            email,
            isPaid: false,
            trialStartDate: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp()
        });
        return { valid: true, plan: 'trial', daysRemaining: TRIAL_DAYS };
    }

    const data = snapshot.data();
    if (data.isPaid === true) {
        return { valid: true, plan: data.plan || 'personal', daysRemaining: null };
    }

    const start = data.trialStartDate?.toDate?.();
    if (!start) return { valid: false, plan: 'expired', daysRemaining: 0 };

    const elapsedDays = Math.floor((Date.now() - start.getTime()) / 86400000);
    const daysRemaining = Math.max(0, TRIAL_DAYS - elapsedDays);
    return { valid: elapsedDays < TRIAL_DAYS, plan: 'trial', daysRemaining };
}

let googleTranslateClient;

function getGoogleTranslateClient() {
    if (googleTranslateClient) return googleTranslateClient;
    const serviceAccount = loadServiceAccount();
    googleTranslateClient = serviceAccount
        ? new TranslationServiceClient({
            credentials: {
                client_email: serviceAccount.client_email,
                private_key: serviceAccount.private_key
            },
            projectId: serviceAccount.project_id
        })
        : new TranslationServiceClient();
    return googleTranslateClient;
}

async function translateWithGoogle(text, targetLanguage, sourceLanguage) {
    const projectId = process.env.PROJECT_ID || loadServiceAccount()?.project_id;
    if (!projectId) throw new AppError(503, 'GOOGLE_TRANSLATE_NOT_CONFIGURED', 'Google translation is not configured.');

    const request = {
        parent: `projects/${projectId}/locations/global`,
        contents: [text],
        mimeType: 'text/plain',
        targetLanguageCode: targetLanguage
    };
    if (sourceLanguage !== 'auto') request.sourceLanguageCode = sourceLanguage;

    const [response] = await getGoogleTranslateClient().translateText(request);
    const translated = response.translations?.[0]?.translatedText?.trim();
    if (!translated) throw new AppError(502, 'GOOGLE_TRANSLATION_FAILED', 'Google translation returned no text.');
    return translated;
}

async function openAIRequest(pathname, body, safetyId, fetchImpl = global.fetch) {
    if (!process.env.OPENAI_API_KEY) {
        throw new AppError(503, 'OPENAI_NOT_CONFIGURED', 'OpenAI realtime translation is not configured.');
    }
    if (typeof fetchImpl !== 'function') {
        throw new AppError(500, 'FETCH_UNAVAILABLE', 'This server requires Node.js 20 or newer.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
        response = await fetchImpl(`${OPENAI_API_BASE}${pathname}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
                'OpenAI-Safety-Identifier': safetyId
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new AppError(504, 'AI_TIMEOUT', 'The AI service timed out.');
        }
        throw new AppError(502, 'AI_UNREACHABLE', 'The AI service is unreachable.', error.message);
    } finally {
        clearTimeout(timeout);
    }

    const raw = await response.text();
    let payload;
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        payload = { raw };
    }

    if (!response.ok) {
        const upstreamMessage = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw new AppError(502, 'AI_UPSTREAM_ERROR', 'The AI service rejected the request.', upstreamMessage);
    }
    return payload;
}

function createRateLimiter({ limit, windowMs, prefix }) {
    const buckets = new Map();
    return (req, res, next) => {
        const key = `${prefix}:${req.user?.uid || req.ip}`;
        const now = Date.now();
        const bucket = buckets.get(key);
        if (!bucket || now >= bucket.resetAt) {
            buckets.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }
        if (bucket.count >= limit) {
            res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
            return next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.'));
        }
        bucket.count += 1;
        return next();
    };
}

function allowedOrigins() {
    const configured = String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return new Set(configured.length ? configured : [
        'https://waterfirst.github.io',
        'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ]);
}

function createApp(options = {}) {
    const app = express();
    const origins = allowedOrigins();
    const authenticate = options.authenticate || verifyFirebaseUser;
    const licenseCheck = options.licenseCheck || checkUserLicense;
    const requestOpenAI = options.openAIRequest || openAIRequest;

    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(cors({
        origin(origin, callback) {
            if (!origin || origins.has(origin)) return callback(null, true);
            return callback(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.'));
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id']
    }));
    app.use(express.json({ limit: '2mb' }));
    app.use((req, res, next) => {
        req.id = req.get('X-Request-Id') || crypto.randomUUID();
        res.set('X-Request-Id', req.id);
        const startedAt = Date.now();
        res.on('finish', () => {
            console.log(JSON.stringify({
                event: 'request', requestId: req.id, method: req.method,
                path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt
            }));
        });
        next();
    });

    const requireUser = asyncHandler(async (req, _res, next) => {
        const header = req.get('Authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        req.user = await authenticate(token);
        next();
    });

    const requireLicense = asyncHandler(async (req, _res, next) => {
        req.license = await licenseCheck(req.user);
        if (!req.license.valid) {
            throw new AppError(403, 'LICENSE_EXPIRED', 'Your trial or license has expired.');
        }
        next();
    });

    const realtimeLimit = createRateLimiter({ limit: 20, windowMs: 60000, prefix: 'realtime' });
    const translateLimit = createRateLimiter({ limit: 90, windowMs: 60000, prefix: 'translate' });
    const summaryLimit = createRateLimiter({ limit: 8, windowMs: 60000, prefix: 'summary' });

    app.get('/', (_req, res) => {
        res.json({ service: 'Conference Helper API', status: 'ok' });
    });

    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
            realtimeModel: REALTIME_MODEL,
            summaryModel: SUMMARY_MODEL,
            timestamp: new Date().toISOString()
        });
    });

    app.get('/me', requireUser, asyncHandler(async (req, res) => {
        const license = await licenseCheck(req.user);
        res.json({
            email: req.user.email,
            displayName: req.user.name || null,
            license
        });
    }));

    app.post('/realtime/session', requireUser, requireLicense, realtimeLimit, asyncHandler(async (req, res) => {
        const targetLanguage = normalizeLanguage(req.body?.targetLanguage, TARGET_LANGUAGES, 'ko');
        const payload = await requestOpenAI(
            '/realtime/translations/client_secrets',
            {
                session: {
                    model: REALTIME_MODEL,
                    audio: {
                        input: {
                            transcription: { model: REALTIME_TRANSCRIPTION_MODEL },
                            noise_reduction: { type: 'near_field' }
                        },
                        output: { language: targetLanguage }
                    }
                }
            },
            safeIdentifier(req.user)
        );

        const clientSecret = typeof payload.client_secret === 'string'
            ? payload.client_secret
            : payload.client_secret?.value || payload.value;
        const expiresAt = payload.client_secret?.expires_at || payload.expires_at || null;
        if (!clientSecret) {
            throw new AppError(502, 'INVALID_SESSION_RESPONSE', 'Realtime session did not return a client secret.');
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            client_secret: clientSecret,
            expires_at: expiresAt,
            model: REALTIME_MODEL,
            target_language: targetLanguage
        });
    }));

    app.post('/translate', requireUser, requireLicense, translateLimit, asyncHandler(async (req, res) => {
        const text = normalizeText(req.body?.text, 'text', MAX_TRANSLATION_CHARS);
        const sourceLanguage = normalizeLanguage(req.body?.sourceLang, SOURCE_LANGUAGES, 'auto');
        const targetLanguage = normalizeLanguage(req.body?.targetLang, TARGET_LANGUAGES, 'ko');
        const glossary = String(req.body?.glossary || '').trim().slice(0, 2000);
        const context = String(req.body?.context || '').trim().slice(-4000);

        if (sourceLanguage === targetLanguage) {
            return res.json({ translatedText: text, engine: 'identity' });
        }

        if (process.env.OPENAI_API_KEY) {
            try {
                const response = await requestOpenAI(
                    '/responses',
                    {
                        model: TEXT_TRANSLATION_MODEL,
                        reasoning: { effort: 'none' },
                        instructions: [
                            'You are a professional simultaneous interpreter for technical conferences.',
                            sourceLanguage === 'auto'
                                ? `Detect the source language and translate it into ${targetLanguage}.`
                                : `Translate from ${sourceLanguage} into ${targetLanguage}.`,
                            'Return only the translation. Preserve names, numbers, units, equations, acronyms, and uncertainty.',
                            glossary ? `Preferred terminology: ${glossary}` : '',
                            context ? `Recent context for disambiguation only: ${context}` : ''
                        ].filter(Boolean).join('\n'),
                        input: text,
                        max_output_tokens: 2000
                    },
                    safeIdentifier(req.user)
                );
                const translatedText = extractResponseText(response);
                if (translatedText) return res.json({ translatedText, engine: TEXT_TRANSLATION_MODEL });
            } catch (error) {
                console.warn(JSON.stringify({ event: 'text_translation_fallback', requestId: req.id, reason: error.code }));
            }
        }

        const translatedText = await translateWithGoogle(text, targetLanguage, sourceLanguage);
        return res.json({ translatedText, engine: 'google-cloud-translate-v3' });
    }));

    app.post('/summaries', requireUser, requireLicense, summaryLimit, asyncHandler(async (req, res) => {
        const transcript = buildTranscript(req.body?.entries);
        const mode = req.body?.mode === 'presentation' ? 'presentation' : 'meeting';
        const outputLanguage = normalizeLanguage(req.body?.outputLanguage, TARGET_LANGUAGES, 'ko');
        const meetingTitle = String(req.body?.title || '').trim().slice(0, 160);
        const glossary = String(req.body?.glossary || '').trim().slice(0, 2000);

        const response = await requestOpenAI(
            '/responses',
            {
                model: SUMMARY_MODEL,
                reasoning: { effort: 'low' },
                instructions: [
                    `Create an evidence-grounded ${mode === 'meeting' ? 'meeting record' : 'presentation brief'} in language code ${outputLanguage}.`,
                    'Use only facts present in the transcript. Do not invent speakers, owners, deadlines, decisions, or claims.',
                    'When an owner or due date is not explicit, return null. Keep technical terms, numbers, units, and qualifications exact.',
                    mode === 'meeting'
                        ? 'Prioritize decisions, disagreements, follow-up actions, owners, due dates, and unresolved questions.'
                        : 'Prioritize the thesis, section flow, evidence, methods, results, limitations, and audience questions.',
                    meetingTitle ? `Working title: ${meetingTitle}` : '',
                    glossary ? `Domain terminology: ${glossary}` : ''
                ].filter(Boolean).join('\n'),
                input: transcript,
                max_output_tokens: 6000,
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'conference_summary',
                        strict: true,
                        schema: summarySchema()
                    }
                }
            },
            safeIdentifier(req.user)
        );

        const outputText = extractResponseText(response);
        let summary;
        try {
            summary = JSON.parse(outputText);
        } catch {
            throw new AppError(502, 'INVALID_SUMMARY_RESPONSE', 'The summary service returned invalid structured data.');
        }
        res.json({ summary, model: SUMMARY_MODEL, mode });
    }));

    app.post('/confirm-payment', requireUser, asyncHandler(async (req, res) => {
        if (!process.env.TOSS_SECRET_KEY) {
            throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'Payment confirmation is not configured.');
        }
        const paymentKey = normalizeText(req.body?.paymentKey, 'paymentKey', 300);
        const orderId = normalizeText(req.body?.orderId, 'orderId', 100);
        const amount = Number(req.body?.amount);
        const selectedPlan = PLAN_AMOUNTS.get(amount);
        if (!selectedPlan) throw new AppError(400, 'INVALID_PLAN_AMOUNT', 'Unknown plan amount.');

        const { db } = getFirebaseServices();
        const transactionRef = db.collection('transactions').doc(orderId);
        const existing = await transactionRef.get();
        if (existing.exists) {
            const data = existing.data();
            if (data.email !== String(req.user.email).toLowerCase()) {
                throw new AppError(403, 'ORDER_OWNER_MISMATCH', 'Order belongs to another account.');
            }
            return res.json({ status: 'success', plan: data.plan, keys: data.licenseKeys });
        }

        const basicKey = Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString('base64');
        const confirmation = await axios.post(
            'https://api.tosspayments.com/v1/payments/confirm',
            { paymentKey, orderId, amount },
            { headers: { Authorization: `Basic ${basicKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const paid = confirmation.data;
        if (paid.status !== 'DONE' || Number(paid.totalAmount) !== amount || paid.orderId !== orderId) {
            throw new AppError(400, 'PAYMENT_MISMATCH', 'Payment confirmation did not match the order.');
        }

        const licenseKeys = Array.from({ length: selectedPlan.licenses }, () =>
            `LICENSE-${crypto.randomBytes(12).toString('hex').toUpperCase()}`
        );
        const email = String(req.user.email).toLowerCase();
        await transactionRef.set({
            orderId,
            paymentKeyHash: crypto.createHash('sha256').update(paymentKey).digest('hex'),
            amount,
            status: paid.status,
            email,
            plan: selectedPlan.plan,
            licenseKeys,
            approvedAt: paid.approvedAt || null,
            createdAt: FieldValue.serverTimestamp()
        });
        await db.collection('users').doc(email).set({
            email,
            isPaid: true,
            plan: selectedPlan.plan,
            licenseKey: licenseKeys[0],
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({ status: 'success', plan: selectedPlan.plan, keys: licenseKeys });
    }));

    app.use((req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')));
    app.use((error, req, res, _next) => {
        const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
        const code = error.code || (status === 413 ? 'INPUT_TOO_LARGE' : 'INTERNAL_ERROR');
        if (status >= 500) {
            console.error(JSON.stringify({
                event: 'request_error', requestId: req.id, code,
                message: error.message, details: error.details || null
            }));
        }
        res.status(status).json({
            error: { code, message: status >= 500 && code === 'INTERNAL_ERROR' ? 'Unexpected server error.' : error.message },
            requestId: req.id
        });
    });

    return app;
}

if (require.main === module) {
    createApp().listen(PORT, '0.0.0.0', () => {
        console.log(JSON.stringify({ event: 'server_started', host: '0.0.0.0', port: PORT }));
    });
}

module.exports = {
    AppError,
    TARGET_LANGUAGES,
    buildTranscript,
    createApp,
    extractResponseText,
    normalizeLanguage,
    summarySchema
};
