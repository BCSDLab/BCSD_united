# 오류 자동 수정 웹훅과 전용 실행기

`bcsd-error-automation` Worker는 Sentry 브라우저 오류와 Cloudflare Issues Worker/API/SSR 알림을 인증한다. 진단을 source별 SQLite Durable Object에 먼저 저장하고, 고정 저장소의 `AutofixQueue` DO에 중복 없이 등록한다. GitHub Actions `repository_dispatch` 또는 Cloudflare 유료 Container/Workflow로 후보 코드를 실행하지 않는다. 고정 등록된 Rocky/UMPC 실행기가 **아웃바운드 HTTPS로만** 작업을 요청한다. 실제 호스트 서비스 설치·비밀 등록·배포·GitHub PR 발행은 별도 운영 승인과 통합 검증 전에는 완료된 것으로 간주하지 않는다.

## 고정 배포와 권한

`wrangler.jsonc`는 `ENVIRONMENT=production`, `GITHUB_OWNER=BCSDLab`, `GITHUB_REPOSITORY=BCSD_united`, 단일 GitHub App ID `5522353`/설치 ID `176455083`, `AUTOFIX_EXECUTOR_ID=koin-rocky-umpc`를 고정한다. Preview URL은 비활성화하며 다른 저장소·App·설치·환경으로 자동화를 바꾸는 입력은 없다. 운영 외 배포는 503으로 닫힌다. 이 Worker에 대한 PR preview/별도 GitHub Actions 실행 경로를 자동화 진입점으로 사용하지 않는다.

설정값:

