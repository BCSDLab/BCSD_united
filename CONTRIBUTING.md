# 기여 가이드

## 작업 환경

- Node.js: Cloudflare Workers Builds에서 지원하는 `24.22.1`(`.nvmrc`).
- 패키지 매니저: 루트 `package.json`의 `pnpm@12.16.1`을 Corepack으로 실행합니다. 다른 락파일은 만들지 않습니다.
- 앱은 `apps/web`, `apps/api`, `apps/error-automation`, `apps/b-bot`에 둡니다. 실제 공용 코드만 `packages/`로 분리합니다.
- `.claude`, `.vscode`는 개인 작업 환경이며 커밋하지 않습니다.

```sh
corepack pnpm install --frozen-lockfile
pnpm --filter @koin/api db:migrate:local
pnpm dev
```

환경 변수·배포·데이터 이관 조건은 [README](./README.md)를 따릅니다.

## 코드 규칙

- 웹은 기존 절대 경로, API는 `@api/*`를 사용합니다.
- 내부 화면 이동은 TanStack Router와 `ROUTES`를 사용합니다.
- 웹 mutation 오류는 `interfaces/APIError`의 `isKoinError()`로 좁힌 뒤 `showToast()`로 표시합니다. 업무 오류가 아닌 HTTP·네트워크 오류는 같은 모듈의 `HttpError`를 사용하며, 상태 코드는 `utils/ts/httpError`의 `getErrorStatus()`로 읽습니다.
- 서버가 아는 기기·인증·시각은 서버 스냅샷으로 전달합니다. 이를 클라이언트 시계나 영속 회원 유형으로 대체하지 않습니다.
- 요청별 QueryClient·쿠키 전달 컨텍스트를 공유 전역 상태로 바꾸지 않습니다.
- 웹 HTTP 요청은 `APIClient`의 native `fetch` 경로를 사용합니다. 브라우저는 same-origin `/api`, SSR은 검증된 Worker 대상과 요청별 Cookie/Origin을 사용합니다. 타임아웃은 응답 본문 수신까지 적용하며, 브라우저 401은 세션을 한 번 갱신한 뒤 최신 CSRF 헤더로 한 번만 재시도합니다. 직접 파일 업로드는 원본 Blob을 보내고 서비스 쿠키·CSRF를 제외합니다.
- D1 변경은 Drizzle의 파라미터화 SQL·원자 배치를 사용합니다. DO 직렬화만으로 DB 원자성이 생기는 것은 아닙니다.
- Queue 소비자는 중복 전달·중단·재시도를 고려하고, D1의 작업 상태와 fencing을 지킵니다.
- 주석은 변경 이력이 아니라 코드의 계약·제약을 한국어로 설명합니다.
- SCSS는 전역 reset과 초기값을 불필요하게 반복하지 않습니다.
- 별도 reviewer 봇·외부 분석 게이트를 추가하지 않습니다.

## 검증과 커밋

