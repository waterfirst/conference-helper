# Conference Copilot

국제 학회·기술 회의·발표를 위한 실시간 동시통역 웹앱입니다. 브라우저에서 음성을 WebRTC로 전송해 번역 음성과 원문/번역 자막을 동시에 받고, 누적된 기록을 구조화된 회의록 또는 발표 요약으로 변환합니다.

## 주요 기능

| 영역 | 기능 |
|---|---|
| 실시간 통역 | gpt-realtime-translate 기반 스트리밍 음성→음성 통역 |
| 원문 전사 | gpt-realtime-whisper 원문 자막 동시 생성 |
| 입력 | 마이크 또는 브라우저 탭 오디오 |
| 호환 모드 | Realtime 연결 실패 시 브라우저 STT + 문맥 기반 AI 번역 |
| 회의록 | 핵심 요약, 결정사항, 액션 아이템, 담당자·일정, 미해결 질문 |
| 발표 요약 | 발표 흐름, 핵심 주장, 근거·결과·한계, 질문 정리 |
| 기록 관리 | 브라우저 자동 저장, 세션 복원, Markdown 내보내기 |
| PWA | 모바일 설치, 네트워크 우선 캐시, 오프라인 앱 셸 |

## 아키텍처

~~~mermaid
flowchart LR
    A["마이크 / 탭 음원"] --> B["Browser WebRTC"]
    B --> C["Realtime Translation"]
    C --> D["번역 음성 + 자막"]
    C --> E["원문 + 번역 기록"]
    E --> F["Responses API"]
    F --> G["회의록 / 발표 요약"]
~~~

- 표준 OpenAI API 키는 백엔드에만 저장합니다.
- 브라우저는 백엔드에서 발급한 짧은 수명의 Realtime 클라이언트 비밀키만 사용합니다.
- 전사·번역 기록은 기본적으로 브라우저 localStorage에만 저장됩니다.
- Realtime이 불가능한 브라우저에서는 Web Speech API와 서버 번역 경로를 사용합니다.

## 기술 스택

- Frontend: HTML5, CSS, JavaScript ES Modules, WebRTC, MediaDevices, Firebase Auth, PWA
- Backend: Node.js 20, Express, Firebase Admin, Firestore, OpenAI Realtime/Responses API
- Fallback: Google Cloud Translation v3
- Deployment: GitHub Pages + Google Cloud Run

## 빠른 시작

### 1. 백엔드

~~~bash
cd backend
cp .env.example .env
npm ci
npm start
~~~

backend/.env에서 최소한 다음 값을 설정합니다.

~~~dotenv
OPENAI_API_KEY=sk-...
PROJECT_ID=your-google-cloud-project
FIRESTORE_DATABASE_ID=user
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
ALLOWED_ORIGINS=http://127.0.0.1:5500
~~~

service-account.json과 .env는 Git에서 제외됩니다.

### 2. 프런트엔드

config.js의 backendUrl과 Firebase 공개 웹 설정을 배포 환경에 맞게 수정합니다.

~~~bash
python3 -m http.server 5500
~~~

브라우저에서 http://127.0.0.1:5500을 열고 Firebase Authentication의 승인된 도메인에 127.0.0.1 또는 localhost를 추가합니다.

### 3. 테스트

~~~bash
cd backend
npm test
node --check index.js
node --check ../app.js
~~~

## 사용 방법

1. Google 계정으로 로그인합니다.
2. 회의 또는 발표 모드와 입출력 언어를 선택합니다.
3. 마이크 또는 브라우저 탭 음원을 선택합니다.
4. 기술 약어·인명·제품명은 전문용어 사전에 입력합니다.
5. **동시통역 시작**을 누릅니다.
6. 세션 종료 후 **AI 회의록 생성** 또는 **AI 발표 요약**을 실행합니다.
7. 전체 기록과 요약을 Markdown으로 저장합니다.

## 품질 운영 권장사항

- 발표자별 오디오 트랙을 분리할 수 있으면 분리합니다.
- 사람 이름, 숫자, 날짜, 단위, 약어가 포함된 실제 음성으로 사전 평가 세트를 만듭니다.
- 통역 품질과 지연 시간을 별도 지표로 측정합니다.
- 브라우저 탭 입력에서는 반드시 **탭 오디오 공유**를 선택합니다.
- 동일 언어가 입력될 때 번역 음성이 나오지 않을 수 있으므로 원음 청취 경로를 유지합니다.

## 보안 개선

- 인증 우회 토큰과 코드 내 관리자 이메일 제거
- Toss Payments 서버 비밀키 기본값 제거
- 결제 확인 요청에 Firebase 인증과 금액·주문 일치 검증 추가
- 허용 도메인 기반 CORS, 요청 크기 제한, 사용자별 속도 제한 적용
- 음성 전사 텍스트를 innerHTML로 삽입하지 않아 XSS 차단
- 오래된 배포 ZIP 제거 및 서비스워커 캐시 갱신
- API 오류 세부정보가 사용자에게 직접 노출되지 않도록 표준화

## 환경 변수

전체 목록은 [backend/.env.example](backend/.env.example)을 참고하세요.

| 변수 | 기본값 | 설명 |
|---|---|---|
| OPENAI_API_KEY | 없음 | Realtime 및 Responses API 키 |
| REALTIME_TRANSLATION_MODEL | gpt-realtime-translate | 실시간 통역 모델 |
| REALTIME_TRANSCRIPTION_MODEL | gpt-realtime-whisper | 원문 전사 모델 |
| TEXT_TRANSLATION_MODEL | gpt-5.6-luna | 호환 모드 번역 모델 |
| SUMMARY_MODEL | gpt-5.6-terra | 회의록·발표 요약 모델 |
| FIRESTORE_DATABASE_ID | user | Firestore 데이터베이스 ID |
| ADMIN_EMAILS | 없음 | 쉼표로 구분한 관리자 이메일 |
| ALLOWED_ORIGINS | GitHub Pages·로컬 | 허용 웹 Origin 목록 |
| TOSS_SECRET_KEY | 없음 | 결제 확인용 서버 비밀키 |

## 공식 기술 문서

- [OpenAI Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation)
- [OpenAI transcription](https://developers.openai.com/api/docs/guides/transcription)
- [OpenAI Responses API text generation](https://developers.openai.com/api/docs/guides/text)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

상세 배포 절차는 [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)를 참고하세요.

## License

MIT
