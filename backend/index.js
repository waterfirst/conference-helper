const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { TranslationServiceClient } = require('@google-cloud/translate');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const localKeyPath = './service-account.json';
let serviceAccount = null;
if (fs.existsSync(localKeyPath)) {
    console.log("Found local service account key. Setting credentials...");
    serviceAccount = require(localKeyPath);
    if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = localKeyPath;
}

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
    if (serviceAccount) {
        try {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("✅ Firebase Admin initialized.");
        } catch (e) {
            console.error("❌ Firebase Admin init failed:", e.message);
            admin.initializeApp();
        }
    } else {
        admin.initializeApp();
    }
}

const PROJECT_ID = serviceAccount?.project_id || process.env.PROJECT_ID || 'internation-conference-helper';
const LOCATION = 'global';

// [개선] 인증 정보 명시적 주입 (UNAUTHENTICATED 에러 해결)
const translateClient = serviceAccount ? new TranslationServiceClient({
    credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key
    },
    projectId: PROJECT_ID
}) : new TranslationServiceClient();

let db = null;
if (admin.apps.length) {
    try {
        db = admin.firestore('user');
        console.log("✅ Connected to Firestore database ID: user");
    } catch (e) {
        db = admin.firestore();
    }
}

/**
 * Middleware to verify Firebase Auth Token
 */
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send('Unauthorized: No token provided');
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        if (admin.apps.length) {
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = decodedToken;
            next();
        } else {
            throw new Error("Server missing credentials - cannot verify token.");
        }
    } catch (error) {
        console.error('Error verifying auth token:', error);
        res.status(403).send('Unauthorized: Invalid token');
    }
};

/**
 * Check if the user has a valid license (Trial period or isPaid status)
 */
