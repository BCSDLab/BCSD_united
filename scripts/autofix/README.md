# 오류 알림 → 이슈 → 독립 검증 → PR

`apps/error-automation` Worker가 인증한 Sentry/Cloudflare 알림을 SQLite DO에 기록하고, 고정 Rocky/UMPC 전용 실행기가 **아웃바운드 HTTPS polling**으로 작업을 받는다. GitHub Actions dispatch나 Cloudflare 유료 Container/Workflow는 실행 경로가 아니다. Worker가 고정 `claude-fable-5-1` 모델 요청만 중계하고, 실행기는 파일 도구만 사용해 후보를 만든 뒤 별도 Docker 검증 결과를 Worker에 제출한다. 자동 승인·merge·배포는 없다. 호스트 설치·비밀 등록·실제 모델/PR 호출은 운영 승인과 실제 통합 확인 전에는 완료된 것으로 간주하지 않는다.

## 지원 범위와 현재 제한

- **Sentry:** 고정된 Sentry API에서 프로젝트/이슈/브라우저 SDK를 확인한다. 허용 호스트의 요청 경로와 애플리케이션 소스 프레임이 있어야 모델을 호출한다. 새 행동 회귀 테스트, 기존 native fixtures, 타입/lint/build/runtime 검증을 모두 통과한 후보만 PR로 발행한다.
- **Cloudflare Issues:** 공식 Notifications 표준 envelope를 인증한 Worker가 보관한 진단을 읽고 계정·정책·Worker·앱을 재검증하여 이슈를 생성/재사용한다. **공식 문서는 `data` 내부의 Issues 예외/프레임/요청 경로 계약을 정의하지 않는다. 실제 인증된 Issues 알림의 삭제·마스킹된 샘플로 그 계약을 확인하기 전에는 자동 코드 수정/PR을 지원한다고 주장하지 않는다.** 현재 해당 단계는 `CLOUDFLARE_EVIDENCE_UNAVAILABLE`로 실패하며 이슈에 정직한 결과를 남긴다. 기존 Workers 지표 알림을 Issues 대신 쓰거나 비공개 Issues REST API를 만들어 호출하지 않는다.
- 외부 API, 인증된 사용자 상태, dependency/config/generated code 수정, Node 회귀로 재현할 수 없는 오류는 안전 범위 밖이다. 실패를 우회하거나 빈 PR을 만들지 않는다.
- 2026-10-29 커밋 `68c6d24`의 독립 오프라인 실행에서 `/shops/categories` 실제 API/D1 GET, 홈 `/` SSR, 데스크톱 Chromium, 390px Android 에뮬레이션 Chromium의 홈 UI·브라우저 gateway 비교가 통과했다. 빈 로컬 D1에서 날씨 제공자 부재(`CONFIGURATION_ERROR`)와 학생식당 운영정보 부재(`NOT_FOUND_DATA`)가 명시적인 unavailable/빈 식단 UI로 표시되는 것도 확인했다. 이는 실제 휴대전화·운영 데이터·Sentry/Cloudflare/GitHub 제공자 연동의 성공을 뜻하지 않는다.

## 고정 제공자 식별자

웹훅은 아래 식별자만 저장하고 고정 저장소 큐에 등록한다. 추가 프롬프트·URL·저장소·호스트·브랜치·명령·파일 경로로 실행 대상을 바꿀 수 없다.

```json
{
  "source": "sentry",
  "sourceId": "12345",
  "project": "koin-united-prod",
  "app": "web",
  "scope": { "organization": "bcsd" }
}
```

```json
{
  "source": "cloudflare",
  "sourceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "project": "koin-api",
  "app": "api",
  "scope": {
    "accountId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "policyId": "cccccccccccccccccccccccccccccccc",
    "workerName": "koin-api"
  }
}
```

Sentry ID는 앞자리 0 없는 양의 십진 문자열이다. Cloudflare correlation/account/policy ID는 정규화된 소문자 32자리 hex이며 `project = workerName`이다. Worker/앱은 알림 본문이 아니라 신뢰된 정책 매핑에서 정한다. `BCSDLab/BCSD_united`의 고정 기본 브랜치 SHA를 Worker 준비 단계에서 조회한다. 수동 `workflow_dispatch` 재실행 경로는 없다.

이슈 마커는 `<!-- error-autofix:source:provider-scope:project:sourceId -->`로 제공자와 계정/정책을 구분한다. 열린/닫힌 이슈를 GitHub Issues API로 최대 10,000개 순회하여 검색 인덱스 지연을 피한다. 브랜치는 `fix/#<issue>/<source>-<sourceId>`이다. 같은 브랜치의 PR이 있으면 새 모델 호출 없이 안내한다. 발행 도중 브랜치만 남은 경우 동일 부모/트리인지 확인하고 재개하며 force push하지 않는다.

