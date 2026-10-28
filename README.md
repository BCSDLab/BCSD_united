# BCSD United

KOIN의 웹앱과 업무 API를 함께 관리하는 Cloudflare 기반 모노레포입니다.

> 현재 전환 작업과 통합 검증이 진행 중입니다. 소스가 있다는 이유만으로 운영 이관이 완료된 것은 아닙니다. 운영 DB의 데이터를 아직 가져오지 않았으며, 운영 도메인도 전환하지 않았습니다.

## 구성

```text
apps/
  web/                 TanStack Start 프론트엔드·SSR Worker
  api/                 Hono 업무 API Worker
  sentry-automation/   오류 웹훅 수신과 자동 수정 작업 시작
packages/
  telemetry/           공통 민감정보 마스킹
scripts/
  sentry/              독립 검증과 GitHub 이슈·PR 발행
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
```

웹 개발 서버는 `http://localhost:3000`, API의 Wrangler 개발 서버는 기본 `http://localhost:8787`을 사용합니다.

### 로컬 설정

| 위치 | 용도 |
| --- | --- |
| `apps/web/.env.local` | 공개 API 주소·브라우저 Sentry DSN·지도/분석 설정 |
| `apps/api/.dev.vars` | JWT/CSRF 서명 키, 허용 Origin, 외부 연동 자격 증명 |
| 자동화 앱의 `.dev.vars` | 웹훅 인증과 GitHub 작업 시작 권한 |

웹의 `NEXT_PUBLIC_API_PATH`는 실행할 API 주소로 설정합니다. 기존 공개 환경 변수 이름은 유지하지만 Next.js 런타임을 사용하지 않습니다. `NEXT_PUBLIC_*` 값은 브라우저에 노출될 수 있으므로 비밀 키를 넣으면 안 됩니다.

API 로그인에는 `JWT_SECRET`, `WEB_CSRF_SECRET`, `AUTH_ALLOWED_ORIGINS`가 필요합니다. 네이티브 앱 토큰 발급에는 `NATIVE_ACCESS_TTL_SECONDS`도 필요합니다. 파일·문자·메일·결제·푸시 연동은 해당 공급자의 실제 설정이 있어야 동작하며, 누락된 설정을 가짜 성공 응답으로 대체하지 않습니다.

`.env*`, `.dev.vars*`, PEM, 데이터 스냅샷, `.claude`, `.vscode`는 공개 커밋 대상이 아닙니다. 운영 시크릿은 Wrangler secret 또는 GitHub Actions secret에 저장합니다.

## 검증

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`pnpm format`은 oxfmt로 코드를 정렬합니다. 위 명령은 검증 진입점이며, 현재 브랜치의 통과 여부는 실제 실행 결과와 CI를 확인해야 합니다.

D1 이관 도구의 독립 테스트:

```sh
node --test apps/api/scripts/migration.test.mjs
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

테스트 환경과 운영 환경을 분리합니다. 테스트 리소스 이름은 `koin-api-test`, `koin-api-files-test`, `koin-api-jobs-test`를 사용합니다. 이 리소스의 생성과 Worker 배포·검증은 서로 다른 단계입니다.

GitHub 저장소는 [BCSDLab/BCSD_united](https://github.com/BCSDLab/BCSD_united)입니다. GitHub 연결 배포는 Cloudflare Workers Builds에서 앱별 Worker와 빌드 명령을 연결하는 방식으로 구성합니다. 저장소 연결만으로 검증이 추가되지는 않으므로 빌드 명령에 필요한 검사 단계를 포함해야 합니다.

운영 도메인 전환, 실제 데이터 반입, 기존 시스템의 쓰기 중단은 별도 절차입니다. Worker 코드 롤백은 DB·객체 데이터 복구가 아닙니다.

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