const checkLicense = async (email) => {
    if (!db) return true;

    // [추가] 관리자 계정은 무제한 통과
    if (email === 'tearim07@gmail.com' || email === 'nakcho.choi@gmail.com') return true;

    try {
        const userRef = db.collection('users').doc(email);
        const doc = await userRef.get();

        if (!doc.exists) {
            console.log(`✨ New user detected: ${email}. Creating free trial account.`);
            await userRef.set({
                isPaid: false,
                trialStartDate: admin.firestore.FieldValue.serverTimestamp(),
                email: email
            });
            return true;
        }

        const userData = doc.data();

        // 1. Premium Check
        if (userData.isPaid === true) {
            return true;
        }

        // 2. Trial Period Check (5 Days)
        if (userData.trialStartDate) {
            const startDate = userData.trialStartDate.toDate();
            const now = new Date();
            const diffDays = Math.ceil((now - startDate) / (1000 * 60 * 60 * 24));
            if (diffDays <= 5) {
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error('License check failed:', error);
        return false;
    }
};

// --- Routes ---

app.get('/', (req, res) => {
    res.send('Translation API Service is running.');
});

/**
 * 무료 번역 API (인증 불필요 - 즉시 작동 보장)
 */
async function translateFree(text, targetLang, sourceLang) {
    try {
        const sl = sourceLang.split('-')[0]; // 'en-US' -> 'en'
        const tl = targetLang.split('-')[0]; // 'ko' -> 'ko'
        
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
        
        const response = await axios.get(url, { timeout: 5000 });
        
        if (response.data && response.data[0]) {
            // 응답 구조: [[["번역문","원문",null,null,10]],null,"en"]
            let translated = '';
            for (const segment of response.data[0]) {
                if (segment[0]) translated += segment[0];
            }
            return translated.trim();
        }
        return null;
    } catch (e) {
        console.error("Free Translation Error:", e.message);
        return null;
    }
}

/**
 * Cloud Translation API v3 (서비스 계정 인증 필요)
 */
async function translateWithCloudAPI(text, targetLang, sourceLang) {
    try {
        const request = {
            parent: `projects/${PROJECT_ID}/locations/${LOCATION}`,
            contents: [text],
            mimeType: 'text/plain',
            sourceLanguageCode: sourceLang,
            targetLanguageCode: targetLang,
        };
        const [response] = await translateClient.translateText(request);
        if (response.translations && response.translations.length > 0) {
            return response.translations[0].translatedText;
        }
        return null;
    } catch (e) {
        console.error("Cloud Translation Error:", e.message);
        return null;
    }
}

app.post('/translate', verifyToken, async (req, res) => {
    const { text, targetLang, sourceLang } = req.body;

    if (!text || !targetLang) {
        return res.status(400).send('Missing text or targetLang');
    }

    try {
        // 1. Check License
        const hasLicense = await checkLicense(req.user.email);
        if (!hasLicense) {
            return res.status(403).json({ error: 'License invalid or trial expired.' });
        }

        const sl = sourceLang || 'en';
        const tl = targetLang || 'ko';
        console.log(`[Translate] ${sl} -> ${tl}: "${text.substring(0, 40)}..."`);

        let translatedText = null;
        let engine = 'none';

        // 방법 1: 무료 번역 API (인증 불필요, 즉시 작동)
        translatedText = await translateFree(text, tl, sl);
        if (translatedText && translatedText !== text) {
            engine = 'google-free';
        }

        // 방법 2: Cloud Translation API (서비스 계정 권한 필요)
        if (!translatedText || translatedText === text) {
            const cloudResult = await translateWithCloudAPI(text, tl, sl);
            if (cloudResult && cloudResult !== text) {
                translatedText = cloudResult;
                engine = 'cloud-v3';
            }
        }

        if (translatedText && translatedText !== text) {
            console.log(`[Success] via ${engine}: "${translatedText.substring(0, 50)}..."`);
            res.json({ translatedText, engine });
        } else {
            console.warn('[Fail] All translation engines failed.');
            res.status(500).json({ error: 'All translation engines failed', translatedText: text });
        }

    } catch (error) {
        console.error('Final Translation failure:', error.message);
        res.status(500).json({ error: 'Translation failed', details: error.message });
    }
});

// --- Payment Confirmation ---

app.post('/confirm-payment', async (req, res) => {
    const { paymentKey, orderId, amount } = req.body;

    // 1. Verify with Toss Payments API
    // WARNING: In production, use process.env.TOSS_SECRET_KEY
    const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || 'test_sk_zRKBSZ6o75D4w7w9D2v3PXVDv9M1';
    const widgetSecretKey = TOSS_SECRET_KEY;
    const encryptedSecretKey = 'Basic ' + Buffer.from(widgetSecretKey + ':').toString('base64');

    try {
        const response = await axios.post('https://api.tosspayments.com/v1/payments/confirm', {
            paymentKey,
            orderId,
            amount
        }, {
            headers: {
                Authorization: encryptedSecretKey,
                'Content-Type': 'application/json'
            }
        });

        // 2. Success - Update Firestore
        // Check orderId structure for Email: ORDER-EMAIL-TIMESTAMP
        let email = null;
        if (orderId && orderId.startsWith('ORDER-')) {
            const parts = orderId.split('-');
            // parts[0] = "ORDER", parts[1] = encoded email, parts[2] = timestamp
            if (parts.length >= 3) {
                try {
                    email = Buffer.from(parts[1], 'base64').toString('utf-8');
                } catch (e) {
                    console.error("Failed to decode email from orderId", parts[1]);
                }
            }
        }

        const licenseKey = `LICENSE-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

        if (db) {
            // A. Store Transaction Log
            await db.collection('transactions').doc(orderId).set({
                paymentKey, orderId, amount, status: 'DONE',
                email: email || 'unknown', licenseKey,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // B. Auto-activate User using Email as doc ID
            if (email) {
                console.log(`Auto-activating subscription for user: ${email}`);
                await db.collection('users').doc(email).set({
                    isPaid: true,
                    plan: amount >= 700000 ? 'lab' : 'personal',
                    licenseKey: licenseKey,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }
        }

        // 4. Return to Client
        res.json({
            status: 'success',
            message: 'Subscription activated',
            key: licenseKey
        });

    } catch (e) {
        console.error('Payment Verification Failed:', e.response ? e.response.data : e.message);
        res.status(400).json({
            status: 'fail',
            message: e.response ? e.response.data.message : 'Payment verification failed'
        });
    }
});

const PORT = process.env.PORT || 8080;
// Cloud Run REQUIRES listening on 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is listening on 0.0.0.0:${PORT}`);
});