## 진단·소스 근거

Worker는 source별 진단 DO에서 인증·마스킹된 기록을 내부 binding으로 읽는다. Sentry는 Worker만 `https://sentry.io/api/0/organizations/<org>/issues/<id>/` 및 `events/latest/`에서 canonical issue/event를 조회한다. 원문 request header/body/cookie, user, breadcrumbs, source context는 모델·실행기 작업공간에 쓰지 않는다. 허용 프로젝트 호스트의 안전한 GET 경로와 실제 `apps/web/src` 앱 소스 프레임이 없으면 수정하지 않는다.

Cloudflare Issues는 공식 Notifications envelope의 불투명 `data`를 임의 예외/경로/소스 프레임으로 해석하지 않는다. 실제 인증된 Issues 샘플이 아직 없으므로 자동 수정은 `CLOUDFLARE_EVIDENCE_UNAVAILABLE`로 닫고 이슈에 부족한 근거를 남긴다. 예시 payload나 비공개 Issues REST API를 만들어 검증했다고 주장하지 않는다. 진단 보존/읽기 제한은 `apps/error-automation/README.md`를 따른다.

Sentry는 `https://sentry.io/api/0/organizations/<org>/issues/<id>/` 및 `events/latest/`만 조회한다. 원문 request headers/body/cookies, user, breadcrumbs, source context를 저장하지 않는다. 문자열의 URL, 이메일, IP, 일반적인 token/password/authorization 패턴도 제거한다. 소스 프레임은 웹 앱의 `src/*.ts(x)/js(x)`만 허용한다. 마스킹은 모든 개인정보를 탐지한다는 보장이 아니므로 Sentry server-side scrubbing 및 SDK 정책도 필수다.

## Worker 비밀과 실행기 계약

Worker secret은 웹훅별 `SENTRY_CLIENT_SECRET`/`CLOUDFLARE_WEBHOOK_SECRET`, canonical Sentry read 전용 `SENTRY_READ_TOKEN`, 진단 읽기 전용 `DIAGNOSTICS_READ_TOKEN`, 단일 GitHub App의 기존 `GITHUB_DISPATCH_APP_PRIVATE_KEY`, Anthropic `ANTHROPIC_API_KEY`, 전용 `AUTOFIX_EXECUTOR_TOKEN`이다. 전용 실행기는 마지막 토큰만 안전한 host 설정 파일에서 사용하고 GitHub/Anthropic/provider 비밀을 받지 않는다. 기존 App 이름 `GITHUB_DISPATCH_*`은 저장된 한 App의 배포 설정명일 뿐 GitHub dispatch 실행을 뜻하지 않는다. App은 **BCSDLab/BCSD_united 하나**에만 설치되며 Worker가 역할별 contents/issues/pull requests read 또는 write 범위의 설치 토큰을 필요한 순간 발급한다.

`AUTOFIX_EXECUTOR_ID=koin-rocky-umpc`로 고정한다. 실행기는 고정 HTTPS Worker origin에만 `Authorization: Bearer <AUTOFIX_EXECUTOR_TOKEN>` 및 `X-Executor-Id: koin-rocky-umpc`를 보내며 호스트 인바운드 네트워크 포트를 열지 않는다. `/executor/claim`의 `claimNonce` 64자리 hex를 비밀 파일과 분리해 먼저 영속하고, 응답 유실 때 같은 nonce로 동일 lease를 재요청한다. 204는 대기 작업 없음, 200은 고정 repo/base SHA/diagnostics/context/issue/lease. 2분 rolling heartbeat·90분 절대 기한·동시 한 작업을 적용한다.

`/executor/jobs/<runId>/model`은 살아 있는 generation lease에서만 요청한다. Worker가 정적 system prompt/고정 Fable 모델/Read·Edit·Write·Glob·Grep JSON schema만 Anthropic `/v1/messages`로 전송하고 API key를 Worker 밖에 내보내지 않는다. 모델 메시지의 파일 요청은 실행기에서 허용 경로·symlink·앱 경계를 다시 검사한다. 40회 모델 호출·40회 파일 도구 호출·generation 20분을 넘기면 닫는다. 후보 workspace는 이슈 진단을 **자료**로만 다루며 shell/network/MCP/GitHub credential을 사용할 수 없다.

