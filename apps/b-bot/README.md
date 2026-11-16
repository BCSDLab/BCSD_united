# B-BOT · Cloudflare Worker

[BCSDLab/B_BOT](https://github.com/BCSDLab/B_BOT)의 Slack 봇을 이 모노레포에 통합한 앱이다. Nitro HTTP 라우트와 기존 도메인 로직을 유지하고 Workers·Queues·KV·Workers AI에서 실행한다. Slack HTTP는 Worker에, 기존 업무 API는 Java에 남는다.

원본에 있던 조직 지식 RAG(`!질문`, GitHub·Notion·Google Drive 문서 색인, 👍👎 피드백)는 포함하지 않는다. 봇 PostgreSQL의 `rag_*` 테이블과 마이그레이션은 적용 이력 보존을 위해 그대로 둔다.

배포 주소: <https://b-bot-workers.bcsdlab.workers.dev> · 상태 확인: [`GET /health`](https://b-bot-workers.bcsdlab.workers.dev/health).

## 구성

- `apps/b-bot`: Slack HTTP 수신, 큐 소비, Google OAuth/Meet, 검토 페이지, 정적 PDF, 예약 작업.
- `packages/b-bot-ai`: Workers AI 호출, 구조화 출력·이미지 입력 검증.
- `packages/b-bot-database`: 호출 단위 PostgreSQL 연결과 기존 데이터베이스 도구.

`worker.ts`와 Nitro 라우트는 같은 AI·DB 호출 컨텍스트를 공유해야 한다. Nitro 빌드는 두 공용 패키지를 외부 import로 남기고, Wrangler가 최종 Worker 번들에서 한 번만 묶는다. Nitro 결과만 직접 배포하지 않으며 `wrangler deploy --dry-run`까지 확인한다.

현재 배포 설정은 **운영 DB 미연결, 자동 Cron 비활성**이다. 기존 Slack 엔드포인트와 운영 도메인은 자동으로 바꾸지 않는다. D1 데이터·쿼리 이전은 포함하지 않는다. PostgreSQL 전용 SQL, 트랜잭션, pgvector 검색을 D1 설정만으로 대체할 수 없다.

## 개발

Node와 pnpm 버전은 모노레포 루트의 `.nvmrc`, `package.json`을 따른다. 명령은 별도 표시가 없으면 루트에서 실행한다.

```sh
corepack pnpm install
cp apps/b-bot/.dev.vars.example apps/b-bot/.dev.vars
pnpm dev:b-bot
```

로컬 주소는 `http://localhost:8793`이다. 일반 개발 실행도 AI 바인딩은 원격 Cloudflare 계정을 사용하므로 실제 추론 비용이 생길 수 있다. AI를 호출하지 않는 로컬 HTTP 검증은 `pnpm --filter @koin/b-bot exec wrangler dev --local --port 8793`으로 실행한다.

```sh
pnpm --filter '@koin/b-bot...' --if-present typecheck
pnpm --filter '@koin/b-bot...' --if-present test
pnpm --filter @koin/b-bot build
```

`GET /health`는 DB나 외부 API를 호출하지 않고 Worker의 HTTP 실행 상태만 확인한다. 모든 외부 연동이 준비됐다는 의미는 아니다.

## 환경값과 보안

전체 키는 [`.dev.vars.example`](./.dev.vars.example)에 있다. 실제 `.dev.vars`, `.secret`, 빌드 결과와 로컬 저장소는 커밋하지 않는다. 운영 자격 증명은 Cloudflare Secrets에 저장한다.

```sh
pnpm --filter @koin/b-bot exec wrangler secret put SLACK_BOT_TOKEN
pnpm --filter @koin/b-bot exec wrangler secret put SLACK_BOT_SIGNING_SECRET
pnpm --filter @koin/b-bot exec wrangler secret put WEBHOOK_SECRET
```

- Slack 요청은 본문 원문에 대한 HMAC 서명과 5분 유효 시간을 검증한다. 서명 키가 없으면 거부한다.
- `/api/*` 알림 웹훅은 `Authorization: Bearer <WEBHOOK_SECRET>`가 필요하다. 키가 없거나 틀리면 Slack API를 호출하기 전에 거부한다.
- Slack 첨부 파일은 리디렉션마다 HTTPS Slack 호스트를 확인한 뒤 봇 인증 헤더를 전달한다. Slack 외부 주소로의 리디렉션은 거부한다.
- `SLACK_APP_TOKEN`, `SLACK_BOT_CLIENT_SECRET`는 현재 HTTP 수신 방식에 사용하지 않는다.
- `APP_BASE_URL`은 이 Worker의 공개 주소이며 끝에 `/`를 붙인다. 검토 링크와 회칙 PDF 링크에 사용한다.
- 서버 파일 경로인 `TOKEN_PATH`, `CREDENTIALS_PATH`, `GOOGLE_APPLICATION_CREDENTIALS`는 사용하지 않는다.
- 로그·응답·LLM 프롬프트에 토큰과 비밀번호를 넣지 않는다.

## AI와 한도

구조화 출력·생협 이미지 해석·Superset 자연어 처리는 **`openai/gpt-6-luna`**를 사용한다.

- Worker에서는 네이티브 `AI` 바인딩을 사용한다. Node CLI 도구는 `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`으로 같은 Cloudflare 모델의 REST API를 호출한다.
- Luna는 [서드파티 토큰 과금 모델](https://developers.cloudflare.com/ai/models/openai/gpt-6-luna/)이다. [Cloudflare-hosted 모델의 일일 무료 10,000 Neurons](https://developers.cloudflare.com/workers-ai/platform/pricing/)와 같은 한도로 취급하지 않는다.
- 계정 크레딧·사용 한도·권한 오류가 나면 중단한다. 다른 OpenAI·Anthropic·Ollama 모델로 전환하거나 자동 재시도하지 않는다. 애플리케이션이 별도 무료 한도를 계산하지 않는다.
- AI Gateway의 `2021: Insufficient AI Gateway credits`는 크레딧 부족이다. 계정의 실제 결제·크레딧 설정이 있어야 Luna 생성이 가능하다. 예산 알림만으로 강제 사용 상한이 생긴다고 가정하지 않는다.
- `store: false`, `reasoning.effort: none`을 사용한다. 출력 토큰 예산을 숨은 추론 토큰이 소비하지 않게 한다.
- 거절·불완전 응답·잘린 JSON을 정상 결과로 사용하지 않는다.

선택한 이미지, Superset 질문과 조회 결과는 Cloudflare와 모델 제공자 OpenAI에 전달될 수 있다. 외부 전송과 Slack 공유가 승인된 자료만 사용한다.

## Slack 연동

새 Worker를 실제 앱에 연결할 때 Slack 설정에서 URL을 변경한다.

- Event Subscriptions: `<Worker 주소>/event`
- Slash Commands: `<Worker 주소>/slash`
- Interactivity: `<Worker 주소>/interaction`

일반 메시지·상호작용은 서명 검증 후 `SLACK_JOBS`에 저장하고 응답한다. 전송이 실패하면 성공으로 응답하지 않는다. 본문에는 Slack 검증 토큰, 응답 웹훅 URL, 모달 트리거 ID를 저장하지 않는다. 모달을 여는 명령·바로가기는 Slack의 3초 제한 때문에 HTTP 요청 안에서 처리한다.

큐는 at-least-once 전달이다. 반영·생성 기능의 기존 DB 상태 전이와 선점 규칙을 유지한다. 도메인 처리 실패는 사용자에게 알리고 무조건 외부 변경을 재실행하지 않는다. 예상하지 못한 큐 실패는 재시도 후 dead-letter 큐에 남긴다.

### 멘션 코드 수정 요청

Slack 앱의 bot event에 `app_mention`과 `app_mentions:read` 권한을 등록한다. 허용 채널에서 `@삐봇 수정요청 게시글 사진이 표시되도록 고쳐줘`처럼 **멘션으로 시작하는 명시적 `수정요청` 명령**을 보낸다(`코드수정요청`, `fix-request`도 허용). 일반 멘션·질문은 PR을 만들지 않는다. 이 명령 자체가 코드 수정 및 develop 대상 PR 생성을 요청하므로 별도 확인 버튼은 없으며 merge·운영 배포는 허용하지 않는다.

`/event`는 검증한 Slack 원문·서명을 `ERROR_AUTOMATION` 서비스 바인딩(`bcsd-error-automation`)의 `/slack/requests`로 그대로 전달한다. 수신 Worker가 원본 HMAC·5분 freshness·workspace·bot ID·사용자/채널 허용 목록을 재검증하고 `AutofixQueue`에 durable 접수한다. 인증·입력 거절과 `503` + `x-slack-autofix-error: not-configured`의 명시적 설정 거절은 재전송 없이 종결한다. 표식 없는 큐·저장소 `503` 및 전송 실패는 Slack 재시도가 가능하도록 실패 응답하며, Slack event ID로 중복 PR을 막는다. 별도 repository_dispatch나 실행기를 만들지 않는다.

운영자는 error-automation에 **동일 Slack 앱**의 `SLACK_BOT_SIGNING_SECRET`과 `SLACK_AUTOFIX_TEAM_ID`, `SLACK_AUTOFIX_BOT_USER_ID`, `SLACK_AUTOFIX_ALLOWED_USERS`, `SLACK_AUTOFIX_ALLOWED_CHANNELS`를 설정해야 한다. 마지막 두 값은 명시적 Slack ID의 쉼표 구분 목록이며 빈 값은 요청을 거절한다. 저장소·브랜치·모델·시크릿은 요청 텍스트에서 지정할 수 없다. 모델은 요청을 비신뢰 자료로만 읽고 보호 파일을 제외한 허용 앱/패키지의 소스·테스트를 수정하며 독립 검증을 통과한 변경만 develop PR로 발행한다. 자세한 계약은 [오류 자동화](../error-automation/README.md)를 따른다.

## Google Meet

Worker의 Google OAuth/Meet는 기존대로 유지한다. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_AUTH_SECRET`를 설정한다. 콜백은 `<Worker 주소>/auth/google_callback`이며 Google Cloud Console의 허용 리디렉션 URI에도 등록해야 한다. 운영에서는 HTTPS가 필요하다.

1. `/auth/google`에 접속해 Basic 인증을 한다. 사용자 이름은 `admin`, 비밀번호는 `GOOGLE_AUTH_SECRET`이다.
2. Google에서 Meet 생성 권한에 동의한다.
3. 서명된 10분 상태, HttpOnly/SameSite 쿠키, PKCE를 검증하고 refresh token을 Worker의 `BOT_KV`에 저장한다.

Meet 생성·종료는 Worker의 REST API를 사용한다. 기존 서버의 토큰 파일이나 파일 기반 KV는 자동 이관하지 않는다.

## DB와 예약 작업

기존 DB 연결 지원 순서는 `HYPERDRIVE.connectionString` → `DATABASE_URL` → `DB_*`이다. 연결 풀은 HTTP·큐·예약 호출마다 분리하고 해당 호출의 모든 작업이 끝난 뒤 닫는다. `127.0.0.1`은 배포된 Worker에서 기존 서버의 DB를 가리키지 않는다.

새 PostgreSQL에 스키마를 준비할 때만 다음을 사용한다. pgvector 확장 생성 권한이 필요하다.

```sh
pnpm --filter @koin/b-bot-database migrate
```

마이그레이션은 SQL 파일 체크섬과 적용 이력을 기록하고 트랜잭션으로 실행한다. 기존 추적 정보가 없는 운영 스키마에 자동으로 덮어쓰지 않는다. MySQL 데이터 교체는 별도의 `import:mysql --confirm-destructive` 명령이며 테이블을 비우므로 신규 스키마 생성 명령과 혼동하지 않는다.

`wrangler.jsonc`의 Cron은 초기 배포에서 비워둔다. DB와 필요한 외부 연동을 준비하고 운영 연결을 별도 승인받은 뒤에만 다음 스케줄을 활성화한다. `nitro.config.ts`의 작업 이름·Cron 표현식과 함께 맞춘다.

- 매분: `dining:deliver`. 환경별 최대 5건을 처리하고 종료한다. `DINING_WORKER_ENVS`는 명시적 opt-in이며 로컬에서는 비운다.
- 5분마다: `bus:versionUpdate`.

KOIN 운영 API 주소·서비스 토큰을 설정하기 전에는 운영 반영과 식단 전송을 활성화하지 않는다.

## Superset

`!대시보드`는 질문과 생성 계획을 분류한다. 조회는 허용 데이터셋 하나에서 최대 100행이며 임의 SQL이나 데이터 변경을 실행하지 않는다. 생성은 최대 4개 차트의 계획을 먼저 보여주고 요청자만 15분 이내 승인·취소할 수 있다. 생성 대시보드는 비공개 초안이다.

`SUPERSET_BASE_URL`, `SUPERSET_USERNAME`, `SUPERSET_PASSWORD`, `SUPERSET_DATASET_IDS`, DB 연결과 Luna 접근 권한이 필요하다. 허용 목록이 비어 있으면 거부한다. 저장된 가상 데이터셋 SQL/Jinja는 Superset이 처리하며 봇이 해당 SQL을 수정하지 않는다. Slack 사용자의 개별 Superset 계정을 대리하지 않으므로 서비스 계정의 접근 범위를 최소화한다.

## 검증과 배포

DB 회귀 테스트는 `DB_HOST`와 `_test`로 끝나는 `DB_NAME`이 있어야 실행한다. Superset 통합 테스트는 별도의 `SUPERSET_TEST_DATABASE_URL`에 임시 스키마를 만든다. 운영 DB 주소로 테스트하지 않는다. 유료 모델 테스트는 `RUN_AI_LIVE_TESTS=1`과 두 Cloudflare REST 자격 증명이 모두 있을 때만 실행한다.

```sh
pnpm deploy:b-bot
```

[앱 전용 GitHub Actions](../../.github/workflows/deploy-b-bot.yml)는 이 앱과 공용 패키지만 검증한다. 실제 배포는 `develop`의 수동 실행으로 제한하며, 웹·API·오류 자동화의 자동 운영 배포와 달리 B-BOT을 자동 배포하지 않는다. 배포 자격 증명은 GitHub의 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`이며 봇 실행용 Secrets는 Cloudflare에 별도로 유지한다. GitHub Actions의 브랜치 제한이 원격에 반영됐는지는 별도로 확인한다.

원본 기능 계획은 [계획서](./docs/계획서.md)와 [기능명세서](./docs/기능명세서.md)에 보존한다. 해당 문서의 서버·모델 운영 방식과 구현 예정 항목은 현재 런타임의 완료 상태를 뜻하지 않으며, 실행·배포 설정은 이 README와 코드가 기준이다.