| 이름                                          | 의미                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_ORGANIZATION` / `SENTRY_PROJECT_APPS` | 허용 조직과 `{"koin-united-prod":"web","koin-united-preview":"web"}`처럼 브라우저 프로젝트만 매핑                   |
| `SENTRY_PROJECT_HOSTS`                        | `{"koin-united-prod":["koreatech.in"],"koin-united-preview":["stage.koreatech.in"]}`처럼 실제 경로 확인에 쓸 호스트 |
| `CLOUDFLARE_SOURCES`                          | 실제 Issues policy의 accountId/policyId/workerName/app 정확한 매핑. 미설정이면 `[]`                                 |
| `ERROR_PROJECT_DOMAINS`                       | 프로젝트별 GitHub 이슈 제목 분류. 허용 값은 `캠퍼스`, `비즈니스`, `유저`, `공통`                                    |
| `AUTOFIX_EXECUTOR_ID`                         | `koin-rocky-umpc`만 허용. 이벤트나 요청 본문에서 변경 불가                                                          |

`CLOUDFLARE_SOURCES`에는 해당 Worker의 실제 Issues automation policy만 등록한다. 하나의 account/policy는 하나의 Worker/앱에 대응해야 한다. 일반 자원 경고 정책이나 추측한 계정/정책을 Issues 정책으로 넣지 않는다. 알림 본문 속 Worker·앱·프로젝트 값은 라우팅 근거가 아니다.

비밀은 운영 담당자가 승인 뒤 대화형 명령으로 등록한다. 값을 저장소·명령 인자·로그에 남기지 않는다:

```sh
pnpm --dir apps/error-automation exec wrangler secret put SENTRY_CLIENT_SECRET
pnpm --dir apps/error-automation exec wrangler secret put SENTRY_READ_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put CLOUDFLARE_WEBHOOK_SECRET
pnpm --dir apps/error-automation exec wrangler secret put DIAGNOSTICS_READ_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put GITHUB_DISPATCH_APP_PRIVATE_KEY
pnpm --dir apps/error-automation exec wrangler secret put ANTHROPIC_API_KEY
pnpm --dir apps/error-automation exec wrangler secret put AUTOFIX_EXECUTOR_TOKEN
```

`SENTRY_CLIENT_SECRET`는 Sentry 웹훅 서명, `SENTRY_READ_TOKEN`은 Worker의 canonical issue/event 조회에만 사용한다. `CLOUDFLARE_WEBHOOK_SECRET`는 Issues Generic Webhook의 `cf-webhook-auth`와 같은 32자 이상 전용 무작위 값이다. `DIAGNOSTICS_READ_TOKEN`은 허용 scope의 진단 GET 전용 32자 이상 값이다. `AUTOFIX_EXECUTOR_TOKEN`은 별도 32자 이상 값으로 **Rocky 전용 실행기와 Worker만** 공유한다. 다른 서비스의 광범위한 제어 토큰을 재사용하지 않고, 해당 호스트에 외부 인바운드 포트를 열지 않는다. `ANTHROPIC_API_KEY`는 Worker의 고정 모델 프록시에만 있고 실행기·후보 소스·Docker에 전달하지 않는다.

기존 `GITHUB_DISPATCH_APP_*` 이름은 이미 저장된 **단일** App 키/ID/설치 ID를 가리키는 현재 배포 설정명이다. Actions dispatch 권한이나 두 번째 App을 뜻하지 않는다. Worker가 `BCSDLab/BCSD_united` 하나로 축소한 read 토큰(contents/issues/pull requests read)과 발행 단계 write 토큰(contents/issues/pull requests write)을 별도로 발급한다. 키와 발급 토큰은 모델/실행기/DO 저장소에 전달하지 않는다. 배포 시 기존 secret을 조용히 삭제·이름 변경하지 않는다.

`v1` migration의 `ErrorIssueDispatch` 클래스/`ERROR_ISSUES` binding은 기존 진단과 중복 기록을 유지한다. `v2`는 저장소별 `AutofixQueue` SQLite DO를 추가한다. 기존 `accepted_at`은 과거 Actions 수락 시각으로 보존하고 새 `queue_admitted_at`을 별도 추가하므로 과거 수락이 새 실행기 등록을 막지 않는다. 이미 배포한 migration을 제거하거나 상태를 초기화하지 않는다.

## Cloudflare Issues 입력 계약

Issues의 **Generic Webhook** destination URL은 `https://<운영 호스트>/webhooks/cloudflare`이다. Cloudflare는 Secret을 `cf-webhook-auth` 헤더로 전송한다. **Cloudflare 요청 본문 HMAC 서명이 아니다.** Worker는 Web Crypto HMAC 검증 primitive로 secret 동등성을 비교하여 문자열의 일치 위치에 따른 조기 비교 종료를 피한다. HTTPS와 secret의 기밀성이 인증 경계이며, 유효한 secret을 가진 발신자의 임의 본문 변경까지 검출하는 서명은 제공되지 않는다.

