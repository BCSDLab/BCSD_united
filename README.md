# BCSD United

KOIN의 웹앱과 업무 API를 함께 관리하는 Cloudflare 기반 모노레포입니다.

> 현재 전환 작업과 통합 검증이 진행 중입니다. 소스가 있다는 이유만으로 운영 이관이 완료된 것은 아닙니다. 운영 DB의 데이터를 아직 가져오지 않았으며, 운영 도메인도 전환하지 않았습니다.

## 구성

```text
apps/
  web/                 TanStack Start 프론트엔드·SSR Worker
  api/                 Hono 업무 API Worker
  b-bot/               Slack 봇 HTTP·Queues·Workers AI Worker
  error-automation/    오류 웹훅 수신과 자동 수정 작업 시작
packages/
  telemetry/           공통 민감정보 마스킹
  b-bot-ai/            GPT-6 Luna·BGE-M3 호출과 응답 검증
  b-bot-database/      봇 PostgreSQL 연결·이관 도구(D1 이전 미포함)
scripts/
  autofix/             독립 검증과 GitHub 이슈·PR 발행
```

- 프론트엔드: React 19, TanStack Start/Router, React Query, Zustand, SCSS Modules.
- 백엔드: TypeScript, Hono, Drizzle ORM, Cloudflare D1.
- 파일: R2. 실시간 연결·일부 변경 요청의 직렬화: Durable Objects.
- 비동기 작업: Queues. 정기·복구 작업: 5분 간격 Cron.
- 도구: pnpm workspace, oxlint, oxfmt, TypeScript. 웹 전용 규칙에는 ESLint·Stylelint도 사용합니다.
- 각 앱은 별도 Worker로 배포합니다. 하나의 Worker에 웹·업무 API·자동화 권한을 합치지 않습니다.

## 개발 환경

Node.js 버전은 `.nvmrc`, pnpm 버전은 루트 `package.json`의 `packageManager`로 고정합니다.

```sh
corepack pnpm install
pnpm --filter @koin/api db:migrate:local
pnpm dev
```

앱을 따로 실행할 수도 있습니다.

```sh
pnpm dev:web
pnpm dev:api
pnpm dev:b-bot
```

웹 개발 서버는 `http://localhost:3000`, API의 Wrangler 개발 서버는 기본 `http://localhost:8787`, 봇은 `http://localhost:8793`을 사용합니다.

### 로컬 설정

| 위치                    | 용도                                                   |
| ----------------------- | ------------------------------------------------------ |
| `apps/web/.env.local`   | 공개 API 주소·브라우저 Sentry DSN·지도/분석 설정       |
| `apps/api/.dev.vars`    | JWT/CSRF 서명 키, 허용 Origin, 외부 연동 자격 증명     |
| `apps/b-bot/.dev.vars`  | Slack 서명·봇 토큰, 웹훅 인증, Google·외부 서비스 설정 |
| 자동화 앱의 `.dev.vars` | 웹훅 인증과 GitHub 작업 시작 권한                      |

웹의 `NEXT_PUBLIC_API_PATH`는 실행할 API 주소로 설정합니다. 기존 공개 환경 변수 이름은 유지하지만 Next.js 런타임을 사용하지 않습니다. `NEXT_PUBLIC_*` 값은 브라우저에 노출될 수 있으므로 비밀 키를 넣으면 안 됩니다.

API 로그인에는 `JWT_SECRET`, `WEB_CSRF_SECRET`, `AUTH_ALLOWED_ORIGINS`가 필요합니다. 네이티브 앱 토큰 발급에는 `NATIVE_ACCESS_TTL_SECONDS`도 필요합니다. 파일·문자·메일·결제·푸시 연동은 해당 공급자의 실제 설정이 있어야 동작하며, 누락된 설정을 가짜 성공 응답으로 대체하지 않습니다.

`.env*`, `.dev.vars*`, PEM, 데이터 스냅샷, `.claude`, `.vscode`는 공개 커밋 대상이 아닙니다. 운영 시크릿은 Wrangler secret 또는 GitHub Actions secret에 저장합니다.

봇은 [별도 운영 안내](apps/b-bot/README.md)를 따릅니다. `pnpm deploy:b-bot`으로 해당 Worker만 배포하며, 초기 설정에서는 운영 DB 연결·Cron·기존 Slack 엔드포인트 전환을 활성화하지 않습니다. Luna는 Cloudflare 계정 크레딧·한도에 따라 사용하고 다른 유료 모델로 자동 전환하지 않습니다.

### API 문서

