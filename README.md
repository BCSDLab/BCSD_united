# BCSD United

KOIN 웹앱과 관련 Worker를 함께 관리하는 Cloudflare 기반 모노레포입니다.

## 구성

```text
apps/
  web/                 TanStack Start 프론트엔드·SSR Worker
  api/                 Hono 업무 API Worker (레거시, 기본 비활성)
  b-bot/               Slack 봇 Worker
  attendance/          출근부: 카드 태그 기록 Worker·대시보드, 라즈베리파이 리더
  error-automation/    오류 웹훅 수신과 자동 수정 작업 시작
packages/
  telemetry/           공통 민감정보 마스킹
  b-bot-ai/            봇 모델 호출과 응답 검증
  b-bot-database/      봇 PostgreSQL 연결·이관 도구
scripts/
  autofix/             자동 수정 검증과 PR 발행
```

- 프론트엔드: React 19, TanStack Start/Router, React Query, Zustand, SCSS Modules
- 업무 API: 기존 Java 서버(KOIN_API_V2)를 사용합니다. `apps/api`는 레거시로 보존합니다.
- 도구: pnpm workspace, oxlint, oxfmt, TypeScript, ESLint·Stylelint(웹)

## 개발 환경

Node.js `24.22.1`(`.nvmrc`), pnpm `12.16.1`(`packageManager`)을 사용합니다.

```sh
corepack pnpm install --frozen-lockfile
pnpm dev
```

| 명령             | 대상 | 주소                    |
| ---------------- | ---- | ----------------------- |
| `pnpm dev:web`   | 웹   | `http://localhost:3000` |
| `pnpm dev:api`   | API  | `http://localhost:8787` |
| `pnpm dev:b-bot` | 봇   | `http://localhost:8793` |

레거시 API를 로컬에서 실행하려면 `pnpm --filter @koin/api dev --var API_ENABLED:true`를 사용합니다.

### 로컬 설정

| 위치                    | 용도                                      |
| ----------------------- | ----------------------------------------- |
| `apps/web/.env.local`   | 공개 API 주소, Sentry DSN, 지도/분석 설정 |
| `apps/api/.dev.vars`    | JWT/CSRF 서명 키, 허용 Origin, 외부 연동  |
| `apps/b-bot/.dev.vars`  | Slack·Google·외부 서비스 설정             |
| 자동화 앱의 `.dev.vars` | 웹훅 인증, GitHub 권한                    |

`NEXT_PUBLIC_*` 값은 브라우저에 노출되므로 비밀 키를 넣지 않습니다. `.env*`, `.dev.vars*`, PEM, 데이터 스냅샷은 커밋하지 않습니다.

## 검증

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## 배포

`develop`에 병합하면 Cloudflare Workers Builds가 각 Worker를 운영 배포합니다. `preview` 브랜치는 선택적인 비운영 검증용입니다.

| Worker                  | Root directory          | 운영 배포     | `preview` 배포                       |
| ----------------------- | ----------------------- | ------------- | ------------------------------------ |
| `koin-web`              | `apps/web`              | `pnpm deploy` | `pnpm deploy:preview`                |
| `koin-api`              | `apps/api`              | `pnpm deploy` | `pnpm deploy:preview --name preview` |
| `bcsd-error-automation` | `apps/error-automation` | `pnpm deploy` | 검사만 실행                          |

웹은 `KOIN_API_ORIGIN`으로 Java API를 호출합니다. 운영은 `https://api.koreatech.in`, Preview와 로컬은 `https://api.stage.koreatech.in`입니다. stage API가 발급하는 `__Secure-koin-stage-web-*` 쿠키 이름 같은 stage 전용 값은 빌드 상수 `NEXT_PUBLIC_KOIN_ENVIRONMENT`로 고릅니다. Workers Builds의 `KOIN_PREVIEW_BRANCH` 빌드와 로컬 개발 서버는 `preview`, 나머지 빌드는 `main`입니다.

stage는 검색 색인에서 뺍니다. `KOIN_ENVIRONMENT`가 `main`이 아닌 Worker는 SSR 응답에, stage 빌드는 `_headers`로 정적 자산에 `X-Robots-Tag: noindex, nofollow`를 붙입니다. 크롤러가 이 헤더를 읽어야 기존 색인이 지워지므로 stage `robots.txt`는 크롤링을 허용하고 sitemap은 만들지 않습니다. 봇은 [별도 안내](apps/b-bot/README.md)를 따릅니다.

익명 SSR 페이지의 공개 캐시 정책은 nginx 공유 캐시에 적용됩니다. 공유 캐시된 HTML의 렌더 시각은 오래될 수 있으며, 브라우저 화면 이동은 캐시되지 않은 세션 응답의 서버 시각으로 기준을 맞춥니다.

### 레거시 Worker API 비활성화와 복원

`koin-api` Worker는 `apps/api/wrangler.jsonc`의 `API_ENABLED`가 `"false"`라 모든 요청에 `503 API_DISABLED`로 응답합니다. 코드와 D1·R2·Queue·DO 리소스는 삭제하지 않습니다.

- 비활성 배포 전후: `wrangler queues pause-delivery koin-api-jobs`
- 복원: `API_ENABLED`를 `"true"`로 바꿔 배포한 뒤 `wrangler queues resume-delivery koin-api-jobs`

## 오류 추적

- Worker/API/SSR 오류: Cloudflare Issues
- 브라우저 오류·세션 리플레이: Sentry (`koin-united-prod`, `koin-united-preview`)
- 자동 수정: [apps/error-automation](apps/error-automation/README.md)

기여 방법은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.
