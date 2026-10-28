# 기여 가이드

## 작업 환경

- Node.js: `.nvmrc`의 버전.
- 패키지 매니저: 루트 `package.json`에 고정된 pnpm. 다른 락파일은 만들지 않습니다.
- 앱은 `apps/web`, `apps/api`, `apps/sentry-automation`에 둡니다. 실제 공용 코드만 `packages/`로 분리합니다.
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

## 운영 안전

실제 계정·결제·파일·메시지·사용자 데이터에 영향을 주는 테스트를 임의로 실행하지 않습니다. 테스트 Worker·D1·R2를 사용하고, 운영 데이터 이관과 도메인 전환은 별도 승인과 복구 절차를 갖춥니다.
