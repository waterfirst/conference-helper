const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { TranslationServiceClient } = require('@google-cloud/translate');
const admin = require('firebase-admin');
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
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
        console.log("Firebase Admin initialized successfully.");
    } catch (e) {
        console.error("Failed to initialize Firebase Admin:", e);
    }
} else {
    console.warn("⚠️ NO CREDENTIALS FOUND. Authentication verification will fail.");
    console.warn("Please download your service account key from web console and save it as 'backend/service-account.json'");
}

const db = admin.apps.length ? admin.firestore() : null;
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
 * Check if the user has a valid license (Quota, Subscription, etc.)
 */
const checkLicense = async (uid) => {
    if (!db) return true; // Bypass if DB not connected (Dev mode)

    try {
        const userRef = db.collection('users').doc(uid);
        const doc = await userRef.get();

        if (!doc.exists) {
            console.log(`✨ New user detected: ${uid}. Creating free trial account.`);
            await userRef.set({
                subscriptionStatus: 'trial',
                credits: 500, // Free 500 characters
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return true;
        }

        const userData = doc.data();

        if (userData.subscriptionStatus === 'active' || userData.subscriptionStatus === 'trial') {
            return true;
        }

        if (userData.credits > 0) {
            // Deduct credit
            await userRef.update({ credits: admin.firestore.FieldValue.increment(-1) });
            return true;
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
        // 1. Check License/Quota
        const hasLicense = await checkLicense(req.user.uid);
        if (!hasLicense) {
            return res.status(403).json({ error: 'License invalid or quota exceeded. Please purchase a plan.' });
        }

        // 2. Call Google Cloud Translation API
        const request = {
            parent: `projects/${PROJECT_ID}/locations/${LOCATION}`,
            contents: [text],
            mimeType: 'text/plain', // mime types: text/plain, text/html
            targetLanguageCode: targetLang,
        };

        // Note: This requires the Cloud Translation API to be enabled in GCP
        const [response] = await translateClient.translateText(request);
        const translatedText = response.translations[0].translatedText;

        res.json({ translatedText });

    } catch (error) {
        console.error('Translation error:', error);
        res.status(500).send('Internal Server Error');
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