실행기는 공개 저장소의 검증된 고정 SHA를 각 작업의 별도 model/verifier git worktree로 준비한다. verifier image는 미리 빌드해 재사용하되, 후보 소스는 독립적인 새 검증 작업공간/매번 disposable Docker 실행으로 검증한다. `/verification-start` 이후 모델 프록시는 닫힌다. source-only 모델이 낸 manifest는 최대 24 text 파일, 파일당 256 KB, 합계 1 MB이며 수정 앱 src와 새 `tests/autofix/*.test.mjs`로만 제한한다. 기존 테스트/설정/lockfile/schema/generated 변경과 다른 앱 변경은 거부한다.

독립 검증은 수정 전 새 assertion 실패/수정 후 통과, 기존 native fixtures와 autofix 보안 테스트, 타입/lint/build, 실제 로컬 API+D1+SSR+Chromium/390px 모바일 smoke를 수행한다. 네트워크 없는 Docker, 비루트/capability 제거, read-only source/dependencies와 제한된 scratch를 사용한다. proof는 base SHA·검증된 manifest SHA256·정확한 필수 check 목록에 결속한다. Worker는 원본 기본 브랜치 SHA가 전진하지 않았는지 재조회하고 verified bytes만 Git tree/commit/PR로 발행한다. force push, 자동 merge/배포는 없다. 실행·검증 실패나 무변경은 verified PR로 표시하지 않고 이슈에 원문 비밀 없이 사실만 남긴다.

Rocky/UMPC의 root 신뢰 실행기는 고정 SHA 소스에서 후보와 독립 검증 worktree를 분리하고, 사전 빌드된 **두 이미지의 검증 스크립트 SHA256 일치**를 작업 전·검증 전 확인한다. 검증용 의존성은 자격 증명 없는 신뢰 설치 컨테이너에서 `pnpm install --frozen-lockfile --ignore-scripts`로 획득한 뒤, Docker `network disconnect`와 기본 경로 부재 확인 후 **같은 컨테이너에서** `pnpm rebuild --pending`으로 승인된 실제 lifecycle을 네트워크 없이 실행한다. 이후의 회귀·타입·lint·빌드·API/D1/SSR/브라우저 확인은 별도 매번 폐기되는 `--network none`, cap-drop-all, no-new-privileges, non-root 컨테이너에서 수행한다. 설치와 후보 실행은 동일 컨테이너가 아니며 모델은 어떤 코드를 실행하거나 Docker socket을 읽지 못한다. root 컨트롤러에 CAP_CHOWN을 추가하지 않고, 고정 scratch 디렉터리만 마운트한 신뢰 CHOWN 전용 도우미와 UID 1000의 무권한 정리 도우미가 소유권·회수를 처리한다.

2026-10-29 Rocky 호스트에서 고정 커밋 `68c6d24`의 root 컨트롤러 이미지로 오프라인 전체 스모크가 종료 코드 0으로 완료됐다. 검증 코드가 Docker 내부 `id -u`의 비루트 일치를 확인했고, 실제 로컬 API/D1 GET·홈 SSR/Chromium·390px 모바일 게이트가 통과했으며 격리 컨테이너와 소스 스냅샷 정리까지 끝났다. 이는 후보 패치의 회귀 전후 검증, 실제 제공자 호출 또는 운영 PR 발행의 증거는 아니다.

검증 세부 조건:

1. **검증 격리:** 별도 깨끗한 worktree에서 24개 파일/파일당 256KB/총 1MB/일반 파일/앱 경계/baseline SHA256을 검사한다. 기본 코드에 frozen install을 끝낸 다음 후보를 적용한다. 이후 모든 실행은 네트워크·자격증명·Docker socket 없이 non-root/capability 제거/resource 제한 컨테이너에서 수행한다. 소스/설정/테스트/의존성은 read-only이며 빌드·런타임 출력 디렉터리만 명시적으로 쓸 수 있다.
2. 새 `tests/autofix/*.test.mjs`는 수정 전 실제 assertion 실패, 수정 후 통과해야 한다. loader/setup 실패는 재현이 아니다. API 후보는 `@koin/api...`, 웹 후보는 추가로 `@koin/web...` 의존성 범위의 기존 native fixtures·타입·빌드를 검사하고 autofix 보안 테스트와 해당 범위 lint를 수행한다. B-BOT의 별도 PostgreSQL 런타임은 이 자동 수정 대상이 아니며 저장소 전체 검증에서 따로 검사한다. 기존 fixture/test 파일은 패치에서 수정할 수 없다.
3. 웹은 정적 route/import graph에서 모든 변경 소스가 관측 경로에 도달하는지 확인한다. 웹 검증 전 로컬 D1 migration을 적용하고, Vite 빌드에 검증 전용 `koin-api` auxiliary Worker를 포함하여 SSR service binding과 브라우저 gateway가 동일한 실제 로컬 API/D1을 사용하게 한다. API smoke는 별도 실제 Wrangler Worker에서 관측된 GET endpoint 실행과 2xx/JSON을 확인한다. API 요청 로그와 SSR 전후 요청 수, 브라우저 응답 본문을 대조한다. 데스크톱 후 앱 문서를 떠난 다음 390px 모바일 문서를 새로 열어 실제 홈 인사·식단 위젯·gateway와 콘솔/HTTP 오류를 확인한다. 빈 로컬 D1에서 `/weather` 503과 `/coopshop/1` 404는 정확한 API 오류 코드와 명시적 unavailable/빈 식단 UI를 모두 확인한 경우에만 허용한다. 임시 entrypoint·registry·브라우저 프로필·프로세스·컨테이너·source snapshot을 정리한다. mutating 요청/인증/필수 query/운영 데이터 의존은 자동 재생하지 않으며 운영 데이터나 가짜 fallback을 사용하지 않는다.

