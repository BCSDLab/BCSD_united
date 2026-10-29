# 기여 가이드

## 작업 환경

- Node.js: `.nvmrc`의 버전.
- 패키지 매니저: 루트 `package.json`에 고정된 pnpm. 다른 락파일은 만들지 않습니다.
- 앱은 `apps/web`, `apps/api`, `apps/error-automation`, `apps/b-bot`에 둡니다. 실제 공용 코드만 `packages/`로 분리합니다.
- `.claude`, `.vscode`는 개인 작업 환경이며 커밋하지 않습니다.

```sh
corepack pnpm install
pnpm --filter @koin/api db:migrate:local
pnpm dev
```

환경 변수·배포·데이터 이관 조건은 [README](./README.md)를 따릅니다.

## 코드 규칙

- 웹은 기존 절대 경로, API는 `@api/*`를 사용합니다.
- 내부 화면 이동은 TanStack Router와 `ROUTES`를 사용합니다.
- 웹 mutation 오류는 `isKoinError()`로 좁힌 뒤 `showToast()`로 표시합니다.
- 서버가 아는 기기·인증·시각은 서버 스냅샷으로 전달합니다. 이를 클라이언트 시계나 영속 회원 유형으로 대체하지 않습니다.
- 요청별 QueryClient·쿠키 전달 컨텍스트를 공유 전역 상태로 바꾸지 않습니다.
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

의존성 변경 시 해당 `package.json`과 루트 `pnpm-lock.yaml`을 함께 반영합니다. 생성된 route tree와 schema는 생성 원본을 변경한 뒤 갱신합니다. 적용된 D1 마이그레이션을 다시 쓰지 않습니다.

커밋은 `feat:`, `fix:`, `refactor:`, `chore:` 등 Conventional Commit 접두사와 한국어 설명을 사용합니다. 관련 없는 변경이나 시크릿을 포함하지 않습니다. PR에 수행한 검증과 남은 운영 전제조건을 명시합니다.

커밋 훅은 Corepack으로 고정된 pnpm을 사용합니다. Windows 명령 길이 제한을 넘지 않도록 파일 목록을 분할하고, 검사 묶음은 동시에 두 개까지 실행합니다.

## 운영 안전

`main`이 기본·운영 브랜치이고 `preview`는 고정 native Preview를 위한 비운영 브랜치입니다. PR과 Workers Builds를 통해 배포하며, API·웹·오류 자동화에 별도 stage/test Worker나 중복 GitHub Actions 배포를 만들지 않습니다. 비운영 명령은 `wrangler preview`이고 `wrangler versions upload`나 `--env preview`가 아닙니다. 저장소의 `previews` 설정과 Cloudflare GitHub 연결·빌드 명령을 함께 유지합니다.

API 테스트 명령에는 TypeScript 회귀와 `.mjs` 데이터·파일 이관 동작 테스트가 모두 포함됩니다. Preview 검증은 HTTP 경로만 대상으로 합니다. Queue consumer·Cron은 Preview에서 실행하지 않으므로 알림·예약의 enqueue를 실행 완료로 보고하지 않습니다. 전환 중 기존 테스트 Worker의 consumer가 제거됐는지도 운영 담당자가 별도로 확인해야 합니다.

Preview D1/R2/Queue는 `-test` 리소스를 사용하지만 DO namespace는 Preview마다 자동 생성됩니다. 웹 Preview의 SSR·브라우저는 API Preview HTTP origin을 사용합니다. service binding은 production으로 연결되므로 Preview 연결 대안으로 사용하지 않습니다. 오류 자동화 Preview에 운영 GitHub 토큰이나 운영 저장소 쓰기 권한을 주지 않습니다.

실제 계정·결제·파일·메시지·사용자 데이터에 영향을 주는 테스트를 임의로 실행하지 않습니다. 테스트 Worker·D1·R2를 사용하고, 운영 데이터 이관과 도메인 전환은 별도 승인과 복구 절차를 갖춥니다.