[Issues automation 공식 문서](https://developers.cloudflare.com/workers/observability/issues/automations/)가 보장하는 [표준 Notifications envelope](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/)를 사용한다.

필수 필드:

- `account_id`: 배포 허용 목록의 32자리 소문자 hex 계정 ID
- `policy_id`: 허용된 Issues policy UUID
- `alert_correlation_id`: 관련 알림을 묶는 공식 UUID 필드. **이 값을 undocumented Issues REST issue ID로 간주하지 않는다.**
- `alert_type`: 비어 있지 않은 100자 이하 영숫자/`_`/`.`/`-` 식별자
- `ts`: 0 이상의 안전한 정수 Unix 초
- `text`: 문자열
- `data`: JSON 객체. 내부 필드는 불투명 진단 데이터이지 신뢰된 설정이 아니다.

UUID는 소문자 32자리 hex 또는 표준 하이픈 표기를 받고 저장/큐 등록 전에 하이픈 없는 32자리로 정규화한다. `alert_event`는 선택적 문자열이며 알려진 `ALERT_STATE_EVENT_END`는 인증·식별 검증 후 무시한다. 요청 본문은 1 MiB까지 받는다.

공식 문서의 네이티브 `workers_alert` 예시는 `data.scripts[].script_name`, `workers_observability_alert` 예시는 `data.episode`를 포함한다. 이들은 **Issues 전용 payload fixture가 아니며 이 서비스의 Issues 설정 예제로 대체하지 않는다.** 수신기는 특정 `alert_type` 이름이나 `data.issue.id`/stack 위치를 발명하지 않고 표준 envelope만 해석한다. 테스트의 `fixture_issue_notification`은 합성 식별자이며 실제 Cloudflare 타입이라고 주장하지 않는다.

Issues 전용 `data` 구조와 실제 alert type은 공개 문서에 상세히 고정되어 있지 않다. 배포 후 운영 담당자가 해당 Worker Issues 화면에서 실제 오류를 선택해 destination으로 수동 전송하고, 진단 읽기 경로로 마스킹된 결과를 확인해야 한다. 테스트는 네이티브 Issues 전달 성공의 증거가 아니다. 실제 알림에 account/policy/correlation UUID가 빠져 있거나 형식이 다르면 400/403으로 거부하며 text/임의 data 값에서 ID를 추측하지 않는다. 이런 경우 필요한 자료는 **secret·개인정보를 제거한 실제 envelope와 대시보드의 정책-Worker 연결 정보**이다. 문서화되지 않은 Issues REST endpoint나 가짜 canonical 오류 이벤트는 사용하지 않는다.

Cloudflare Save and Test의 정확한 공식 probe `{"text":"Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly."}`는 HTTPS·운영 환경·POST·본문 제한·전용 `cf-webhook-auth`(32자 이상) 검증 후 204로 응답하되 진단 기록·큐 등록은 하지 않는다. provider allowlist와 GitHub 설치가 미설정이어도 **이 인증된 설정 확인만** 허용한다. 추가 필드나 수정된 문장은 전체 설정/identity 검증을 거치며 미설정이면 503이다. probe 204는 실제 Issues 알림 수신 증거가 아니다.

## Sentry 입력 계약

URL은 `https://<운영 호스트>/webhooks/sentry`이다. 정확한 요청 바이트를 `Sentry-Hook-Signature` HMAC SHA-256으로 검증한다. JSON 재직렬화로 서명을 검증하지 않는다.

지원 이벤트는 `issue/created`, `issue/unresolved` + `substatus: regressed`, `event_alert/triggered`이다. 나머지는 인증 후 무시한다. issue의 `project.slug`와 공식 issue URL로 조직을 확인한다. legacy `/api/0/issues/<id>/`는 `web_url` 또는 `permalink`에서 조직을 확인한다. event alert의 숫자형 project를 slug로 오인하지 않고 공식 event URL의 조직·프로젝트를 검증한다. 이 URL로 네트워크 요청을 보내지는 않는다. Sentry canonical API 조회는 Worker의 신뢰된 준비 작업에서만 수행한다.

## 진단 보관과 아웃바운드 실행 계약

웹훅에서 검증한 제공자 식별자만 고정 저장소 큐에 등록한다. 오류 문자열, prompt, URL, 저장소·실행 호스트·명령·파일 경로 선택은 웹훅이 제어하지 못한다. 식별자는 Sentry의 `source/sourceId/project/app:web/scope.organization` 또는 Cloudflare의 `source/sourceId/project/app/scope.accountId/policyId/workerName`으로 제한한다. 준비 단계는 고정 default branch/SHA와 issue marker를 다시 확인하고, Sentry의 안전한 GET 경로와 실제 앱 소스 프레임이 없으면 모델을 호출하지 않는다. Cloudflare Issues 전용 진단의 경로/프레임 계약은 아직 실제 인증 샘플로 입증되지 않아 `CLOUDFLARE_EVIDENCE_UNAVAILABLE`로 중단하고 이슈에 자료 부족을 남긴다.

Rocky/UMPC의 전용 실행기는 고정 HTTPS Worker origin으로 `X-Executor-Id: koin-rocky-umpc`, 전용 Bearer `AUTOFIX_EXECUTOR_TOKEN`을 보내며 인바운드 서버·임의 작업 URL을 열지 않는다. `POST /executor/claim`은 사전 영속한 `claimNonce`(64자리 hex)로 작업을 요청한다(204: 작업 없음, 200: 고정 SHA/진단/lease). 응답 유실 때 **같은 nonce**로 같은 작업/lease를 복원한다. `POST /executor/jobs/<runId>/heartbeat`는 2분 rolling lease를 갱신하되 절대 90분 기한을 넘기지 못한다. 하나의 저장소 큐에서 진행 작업은 최대 하나이며 중복/만료 작업을 조용히 재실행하지 않는다.

`POST /executor/jobs/<runId>/model`은 살아 있는 generation lease에서만 가능하다. Worker가 `ANTHROPIC_API_KEY`를 보관하고 고정된 `claude-fable-5-1`/정적 source-only system/Read·Edit·Write·Glob·Grep JSON schema로만 Anthropic `/v1/messages`에 요청한다. 실행기 요청은 정확한 model/messages/다섯 tool 이름/maxTokens/lease만 담는다. 임의 provider URL·헤더·system·서버 도구는 받지 않는다. 본문/응답은 각 256 KB 이하, 모델 호출 40회·generation 20분 한도이다. 후보 환경에는 GitHub/Anthropic 키가 없다.

`POST /executor/jobs/<runId>/verification-start`는 generation을 원자적으로 닫고 별도 검증 단계로 전환한다. 이후 모델 요청은 거부한다. 실행기는 독립적인 새 검증 작업공간과 격리된 disposable Docker 실행으로 실제 수정 전 assertion 실패/수정 후 통과, 필수 native/security suites, 타입/lint/build, API+D1/SSR/Chromium(390px 포함)을 확인한다. `POST /executor/jobs/<runId>/result`의 성공은 lease+base SHA+manifest SHA256+정확한 필수 check 목록과 verified manifest bytes가 일치할 때만 PR 발행으로 이어진다. 모델 발언이나 빈 patch를 검증 완료로 처리하지 않는다. 고정 기본 브랜치가 전진하면 발행하지 않고, 기존 브랜치/PR을 덮어쓰거나 자동 merge/배포하지 않는다. 실패/자료 부족은 verified PR 없이 이슈에 사실만 남긴다.

진단 읽기는 `Authorization: Bearer <DIAGNOSTICS_READ_TOKEN>`을 요구한다. query token, 쿠키, CORS 공개 읽기, 목록 조회는 지원하지 않는다.

- `GET /diagnostics/cloudflare/<sourceId>?project=<worker>&accountId=<account>&policyId=<policy>&workerName=<worker>`
- `GET /diagnostics/sentry/<sourceId>?project=<project>&organization=<organization>`

query는 정확한 필드 집합만 허용하고 중복/추가 필드는 거부한다. 모든 scope는 배포 허용 목록과 일치해야 한다. 토큰 오류는 401, 허용 목록 밖 scope는 403, 없는/만료된 진단은 404이다. 응답은 `Cache-Control: no-store`이다.

응답 JSON은 `{ version: 1, identity: <제공자 식별자>, capturedAt: <ISO 시각>, summary: <문자열>, details: <객체> }`이다. Cloudflare details는 `{ alertType, timestamp, data }`, Sentry details는 `{ resource, action }`이다. `data`는 마스킹한 불투명 제공자 필드이지 검증된 예외/경로 정보가 아니다. 실제 코드 위치/재현 입력이 없으면 준비 단계는 자료 부족을 명시하고 원인을 창작하지 않는다.

진단 privacy 제한:

- summary 최대 4096자, opaque data 최대 8192 UTF-8 bytes, 전체 진단 최대 16 KiB이다.
- data 깊이 5, 배열 20개, 객체 30개, 개별 문자열 1024자로 제한한다. 초과분은 `[TRUNCATED]` 또는 `truncated: true`로 표시한다.
- request/response/body/payload/user/context/extra/header/cookie/URL/route 및 비밀·개인정보 관련 키를 버린다. 나머지 문자열도 배포 secret 원문, 인증값, key=value 비밀, URL, 이메일, IP, 긴 opaque 값 패턴을 마스킹한다.
- 마스킹은 알려진 키·패턴에 대한 방어이며 임의 자연어 개인정보를 완벽하게 감지하지 못한다. 생산 telemetry 자체에 비밀·민감 요청 내용을 넣지 않는다. 마스킹 이후에도 문자열은 공격자가 통제할 수 있는 **자료**이며 지시가 아니다. 공개 GitHub 이슈에 전문을 게시하지 않는다.
- 진단은 7일 뒤 읽기가 차단되고 DO alarm이 원문 열을 비운다. 중복 방지 식별자/성공 tombstone은 유지한다. 중복 재전달이 진단 보존 기간을 연장하거나 덮어쓰지 않는다.

## 재시도와 중복 방지

source + 조직/프로젝트 또는 계정/정책/Worker + sourceId별 진단 DO가 진행 중 웹훅 요청 하나의 Promise를 공유한다. 진단을 SQLite에 저장·sync한 뒤 고정 저장소 큐에 등록하고 그 수락을 저장한 후 응답한다. 큐 장애는 503 및 `Retry-After: 30`으로 재전달을 요청한다. 과거 Actions의 `accepted_at`은 큐 등록 증거가 아니므로 새 `queue_admitted_at`을 별도 사용한다. 진단 만료·중복 전달은 기존 작업을 새로 모델 실행시키지 않는다.

큐는 최대 100건 대기, 동시에 하나의 lease만 허용한다. 기한/heartbeat 상실은 실패로 닫고 모호한 실행을 자동 중복 발행하지 않는다. 결과 응답 유실 시 같은 lease/outcome으로 이미 완료된 결과만 다시 확인할 수 있다. 이슈 marker와 `fix/#<issue>/<source>-<sourceId>` 브랜치, 고정 base SHA/트리 검사를 유지한다. GitHub issue/PR 발행 도중 실패하면 운영자가 기존 브랜치·PR을 조사해야 하며 force push하지 않는다.

## 로컬 검증

```sh
pnpm --dir apps/error-automation typecheck
pnpm --dir apps/error-automation test
pnpm --dir apps/error-automation exec wrangler deploy --dry-run
```

`ERROR_AUTOMATION_ORIGIN`을 승인·배포된 HTTPS Worker origin으로, `CLOUDFLARE_WEBHOOK_SECRET`을 해당 전용 비밀로 안전하게 제공한 뒤 `pnpm --dir apps/error-automation smoke:local`을 실행할 수 있다. 이 명령은 인증된 공식 설정 probe의 204만 검사하며 실제 오류/모델/PR을 만들지 않는다. Node 24 테스트는 `node:sqlite`로 실제 SQL, 서명/범위/진단 privacy/만료, 큐 lease/재시도, 모델 proxy 고정 계약을 검사한다. 테스트 mock이나 probe만으로 실제 Sentry/Issues delivery, Rocky Docker 격리, Anthropic 호출 또는 GitHub PR 성공을 주장하지 않는다.

## 공식 근거

- [Cloudflare Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/)
- [Generic webhook secret / test payload](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/)
- [Notifications webhook payload schema](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/)
- [Sentry webhook 서명](https://docs.sentry.io/integrations/integration-platform/webhooks/)
- [Sentry issue 생성/회귀](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)
- [Sentry event alert](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
- [GitHub App installation token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app), [Git refs/trees/PR](https://docs.github.com/en/rest/git/refs)
- [SQLite DO migration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
