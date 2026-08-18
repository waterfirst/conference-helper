# Conference Copilot 배포 가이드

프런트엔드는 GitHub Pages, 백엔드는 Google Cloud Run에 배포하는 기준입니다. OpenAI API 키와 Toss 비밀키는 프런트엔드 또는 Git 저장소에 넣지 않습니다.

## 1. 사전 준비

- Node.js 20 이상
- Google Cloud 프로젝트
- Firebase Authentication: Google 로그인 활성화
- Firestore 데이터베이스: 기존 환경은 데이터베이스 ID user
- OpenAI API 키
- 선택: Google Cloud Translation API, Toss Payments

## 2. Secret Manager

~~~bash
gcloud services enable run.googleapis.com secretmanager.googleapis.com firestore.googleapis.com

printf '%s' 'YOUR_OPENAI_API_KEY' | \
  gcloud secrets create conference-openai-key --data-file=-

printf '%s' 'YOUR_TOSS_SECRET_KEY' | \
  gcloud secrets create conference-toss-key --data-file=-
~~~

이미 secret이 있으면 새 버전을 추가합니다.

~~~bash
printf '%s' 'NEW_VALUE' | \
  gcloud secrets versions add conference-openai-key --data-file=-
~~~

Cloud Run 실행 서비스 계정에 Secret Manager Secret Accessor와 Firestore 접근 권한을 부여합니다.

## 3. Cloud Run 백엔드

~~~bash
cd backend
npm ci
npm test

gcloud run deploy conference-copilot-api \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --set-env-vars PROJECT_ID=YOUR_PROJECT_ID,FIRESTORE_DATABASE_ID=user,ALLOWED_ORIGINS=https://waterfirst.github.io,ADMIN_EMAILS=YOUR_ADMIN_EMAIL \
  --set-secrets OPENAI_API_KEY=conference-openai-key:latest,TOSS_SECRET_KEY=conference-toss-key:latest
~~~

--allow-unauthenticated는 브라우저가 API 엔드포인트에 도달하도록 허용하는 설정입니다. 실제 AI 기능은 서버가 Firebase ID 토큰을 다시 검증하므로 로그인 없이 사용할 수 없습니다.

배포 후 확인합니다.

~~~bash
curl https://YOUR_CLOUD_RUN_URL/health
~~~

정상 응답에는 status: "ok"와 openaiConfigured: true가 포함됩니다.

## 4. Firebase

Firebase Console에서 다음을 확인합니다.

1. Authentication → Sign-in method → Google 활성화
2. Authentication → Settings → Authorized domains에 아래 도메인 추가
   - waterfirst.github.io
   - 로컬 개발 시 localhost
3. Cloud Run 서비스 계정이 Firebase Authentication 토큰을 검증할 수 있는지 확인
4. Firestore users, transactions 컬렉션 생성 권한 확인

관리자 계정은 소스 코드가 아니라 Cloud Run의 ADMIN_EMAILS 환경 변수로 관리합니다.

## 5. GitHub Pages

config.js의 backendUrl을 Cloud Run URL로 바꿉니다.

~~~javascript
backendUrl: 'https://YOUR_CLOUD_RUN_URL'
~~~

Repository → Settings → Pages에서 배포 브랜치와 루트를 선택합니다. 예상 URL은 다음과 같습니다.

~~~text
https://waterfirst.github.io/conference-helper/
~~~

새 버전 배포 후 이전 UI가 보이면 브라우저에서 한 번 새로고침합니다. 서비스워커 v3는 이후 HTML·JavaScript·CSS를 네트워크 우선으로 갱신합니다.

## 6. 환경별 CORS

ALLOWED_ORIGINS에는 경로 없이 Origin만 쉼표로 구분해 입력합니다.

~~~dotenv
ALLOWED_ORIGINS=https://waterfirst.github.io,https://conference.example.com
~~~

와일드카드 *는 인증 API의 운영 설정에 사용하지 않습니다.

## 7. 운영 점검

- /health 응답과 Cloud Run 오류율
- Realtime 세션 발급 실패율
- 첫 번역 음성 지연과 자막 지연
- 언어쌍별 인명·숫자·전문용어 정확도
- 브라우저별 마이크/탭 공유 권한 흐름
- 회의록의 결정사항·담당자·기한 환각 여부
- Firebase trial/license 상태
- 결제 승인 금액·주문 ID 일치 여부

## 8. 롤백

Cloud Run은 이전 revision으로 트래픽을 즉시 되돌릴 수 있습니다.

~~~bash
gcloud run revisions list --service conference-copilot-api --region asia-northeast3
gcloud run services update-traffic conference-copilot-api \
  --region asia-northeast3 \
  --to-revisions REVISION_NAME=100
~~~

GitHub Pages는 정상 커밋을 revert한 뒤 다시 배포합니다. 사용자 기록은 브라우저 로컬에 있으므로 프런트엔드 롤백으로 Firestore 데이터가 변경되지는 않습니다.