API Worker의 `GET /docs`는 Swagger UI를, `GET /openapi.json`은 OpenAPI 3.0.3 계약을 제공합니다. 두 경로는 인증이나 DB 조회 없이 공개됩니다. 문서는 `apps/api/src/openapi/source-contract.json`에 보관된 운영 API 계약(2026-10-27)의 DTO와 464개 작업을 유지하고, Worker의 `/health`와 서명된 R2 파일 접근 작업을 추가합니다. 소스 운영 계약에 없는 테스트·개발용 작업을 임의로 공개 문서에 추가하지 않습니다.

서버 URL은 `/`이므로 **Try it out은 문서를 연 API Worker에 실제 요청**을 보냅니다. 운영 API 주소로 자동 전환하지 않습니다. `/health`는 Worker 응답 상태만 확인하며 DB·외부 연동 readiness 검사가 아닙니다. Swagger UI는 고정 버전 `5.32.0`의 CSS/JavaScript를 jsDelivr에서 로드하므로 브라우저의 해당 CDN 접근이 필요합니다. 외부 계약 validator 호출과 인증 정보 영속 저장은 비활성화합니다.

Bearer 인증은 **Authorize → Jwt Authentication**에 JWT 값만 입력합니다. 브라우저의 HttpOnly 웹 인증 쿠키는 Swagger 입력란에서 직접 설정할 수 없으며, 같은 API의 웹 로그인으로 발급받아야 합니다. 쿠키 인증 요청은 허용 Origin 설정이 필요하고, 상태를 바꾸는 요청에는 세션과 일치하는 `X-CSRF-Token`이 필요합니다. 문서에서 `WebCsrfToken` 인증 항목에 현재 CSRF 값을 입력할 수 있지만, Swagger UI가 쿠키를 읽어 CSRF 값을 자동 동기화하거나 만료된 세션을 갱신하지는 않습니다. Bearer와 쿠키를 동시에 보내면 일반 API 인증은 Bearer를 우선하며, `/v2/web/auth/*`는 별도의 웹 세션 규칙을 따릅니다.

R2 capability URL은 URL 자체가 만료 시각·메서드·파일에 묶인 접근 권한입니다. 외부에 공유하거나 로그에 남기지 않습니다. 업로드 본문은 원본 파일 바이트이며 서명된 `Content-Type`과 바이트 길이를 정확히 맞춰야 합니다. Swagger UI는 서명된 업로드 메타데이터를 자동 추론하지 않으므로 파일 업로드 클라이언트에서 해당 값을 지정합니다. capability 요청에도 웹 세션 쿠키가 함께 전송되면 공통 Origin/CSRF 검사가 적용됩니다.

## 검증

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`pnpm format`은 oxfmt로 코드를 정렬합니다. 위 명령은 검증 진입점이며, 현재 브랜치의 통과 여부는 실제 실행 결과와 CI를 확인해야 합니다.

`pnpm --filter @koin/api test`는 TypeScript API 회귀 테스트와 `scripts/*.test.mjs`의 D1 데이터·파일 이관 동작 테스트를 함께 실행합니다. 이관 도구만 확인하려면 다음 명령을 사용합니다.

```sh
node --test "apps/api/scripts/*.test.mjs"
```

API 회귀 테스트는 SQLite의 실제 제약조건·원자 배치와 HTTP 계약을 확인합니다. 테스트 통과만으로 운영 공급자나 실제 사용자 데이터 이관이 검증되는 것은 아닙니다.

## D1 데이터 이관

`apps/api/drizzle/`의 마이그레이션과 `apps/api/src/db/schema.ts`가 영속 스키마를 정의합니다. 기존 MySQL의 과거 주문·결제 테이블도 보존합니다. MongoDB 및 Redis에 있던 업무 데이터는 D1으로 이전하며, DO를 두 번째 업무 DB로 사용하지 않습니다.

- 웹 refresh 토큰의 해시, 세션·CSRF·만료 상태를 D1에 저장합니다.
- 기존 앱용 인증은 별도 세션 저장소로 기존 계약을 유지합니다.
- 만료 여부는 요청 시 검사합니다. 만료 행 삭제 Cron에 인증 유효성이 의존하지 않습니다.
- Drizzle의 파라미터화 SQL과 D1 원자 배치를 사용합니다. MySQL의 행 잠금이나 대화형 트랜잭션을 그대로 흉내 내지 않습니다.
- bigint·UUID·TTL·채팅 이력을 손실 없이 옮기도록 검사합니다.
- SQLite와 MySQL의 Unicode collation은 완전히 같지 않습니다. 제공된 정규화·충돌 검증을 통과시키고 실제 데이터의 차이를 확인해야 합니다.

