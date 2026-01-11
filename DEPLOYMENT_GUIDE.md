# SaaS Deployment Guide for Real-Time Translator

This guide details how to deploy your translation application using **Firebase** (for frontend/hosting/auth) and **Google Cloud Run** (for the secure backend).

## Prerequisites

1.  **Google Cloud Project**: Create a new project in the [Google Cloud Console](https://console.cloud.google.com/).
2.  **Firebase Project**: Create a project in [Firebase Console](https://console.firebase.google.com/) and link it to your Google Cloud Project.
3.  **Billing**: Enable billing on your Google Cloud Project (required for Cloud Run and Translation API).

---

## Step 1: Firebase Configuration (Frontend & Auth)

1.  **Enable Authentication**:
    *   Go to Firebase Console -> **Build** -> **Authentication**.
    *   Click "Get Started".
    *   Enable **Google** as a Sign-in provider.

2.  **Add Web App**:
    *   In Project Overview, click the Web icon (</>) to add a web app.
    *   Register the app (e.g., "Conference Translator").
    *   **Copy the firebaseConfig object**.

3.  **Update `index3.html`**:
    *   Open `index3.html`.
    *   Find the `firebaseConfig` object (around line ~318).
    *   Replace the placeholder values (`YOUR_API_KEY`, etc.) with the real values you copied.

4.  **Firestore Database**:
    *   Go to Firebase Console -> **Build** -> **Firestore Database**.
    *   Click "Create Database".
    *   Start in **Production mode**.
    *   Select a location (e.g., `asia-northeast3` for Seoul).

---

## Step 2: Backend Deployment (Cloud Run) - **EASIEST METHOD**

We recommend using **Google Cloud Shell** directly in your browser. No installation required.

1.  **Prepare Source Code**:
    *   On your computer, navigate to the `backend` folder.
    *   Compress the `backend` folder into a ZIP file named **`backend.zip`**.

2.  **Open Cloud Shell**:
    *   Go to [Google Cloud Console](https://console.cloud.google.com/).
    *   Click the **Activate Cloud Shell** icon (`>_`) in the top right toolbar.
    *   A terminal window will open at the bottom of the screen.

3.  **Upload Code**:
    *   In the Cloud Shell window, click the **More** button (three dots `⋮`) > **Upload**.
    *   Select your `backend.zip` file.

4.  **Deploy Command**:
    *   Copy and paste the following commands into the Cloud Shell terminal (one by one):

    ```bash
    # 1. Unzip the file
    unzip backend.zip -d backend

    # 2. Enter the directory
    cd backend

    # 3. Deploy to Cloud Run (Copy this WHOLE line)
    gcloud run deploy translator-backend --source . --region asia-northeast3 --allow-unauthenticated
    ```

5.  **Confirm Prompts**:
    *   If asked to enable APIs (e.g., Artifact Registry), type `y` and press Enter.
    *   If asked to create a repository, type `y` and press Enter.
    *   **Wait** for 2-3 minutes. Do not press Ctrl-C.

6.  **Get Backend URL**:
    *   When finished, you will see a green checkmark and a URL:
        `Service URL: https://translator-backend-xxxxx.asia-northeast3.run.app`
    *   **Copy this URL**.

7.  **Update Frontend**:
    *   Open `index3.html` in your editor.
    *   Replace `const BACKEND_URL = 'http://localhost:8080';` with your new **Service URL**.

---

## Alternative: Local CLI Deployment (Advanced)

If you have `gcloud CLI` installed on your machine:
1.  Open terminal in `backend` folder.
2.  Run: `gcloud run deploy translator-backend --source . --region asia-northeast3 --allow-unauthenticated`


---

## Step 3: Frontend Hosting

1.  **Install Firebase Tools**:
    ```powershell
    npm install -g firebase-tools
    ```

2.  **Initialize Hosting**:
    ```powershell
    firebase login
    firebase init hosting
    ```
    *   Select your project.
    *   Public directory: `.` (Current directory) or move HTML/JS to a `public` folder if you prefer.
    *   Configure as single-page app? **No** (since it's `index3.html`).

3.  **Deploy Frontend**:
    ```powershell
    firebase deploy --only hosting
    ```

---

## Step 4: License Management (Monetization)

The backend code currently includes a `checkLicense` function. To manage 100,000+ users:

1.  **Stripe/Toss Integration**:
    *   When a user pays, your payment webhook should write to Firestore:
        ```javascript
        // Example Firestore update
        await db.collection('users').doc(userId).set({
            subscriptionStatus: 'active',
            credits: 1000 // or unlimited
        }, { merge: true });
        ```

2.  **Quota Management**:
    *   The backend currently checks for `subscriptionStatus === 'active'` or `credits > 0`.
    *   You can expand this logic in `backend/index.js` to deduct credits per character translated.

---

## Development vs Production

*   **Local Testing**:
    *   Run backend: `cd backend` -> `npm install` -> `npm run dev`.
    *   You may need to download a service account key for local Firebase Admin access and set `GOOGLE_APPLICATION_CREDENTIALS`.
*   **Production**: Cloud Run uses the default service account, so no key file is needed if permissions are correct.
