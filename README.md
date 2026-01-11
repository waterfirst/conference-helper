# 🎓 Conference Helper (학회 도우미)

**Real-time Speech Recognition & Translation for International Conferences**

국제 학회에서 실시간 음성 인식과 번역을 제공하는 웹앱입니다.

## 🌐 Live Demo

**[👉 https://waterfirst.github.io/International-conference-helper/](https://waterfirst.github.io/International-conference-helper/)**

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎤 **Speech Recognition** | Real-time speech-to-text in multiple languages |
| 🌍 **Translation** | Automatic translation to your preferred language |
| 📺 **Live Subtitles** | Display subtitles over camera view |
| 📷 **Camera Support** | Front/back camera with toggle option |
| 💾 **Save Records** | Export translation log as text file |
| 📱 **PWA Support** | Install as app on mobile devices |

## 🗣️ Supported Languages

### Recognition Languages
- 🇺🇸 English
- 🇰🇷 한국어 (Korean)
- 🇯🇵 日本語 (Japanese)
- 🇨🇳 中文 (Chinese)
- 🇩🇪 Deutsch (German)
- 🇫🇷 Français (French)
- 🇪🇸 Español (Spanish)

### Translation Languages
- All of the above

## 📱 How to Use

### On Mobile (Recommended)

1. Open the link in **Chrome** or **Edge** browser
2. Tap **"Add to Home Screen"** for app-like experience
3. Select recognition language (speaker's language)
4. Select translation language (your language)
5. Toggle camera on/off as needed
6. Tap **Start** and point at the speaker
7. See real-time subtitles and translations!

### On Desktop

1. Open the link in Chrome or Edge
2. Allow microphone (and camera if needed) permissions
3. Configure languages and start

## 🎯 Use Cases

- **International Conferences**: Understand presentations in foreign languages
- **Academic Seminars**: Follow along with translated subtitles
- **Business Meetings**: Real-time translation for multilingual teams
- **Language Learning**: Practice listening with subtitle support

## ⚙️ Technical Architecture (SaaS Upgrade)

This project has been upgraded from a client-side only app to a secure **SaaS (Software-as-a-Service)** architecture.

*   **Frontend**: Plain HTML/JS + Firebase Auth (Google Login)
*   **Backend**: Node.js + Express on Google Cloud Run
*   **Database**: Firestore (User License & Quota Management)
*   **Translation**: Server-side Google Cloud Translation API (Secure Key Handling)

## 🚀 Deployment Guide (SaaS Version)

This guide explains how to deploy your own secure backend using **Google Cloud Shell** (No local installation required).

### Prerequisites
1.  Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2.  Create a project in [Firebase Console](https://console.firebase.google.com/) and link it to your Google Cloud project.
3.  Enable **Cloud Translation API** in Google Cloud Console.

### Step-by-Step Deployment

**1. Prepare & Upload Code**
*   Compress your local `backend` folder into a zip file named **`backend.zip`**.
*   Open the [Google Cloud Console](https://console.cloud.google.com/).
*   Click the **Activate Cloud Shell** icon (`>_`) in the top right.
*   Click the **More** button (⋮) in the Cloud Shell terminal -> **Upload** -> Select `backend.zip`.

**2. Deploy via Cloud Shell**
Copy and paste the following commands into the Cloud Shell terminal (**one by one**):

```bash
# 1. Clean up and setup directory
cd ~ && rm -rf backend && mkdir backend && cd backend

# 2. Unzip the code (if you uploaded zip) OR Create files directly (Recommended)
# Method A: If you uploaded backend.zip
unzip ../backend.zip -d .

# Method B: Direct Creation (Fail-safe method)
# (Copy the package.json and index.js creation commands provided in the full tutorial)
```

**3. Run the Deploy Command**
```bash
# Deploys to Seoul region (asia-northeast3)
gcloud run deploy translator-backend --source . --region asia-northeast3 --allow-unauthenticated
```
*   Wait about 2-3 minutes.
*   Copy the resulting **Service URL** (e.g., `https://translator-backend-xyz.run.app`).

**4. Connect Frontend**
*   Open `index3.html`.
*   Update `const BACKEND_URL` with your new Service URL.
*   Update `firebaseConfig` with your Firebase project keys.

## � Security & Privacy

*   **Authentication**: Users must log in with Google to access translation.
*   **License Check**: The backend verifies if the user has a valid license/quota in Firestore before translating.
*   **Data Protection**: API Keys are hidden on the server and never exposed to the client.

## 📄 License

MIT License

---

**Made with ❤️ for the global academic community**
