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

// Auto-detect service account for local dev
const localKeyPath = './service-account.json';
if (fs.existsSync(localKeyPath)) {
    console.log("Found local service account key. Setting credentials...");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = localKeyPath;
}

// Initialize Firebase Admin SDK
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
        const serviceAccount = require(localKeyPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin initialized with service account.");
    } catch (e) {
        console.error("❌ Failed to initialize Firebase Admin:", e);
        // Fallback or exit
    }
} else {
    console.warn("⚠️ NO CREDENTIALS ENV FOUND. Using default credentials.");
    try {
        admin.initializeApp();
    } catch (e) {
        console.error("❌ Default init failed:", e);
    }
}

let db = null;
if (admin.apps.length) {
    try {
        // 'user'라는 특정 데이터베이스 ID를 안전하게 호출 (데이터베이스 ID 'user'가 확실한 경우)
        db = admin.firestore('user');
        console.log("✅ Connected to Firestore database ID: user");
    } catch (e) {
        console.error("⚠️ Failed to connect to Firestore 'user', using default DB:", e.message);
        db = admin.firestore();
    }
}
const translateClient = new TranslationServiceClient();

const PROJECT_ID = process.env.PROJECT_ID || 'internation-conference-helper';
const LOCATION = 'global';

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
    if (!db) return true; // Bypass if DB not connected (Dev mode)

    try {
        const userRef = db.collection('users').doc(email); // Use email as Document ID
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

app.post('/translate', verifyToken, async (req, res) => {
    const { text, targetLang } = req.body;

    if (!text || !targetLang) {
        return res.status(400).send('Missing text or targetLang');
    }

    try {
        // 1. Check License/Quota using Email
        const hasLicense = await checkLicense(req.user.email);
        if (!hasLicense) {
            return res.status(403).json({ error: 'License invalid or trial expired. Please purchase a plan.' });
        }

        // 2. Call Google Cloud Translation API
        const request = {
            parent: `projects/${PROJECT_ID}/locations/${LOCATION}`,
            contents: [text],
            mimeType: 'text/plain',
            targetLanguageCode: targetLang,
        };

        const [response] = await translateClient.translateText(request);
        const translatedText = response.translations[0].translatedText;

        res.json({ translatedText });

    } catch (error) {
        console.error('Translation error:', error);
        res.status(500).send('Internal Server Error');
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