이관 절차와 제한은 `apps/api/scripts/migration-contract.json` 및 같은 디렉터리의 실행 도구를 따릅니다. 실제 원본 접속 정보와 일관된 MySQL/MongoDB/Redis 스냅샷 없이 운영 이관을 실행하지 않습니다. 적용한 마이그레이션은 수정하지 않고 새 순번으로 변경합니다.

## 배포

### Workers Builds와 브랜치

GitHub 저장소는 [BCSDLab/BCSD_united](https://github.com/BCSDLab/BCSD_united)입니다. 작업 커밋은 `develop`, 통합 검증은 `preview`, 운영 배포는 `main`을 사용합니다. 검증한 동일 커밋을 `develop → preview → main` 순서로 승격하며, 브랜치마다 같은 변경을 다시 커밋하거나 cherry-pick하지 않습니다. 각 Worker(`koin-web`, `koin-api`, `bcsd-error-automation`)를 같은 저장소의 Cloudflare **Workers Builds**에 연결합니다. API를 `api-test`/`stage`/`prod`라는 별도 Worker로 나누지 않고, 각 Worker 안에서 production과 **native Preview**를 구분합니다.

Workers Builds의 Root directory는 각 앱 폴더로 설정합니다. pnpm은 상위 workspace의 lockfile과 공용 패키지를 사용하며, 아래 명령은 해당 앱 폴더에서 실행됩니다. 운영 배포는 `wrangler deploy`, 비운영 배포는 `wrangler preview`입니다. `wrangler versions upload`, `--env test`, `--env stage`, `env.preview`는 이 배포 모델이 아닙니다. 로컬 수동 배포를 평상시 작업 흐름으로 사용하거나 같은 앱을 배포하는 GitHub Actions를 추가하지 않습니다. 기존 B-BOT 배포는 별도 운영 범위입니다.

| Worker                  | Root directory          | 검증·빌드 명령                 | 운영 배포 명령 | `preview` 배포 명령                  |
| ----------------------- | ----------------------- | ------------------------------ | -------------- | ------------------------------------ |
| `koin-web`              | `apps/web`              | `pnpm typecheck && pnpm build` | `pnpm deploy`  | `pnpm deploy:preview`                |
| `koin-api`              | `apps/api`              | `pnpm typecheck && pnpm test`  | `pnpm deploy`  | `pnpm deploy:preview --name preview` |
| `bcsd-error-automation` | `apps/error-automation` | `pnpm typecheck && pnpm test`  | `pnpm deploy`  | `pnpm deploy:preview --name preview` |

Workers Builds의 production branch는 `main`입니다. 비운영 브랜치에서는 검사를 실행하지만, 배포 명령은 `if [ "$WORKERS_CI_BRANCH" = "preview" ]; then <위 표의 preview 배포 명령>; else printf "Checks only: no deployment for %s\n" "$WORKERS_CI_BRANCH"; fi`로 제한합니다. 따라서 `develop`이나 기능 브랜치가 고정 `preview` 환경을 덮어쓰지 않습니다. 웹의 비운영 빌드 명령은 `pnpm typecheck && if [ "$WORKERS_CI_BRANCH" = "preview" ]; then pnpm build; fi`입니다. 웹 번들 생성 자체도 `main`/`preview`만 허용합니다.

브랜치명을 바꾸면 `KOIN_MAIN_BRANCH`/`KOIN_PREVIEW_BRANCH`와 Workers Builds의 조건을 함께 바꿔야 합니다. 브랜치별 Preview를 추가하려면 이름·빌드 분기 정책과 대응 API Preview 주소·허용 Origin을 먼저 정해야 합니다. 저장소 Quality workflow와 앱별 검증 명령을 유지하며, GitHub 연결·푸시·빌드 시작을 배포 성공으로 취급하지 않습니다.

Cloudflare GitHub App의 저장소 접근 승인, Worker별 저장소 연결, production branch와 비운영 배포 조건, Preview 전용 시크릿 및 API/웹 Origin 설정은 실제 계정에 적용해야 합니다. 배포된 URL의 HTTP 응답까지 확인한 후 운영 브랜치로 승격합니다.

### Preview 리소스와 검증 범위

| 리소스          | Production       | Native Preview                          |
| --------------- | ---------------- | --------------------------------------- |
| D1              | `koin-api`       | `koin-api-test`                         |
| R2              | `koin-api-files` | `koin-api-files-test`                   |
| Queue producer  | `koin-api-jobs`  | `koin-api-jobs-test`                    |
| Durable Objects | 운영 namespace   | 각 Preview에 자동 생성되는 새 namespace |

Preview 설정은 각 Wrangler 파일의 `previews` 블록에 명시하며 운영 변수·시크릿을 자동 상속하지 않습니다. D1/R2/Queue는 같은 이름을 바인딩한 Preview끼리 데이터를 공유합니다. 기존 `-test` DO namespace를 재사용하지 않으며, Preview마다 자동 격리된 DO 저장소가 생성됩니다. 같은 Preview를 재배포하면 상태가 유지되고 Preview 삭제 시 해당 DO 상태도 삭제됩니다.

**Preview는 HTTP-only입니다. Queue producer만 테스트 큐에 연결하고 Queue consumer와 Cron Trigger를 두지 않습니다.** 따라서 HTTP 요청이나 작업 enqueue 성공은 알림 발송·예약 실행·정기 복구 성공을 뜻하지 않습니다. 이 동작은 Preview에서 검증하지 않습니다. 기존 `koin-api-test` Worker와 해당 테스트 큐 consumer 연결은 제거했으며, Preview가 사용하는 `-test` D1·R2·Queue는 유지합니다.

**Preview의 service binding은 대상 Worker의 production을 호출합니다.** 웹 Preview에 `koin-api` service binding을 사용하지 않습니다. 브라우저는 웹 Worker의 same-origin `/api` gateway를 호출하며, gateway와 SSR 모두 런타임 `KOIN_API_ORIGIN`의 API **Preview HTTP origin**(`https://preview-koin-api.bcsdlab.workers.dev`)으로 전달합니다. API에는 웹 Preview origin을 명시적으로 허용합니다. 빌드 시 공개 API 경로는 `/api`이고, API Preview가 준비되기 전 운영 API로 폴백하지 않습니다.

`workers.dev` Preview 주소는 `preview_urls: true`로 활성화합니다. 웹 Worker는 `global_fetch_strictly_public`을 사용해야 같은 계정의 API Preview를 HTTP로 호출할 수 있습니다. 이 플래그가 없으면 API 직접 요청은 성공해도 웹 gateway 호출은 Cloudflare `1042`로 실패합니다. 운영의 `KOIN_API` service binding을 Preview HTTP 호출로 대체하지 않습니다. 근거: [Preview URL 활성화](https://developers.cloudflare.com/workers/previews/custom-domains/#enable-workersdev-preview-urls), [공개 경로 fetch](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).

Production R2는 비공개이며 실제 공개 파일 도메인 또는 비공개 전달 정책을 정하기 전 임의 `R2_PUBLIC_URL`을 넣지 않습니다. 테스트 버킷의 공개 URL을 운영에 재사용하지 않습니다. 운영 도메인 전환, 실제 데이터 반입, 기존 시스템의 쓰기 중단은 별도 절차입니다. Worker 코드 롤백은 DB·객체 데이터 복구가 아닙니다.

Cloudflare 근거: [Preview 설정](https://developers.cloudflare.com/workers/previews/configuration/), [리소스 격리와 제한](https://developers.cloudflare.com/workers/previews/resources/). 자동화 Preview의 외부 쓰기 차단과 별도 자격 증명은 [자동화 운영 안내](apps/error-automation/README.md)를 따릅니다.

## 오류 추적과 자동 수정

관측 역할은 다음과 같이 나눕니다.

- Worker/API/SSR 오류: Cloudflare Issues.
- 브라우저 React/JavaScript 오류와 세션 리플레이: Sentry.
- 플랫폼 요청·CPU·바인딩 상태: Cloudflare Observability.

자동 수정은 인증된 오류 이벤트를 받아 중복 GitHub 이슈를 확인하고, 격리된 모델 실행으로 패치를 만든 뒤 독립 검증을 통과한 경우에만 PR을 생성하는 구조입니다. 서버와 브라우저 이벤트의 공통 연결 작업은 현재 통합 중입니다.

- 진단 메시지·스택은 명령이 아닌 비신뢰 데이터입니다.
- 모델에는 GitHub 쓰기 토큰을 제공하지 않습니다.
- Anthropic 키는 `ANTHROPIC_API_KEY` 시크릿으로만 전달합니다.
- 수정 파일 범위·크기·심볼릭 링크를 검증하고, 회귀 테스트와 앱별 실행 검증을 수행합니다.
- 별도 reviewer 자동화, 자동 머지, 모델의 운영 배포는 없습니다.
- 공급자 전송 후 응답이 유실되는 경우까지 exactly-once를 보장하지 않습니다. D1 상태·중복 방지·재처리 정책으로 관리합니다.

자동화의 실제 활성화에는 GitHub 권한, Cloudflare/Sentry 웹훅 설정, 프로젝트와 앱의 명시적 매핑이 필요합니다. API 키를 코드·이슈·PR 본문에 기록하지 않습니다.

기여 방법은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.