```sh
pnpm format
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

UI 변경은 실제 화면, API 변경은 실제 HTTP/D1 경로도 확인합니다. 실행하지 않은 검사를 통과했다고 표시하지 않습니다.

의존성 변경 시 해당 `package.json`, `pnpm-workspace.yaml`의 호환 버전·허용된 설치 스크립트, 루트 `pnpm-lock.yaml`을 함께 반영합니다. `@types/node`는 Node 24에, TypeScript·ESLint·h3는 각 도구/프레임워크의 지원 범위에 맞춥니다. `pnpm up --latest` 후에도 peer 호환성과 고정 버전의 근거를 확인하고, SheetJS 외부 tarball의 lockfile 무결성을 유지합니다. 생성된 route tree와 schema는 생성 원본을 변경한 뒤 갱신합니다. 적용된 D1 마이그레이션을 다시 쓰지 않습니다.

웹의 `@vitejs/plugin-react@6.1.2`는 React Compiler peer로 `oxc-transform-react@^0.152.0`을 요구합니다. `0.x`의 caret 범위는 다음 minor를 포함하지 않으므로, OXC를 `0.153.0` 이상으로 올릴 때는 해당 버전을 지원하는 플러그인과 함께 갱신합니다.

커밋은 `feat:`, `fix:`, `refactor:`, `chore:` 등 Conventional Commit 접두사와 한국어 설명을 사용합니다. 관련 없는 변경이나 시크릿을 포함하지 않습니다. PR에 수행한 검증과 남은 운영 전제조건을 명시합니다.

커밋 훅은 Corepack으로 고정된 pnpm을 사용합니다. Windows 명령 길이 제한을 넘지 않도록 파일 목록을 분할하고, 검사 묶음은 동시에 두 개까지 실행합니다.

## 운영 안전

웹·API는 `main`이 운영 브랜치이고 `preview`는 고정 native Preview를 위한 비운영 브랜치입니다. 오류 자동화 Worker는 예외로 `develop` 머지 후 검사·운영 배포하며, 다른 브랜치에서는 검사만 합니다. 자동화 배포를 위해 웹·API를 `main`으로 승격하지 않습니다. PR과 Workers Builds를 통해 배포하며, API·웹·오류 자동화에 별도 stage/test Worker나 중복 GitHub Actions 배포를 만들지 않습니다. 웹·API의 비운영 명령은 `wrangler preview`이고 `wrangler versions upload`나 `--env preview`가 아닙니다. 저장소의 `previews` 설정과 Cloudflare GitHub 연결·빌드 명령을 함께 유지합니다.

API 테스트 명령에는 TypeScript 회귀와 `.mjs` 데이터·파일 이관 동작 테스트가 모두 포함됩니다. Preview 검증은 HTTP 경로만 대상으로 합니다. Queue consumer·Cron은 Preview에서 실행하지 않으므로 알림·예약의 enqueue를 실행 완료로 보고하지 않습니다. 전환 중 기존 테스트 Worker의 consumer가 제거됐는지도 운영 담당자가 별도로 확인해야 합니다.

Preview D1/R2/Queue는 `-test` 리소스를 사용하지만 DO namespace는 Preview마다 자동 생성됩니다. 웹 Preview의 SSR·브라우저는 KOIN_API_V2 stage 서버(`https://api.stage.koreatech.in`)를 사용합니다. 오류 자동화 Preview에 운영 GitHub 토큰이나 운영 저장소 쓰기 권한을 주지 않습니다.

실제 계정·결제·파일·메시지·사용자 데이터에 영향을 주는 테스트를 임의로 실행하지 않습니다. 테스트 Worker·D1·R2를 사용하고, 운영 데이터 이관과 도메인 전환은 별도 승인과 복구 절차를 갖춥니다.

### 레거시 Worker API

업무 API의 현재 방향은 기존 Java 서버 유지입니다. `apps/api`의 TypeScript Worker는 레거시로 보존하며 `wrangler.jsonc`의 `API_ENABLED`가 운영·Preview 모두 `"false"`입니다. 코드·D1 데이터·R2·Queue·DO·마이그레이션·테스트 fixture를 정리하거나 삭제하는 PR을 만들지 않습니다. 비활성 전환은 설정값으로만 표현하고, 기존 활성 동작 테스트는 fixture에 `API_ENABLED: 'true'`를 명시해 유지합니다. 비활성 경계(503 `API_DISABLED`, scheduled 무동작, Queue `retryAll`, DO 쓰기 차단) 테스트는 추가할 수 있습니다.

로컬·격리 검증에서 업무 경로가 필요하면 해당 프로세스에만 `wrangler dev --var API_ENABLED:true`를 넣습니다. `scripts/autofix/local-api.mjs`가 이 방식을 사용하며 보조 Worker 사본의 `vars`만 치환합니다. 배포 설정이나 Cloudflare 대시보드 값을 바꾸는 방식으로 테스트를 통과시키지 않습니다. `SOURCE_SYNC_ENABLED`(`"false"`), `triggers.crons`(`[]`), 원본 호스트의 비공개 `sync-enabled` 승인 파일은 기존 게이트이므로 `API_ENABLED`와 묶거나 중복 게이트를 추가하지 않고, 사용자 재승인 전에는 비활성 상태를 유지합니다.

원격 반영은 저장소 커밋과 별개의 운영 절차입니다. 웹의 Java API 전환(#9)과 Java 서버 CORS가 끝나기 전에 `API_ENABLED: "false"`를 운영에 배포하면 현재 웹이 레거시 Worker를 호출하므로 장애가 납니다. Queue는 코드의 `retryAll()`로 멈추지 않으므로 배포 전후에 `wrangler queues pause-delivery koin-api-jobs`를 실제로 실행해야 하며, 저장소 값만으로 원격 비활성이 완료됐다고 보고하지 않습니다. 절차는 [README의 레거시 Worker API 비활성화와 복원](./README.md#레거시-worker-api-비활성화와-복원)을 따릅니다.