## 프롬프트 출처와 적용 범위

Worker의 정적 source-only system prompt는 아래 공개 구현에서 **원칙만 새로 서술**했다. 실행 중 upstream 프롬프트/스크립트를 다운로드하지 않는다.

- [OpenHands Datadog debugging prompt](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/debug_prompt.jinja) 및 [integration](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/datadog_debugging.py): 오류 데이터→관련 코드→원인 가설→재현→수정 또는 정직한 조사 결과 흐름. upstream의 curl/credential/repo clone/모델 PR 발행 권한은 채택하지 않았다.
- [OpenHands basic agent](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/agent_script.py) 및 [workflow](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/workflow.yml): 명시적인 task/model/API key 연결을 참고하되 upstream runtime URL fetch/광범위 GitHub write 권한은 채택하지 않았다.
- [Sweep planning prompts](https://github.com/sweepai/sweep/blob/a8b8b67bda4f89faac9314d34e7c7d5a64f76046/sweepai/core/planning_prompts.py): 파일·함수 이름을 명시한 원자적 최소 변경, 기존 helper 재사용, placeholder 금지. upstream의 테스트 제외 지침 및 speculative 범위 확대는 채택하지 않았다.
- [Claude Fable 5.1 공식 모델 ID](https://platform.claude.com/docs/en/models/fable-5-1/overview), [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create): Worker가 `claude-fable-5-1`과 다섯 파일 도구 schema 및 `ANTHROPIC_API_KEY`를 고정한다.
- [Cloudflare Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/), [Notifications webhook envelope](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/), [공유 비밀 인증](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/).

## 검증 명령

로컬 결정적 행동 검사는 `node --test scripts/autofix/security.test.mjs`이다. 전체 독립 verifier는 Linux/WSL2 + Docker, 커밋된 base SHA, 실제 `error-input/context.json`과 `error-patch/patch.json`이 필요하다.

```sh
docker build --tag koin-error-verifier --file scripts/autofix/Dockerfile scripts/autofix
node scripts/autofix/verify.mjs
```

현재 작업 트리의 git 추적 파일만 격리 복사하여 API/D1 + 홈 SSR + 데스크톱/390px 모바일 Chromium을 검사하려면 macOS의 Docker Desktop 또는 Linux Docker daemon을 시작한 뒤 다음을 실행한다. `.env`/PEM/사용자 데이터나 host `node_modules`는 복사·마운트하지 않는다. 설치 단계만 bridge network를 쓰고, 빌드·마이그레이션·HTTP/브라우저 검사는 `--network none`, non-root, 읽기 전용 source와 명시적인 scratch mount에서 실행한다. 실패해도 source snapshot과 임시 컨테이너는 정리하며 운영 URL로 fallback하지 않는다.

```sh
docker build --tag koin-error-verifier --file scripts/autofix/Dockerfile scripts/autofix
node scripts/autofix/verify.mjs --offline-smoke
```

성공 시 `Real local API/D1 smoke passed: GET /shops/categories`, `Real local API/D1 smoke passed: SSR /, browser /, gateway /api/shops/categories`, `Mobile local API/D1 smoke passed: / at 390px, gateway /api/shops/categories`, `Offline local API/D1 + SSR + Chromium smoke passed`를 출력한다. 이 단독 명령은 후보 패치의 회귀·타입·lint 검증을 대신하지 않으며, 실제 `error-input/context.json`과 `error-patch/patch.json`을 사용하는 위의 전체 독립 verifier도 별도로 실행해야 한다.

실제 Rocky 실행기 설치·모델 호출·이슈/PR 발행·운영 배포는 별도 명시적 승인과 통합 확인 뒤에만 수행한다. 이 로컬 검증 명령은 provider delivery 또는 운영 PR 성공을 대신하지 않는다.
