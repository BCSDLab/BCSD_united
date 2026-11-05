# 오류 자동 수정 웹훅과 전용 실행기

`bcsd-error-automation` Worker는 Sentry 브라우저 오류와 Cloudflare Issues Worker/API/SSR 알림을 인증한다. 진단을 source별 SQLite Durable Object에 먼저 저장하고, 고정 저장소의 `AutofixQueue` DO에 중복 없이 등록한다. GitHub Actions `repository_dispatch` 또는 Cloudflare 유료 Container/Workflow로 후보 코드를 실행하지 않는다. 고정 등록된 Rocky/UMPC 실행기가 **아웃바운드 HTTPS로만** 작업을 요청한다. 실제 호스트 서비스 설치·비밀 등록·배포·GitHub PR 발행은 별도 운영 승인과 통합 검증 전에는 완료된 것으로 간주하지 않는다.

## 고정 배포와 권한

`wrangler.jsonc`는 `ENVIRONMENT=production`, `GITHUB_OWNER=BCSDLab`, `GITHUB_REPOSITORY=BCSD_united`, 단일 GitHub App ID `5522353`/설치 ID `176455083`, `AUTOFIX_EXECUTOR_ID=koin-rocky-umpc`를 고정한다. Preview URL은 비활성화하며 다른 저장소·App·설치·환경으로 자동화를 바꾸는 입력은 없다. 운영 외 배포는 503으로 닫힌다. 이 Worker에 대한 PR preview/별도 GitHub Actions 실행 경로를 자동화 진입점으로 사용하지 않는다.

설정값:

| 이름                                          | 의미                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_ORGANIZATION` / `SENTRY_PROJECT_APPS` | 허용 조직과 `{"koin-united-prod":"web","koin-united-preview":"web"}`처럼 브라우저 프로젝트만 매핑                                                               |
| `SENTRY_PROJECT_HOSTS`                        | 기존 `koreatech.in`/`stage.koreatech.in`과 실제 확인된 `koin-web.bcsdlab.workers.dev`/`preview-koin-web.bcsdlab.workers.dev`만 각 프로젝트의 경로 호스트로 허용 |
| `CLOUDFLARE_SOURCES`                          | 실제 Issues policy의 accountId/policyId/workerName/app 정확한 매핑. 고정 계정의 `koin-web`/`koin-api`만 등록; 미설정이면 `[]`                                   |
| `ERROR_PROJECT_DOMAINS`                       | 프로젝트별 GitHub 이슈 제목 분류. 허용 값은 `캠퍼스`, `비즈니스`, `유저`, `공통`                                                                                |
| `AUTOFIX_EXECUTOR_ID`                         | `koin-rocky-umpc`만 허용. 이벤트나 요청 본문에서 변경 불가                                                                                                      |
| `PR_REVIEW_ENABLED`                           | 기본 `"false"`. 정확히 문자열 `"true"`일 때만 `/executor/pull-requests/*` 입력을 받는다                                                                         |
| `PR_REVIEW_ALLOWED_PRS`                       | 기본 `""`. 쉼표로 구분한 명시적 PR 번호만 리뷰 대상. 비어 있으면 어떤 PR도 받지 않는다                                                                          |

`CLOUDFLARE_SOURCES`에는 BCSD 계정 `abe06b869950de952decf9df29c6f1a3`의 실제 Issues policy `3bcbfa2a0c04416ca7e3da038f77ac37`와 명시적 `koin-web:web`/`koin-api:api` 쌍만 등록한다. 두 Worker의 발생 1회 규칙은 같은 `KOIN Issues Autofix` destination/policy를 공유한다. 정책·Worker 쌍은 계정 전체에서 유일해야 하며, 서명된 제공자 알림의 정확히 한 `data.issue.services[].name`과 일치하지 않으면 거부한다. `text`/제목/임의 `data` 값에서 Worker를 추측하지 않는다.

비밀은 운영 담당자가 승인 뒤 대화형 명령으로 등록한다. 값을 저장소·명령 인자·로그에 남기지 않는다:

```sh
pnpm --dir apps/error-automation exec wrangler secret put SENTRY_CLIENT_SECRET
pnpm --dir apps/error-automation exec wrangler secret put SENTRY_READ_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put CLOUDFLARE_WEBHOOK_SECRET
pnpm --dir apps/error-automation exec wrangler secret put CLOUDFLARE_DIAGNOSTICS_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put DIAGNOSTICS_READ_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put GITHUB_DISPATCH_APP_PRIVATE_KEY
pnpm --dir apps/error-automation exec wrangler secret put AUTOFIX_EXECUTOR_TOKEN
# 모델 upstream: 운영자 로컬 omp auth-gateway 브리지. 둘 다 설정해야 추론이 가능하다.
pnpm --dir apps/error-automation exec wrangler secret put OMP_GATEWAY_ORIGIN
pnpm --dir apps/error-automation exec wrangler secret put OMP_GATEWAY_TOKEN
```

`SENTRY_CLIENT_SECRET`는 Sentry 웹훅 서명, `SENTRY_READ_TOKEN`은 Sentry canonical issue/event 조회에만 사용한다. `CLOUDFLARE_WEBHOOK_SECRET`는 Issues Generic Webhook의 `cf-webhook-auth`와 같은 32자 이상 전용 무작위 값이다. `CLOUDFLARE_DIAGNOSTICS_TOKEN`은 BCSD 한 계정의 Workers Observability Write(공식 조회 API도 이 권한 요구)와 **koin-web/koin-api 두 Worker만** Individual Workers Content Read-Only를 가진 별도 토큰이다. 배포/쓰기 명령에는 사용하지 않고, 고정 Cloudflare API 호스트의 승인된 두 서비스 증거 조회에만 사용한다. `DIAGNOSTICS_READ_TOKEN`은 허용 scope의 진단 GET 전용 32자 이상 값이다. `AUTOFIX_EXECUTOR_TOKEN`은 별도 32자 이상 값으로 **Rocky 전용 실행기와 Worker만** 공유한다. 다른 서비스의 광범위한 제어 토큰을 재사용하지 않고, 해당 호스트에 외부 인바운드 포트를 열지 않는다. Worker는 provider API 키를 갖지 않으며 `ANTHROPIC_API_KEY` 경로는 제거되었다.

`OMP_GATEWAY_ORIGIN`/`OMP_GATEWAY_TOKEN`은 운영자의 로컬 `omp auth-gateway stdio` 브리지(임시 Cloudflare Tunnel 뒤, 127.0.0.1 바인딩, 전용 bearer, omp 쪽 인증은 운영자 계정의 auth 로그인)를 가리키는 **유일한** 모델 upstream이다. 둘 다 없으면 접수·진단·큐는 그대로 동작하고 모델 호출만 `omp gateway not configured`로 실패한다. 둘 중 하나라도 있으면 둘 다 유효해야 한다: origin은 자격 증명·경로·query·fragment·끝 슬래시·기본 포트가 없는 소문자 HTTPS origin(`new URL(origin).origin === origin`)이고, 토큰은 헤더에 안전한 32~512자다. 잘못되거나 반쪽만 있는 설정은 `configuration()`에서 503으로 닫힌다. Worker는 고정 model/system/tools/max_tokens 본문을 `POST <origin>/v1/messages`에 `Authorization: Bearer <OMP_GATEWAY_TOKEN>`으로만 보내고(`x-api-key`·`anthropic-version` 없음), 리디렉션·응답 모델 불일치(`anthropic/claude-…` 같은 provider 접두 포함)·비정상 상태는 그대로 실패다. 브리지 실패 뒤 다른 upstream·계정·키로 재시도하지 않는다. 토큰은 다른 secret과 함께 진단·이슈 본문에서 마스킹된다. 이 bearer는 provider 키가 아니라 브리지 접근 토큰이며 실행기·후보 소스·Docker에 전달하지 않는다.

기존 `GITHUB_DISPATCH_APP_*` 이름은 이미 저장된 **단일** App 키/ID/설치 ID를 가리키는 현재 배포 설정명이다. Actions dispatch 권한이나 두 번째 App을 뜻하지 않는다. Worker가 `BCSDLab/BCSD_united` 하나로 축소한 read 토큰(contents/issues/pull requests read)과 발행 단계 write 토큰(contents/issues/pull requests write)을 별도로 발급한다. 키와 발급 토큰은 모델/실행기/DO 저장소에 전달하지 않는다. 배포 시 기존 secret을 조용히 삭제·이름 변경하지 않는다.

Worker의 외부 HTTP 호출은 `redirect: "manual"`과 비정상 상태 거부를 함께 사용합니다. workerd는 `"error"` 모드를 지원하지 않으며, 자동 리디렉션으로 GitHub·모델 자격 증명을 다른 호스트에 보내지 않습니다. 접수 실패 로그에는 단계·고정 오류 분류·코드 위치만, 모델 거부에는 상태·오류 종류·고정 분류만 남기고 원문 요청/응답과 키는 기록하지 않습니다.

모델 tier는 저장된 job mode가 서버에서 결정한다: 오류 수정은 `claude-sonnet-5-5`, 여러 파일을 읽고 고치는 PR 검토는 `claude-opus-5-5`다(`MODEL_BY_MODE`). 실행기는 claim한 작업의 tier를 그대로 되돌려 보내야 하며 다른 모델·별칭·날짜 접미사·provider 접두 id는 `parseModelRequest`와 큐의 mode 검사에서 거부된다. sampling 매개변수는 보내지 않는다. assistant의 `thinking`/`redacted_thinking` 블록은 역할·크기를 검증한 뒤 서명과 원문을 바꾸지 않고 다음 요청에 전달한다. 추론 블록은 도구 명령으로 실행하거나 PR 댓글로 게시하지 않는다. 계정의 모델·데이터 보존 요건이 충족되지 않으면 자동으로 계정 설정이나 모델을 변경하지 않고 실패한다.

`v1` migration의 `ErrorIssueDispatch` 클래스/`ERROR_ISSUES` binding은 기존 진단과 중복 기록을 유지한다. `v2`는 저장소별 `AutofixQueue` SQLite DO를 추가한다. 기존 `accepted_at`은 과거 Actions 수락 시각으로 보존하고 새 `queue_admitted_at`을 별도 추가하므로 과거 수락이 새 실행기 등록을 막지 않는다. 이미 배포한 migration을 제거하거나 상태를 초기화하지 않는다.

## Cloudflare Issues 입력 계약

Issues의 **Generic Webhook** destination URL은 `https://<운영 호스트>/webhooks/cloudflare`이다. Cloudflare는 Secret을 `cf-webhook-auth` 헤더로 전송한다. **Cloudflare 요청 본문 HMAC 서명이 아니다.** Worker는 Web Crypto HMAC 검증 primitive로 secret 동등성을 비교하여 문자열의 일치 위치에 따른 조기 비교 종료를 피한다. HTTPS와 secret의 기밀성이 인증 경계이며, 유효한 secret을 가진 발신자의 임의 본문 변경까지 검출하는 서명은 제공되지 않는다.

[Issues automation 공식 문서](https://developers.cloudflare.com/workers/observability/issues/automations/)가 보장하는 [표준 Notifications envelope](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/)를 사용한다.

필수 native Issues 필드:

- `policy_id`: 실제 `KOIN Issues Autofix` 알림 policy UUID
- `alert_correlation_id`: 알림 묶음 UUID이며 이슈 ID로 쓰지 않는다
- `account_id`: 표준 Notifications 유형에 따라 생략될 수 있다. 있으면 고정 계정과 정확히 일치해야 한다. 없으면 계정 전용 인증 secret과 유일한 policy/Worker 쌍으로만 계정을 정한다
- `alert_type`: 비어 있지 않은 100자 이하 영숫자/`_`/`.`/`-` 식별자
- `ts`: 0 이상의 안전한 정수 Unix 초
- `text`: 문자열
- `data.issue.id` / `data.issue.services`: 실제 Issues 알림에서 확인한 canonical 이슈 UUID와 서비스 배열. 단일 `services[0].name`이 등록된 Worker여야 한다. 여러 서비스/누락/외부 Worker는 거부한다

UUID는 소문자 32자리 hex 또는 표준 하이픈 표기를 받고 저장/큐 등록 전에 하이픈 없는 32자리로 정규화한다. `alert_event`는 선택적 문자열이며 알려진 `ALERT_STATE_EVENT_END`는 인증·식별 검증 후 무시한다. 요청 본문은 1 MiB까지 받는다.

공식 `workers_alert`/`workers_observability_alert` 예시는 Issues payload가 아니다. 2026-10-30에 BCSD 계정의 **실제** koin-web 이슈를 승인된 destination으로 수동 전송해 `data.issue.id`가 대시보드 canonical ID와 같고, `data.issue.services[0].name`이 `koin-web`, `policy_id`가 위 정책 ID, `account_id`가 생략됨을 확인했다. 이 필드는 현재 native Issues 알림에서 검증한 계약이며 공개 문서의 고정 schema는 아니다. 제공자가 형식을 바꾸면 다른 필드에서 Worker/이슈를 추측하지 않고 닫힌다. 해당 수동 실행의 Cloudflare 활동 `성공`은 Notifications 접수 표시이지, Worker 진단 수락·Rocky lease·GitHub PR 성공의 증거는 아니다.

Cloudflare Generic Webhook의 인증된 설정 확인에는 문서의 `...configured properly.`와 실제 Issues destination wizard에서 관찰한 `...configured correctly.` 두 **정확한** 단일 `text` 메시지만 204로 응답한다. 이 경로는 HTTPS·POST·본문 제한·전용 `cf-webhook-auth`를 먼저 검증하고 진단·큐에 넣지 않는다. 다른 단일 문장이나 추가 필드는 전체 identity/증거 검증을 거친다. 설정 probe 204는 실제 Issues 알림 또는 수정 작업 증거가 아니다.

## Sentry 입력 계약

URL은 `https://<운영 호스트>/webhooks/sentry`이다. 정확한 요청 바이트를 `Sentry-Hook-Signature` HMAC SHA-256으로 검증한다. JSON 재직렬화로 서명을 검증하지 않는다.

지원 이벤트는 `issue/created`, `issue/unresolved` + `substatus: regressed`, `event_alert/triggered`이다. 나머지는 인증 후 무시한다. issue의 `project.slug`와 공식 issue URL로 조직을 확인한다. legacy `/api/0/issues/<id>/`는 `web_url` 또는 `permalink`에서 조직을 확인한다. event alert의 숫자형 project를 slug로 오인하지 않고 공식 event URL의 조직·프로젝트를 검증한다. 이 URL로 네트워크 요청을 보내지는 않는다. Sentry canonical API 조회는 Worker의 신뢰된 준비 작업에서만 수행한다.

## 진단 보관과 아웃바운드 실행 계약

웹훅 인증·고정 account/policy/단일 Worker·canonical 이슈 ID를 검증한 뒤에만 진단을 검토한다. Cloudflare native 알림은 summary만 포함하며 route/소스 프레임을 직접 주지 않는다. 고정 BCSD account의 Issues occurrence read(GET, 현재 대시보드에서 관찰한 beta/비공개 계약), 공식 Workers Observability telemetry query, 정확한 Worker script version metadata와 두 Worker의 Tail 증거를 서로 비교한다. Tail은 `cf-ray`, Worker, 버전, GET, 고정 production hostname/path와 **Cloudflare가 source-map으로 매핑한 앱 소스 위치만** 7일간 전용 DO에 남기고 요청 헤더·본문·쿼리·원문 로그/스택을 저장하지 않는다. 올바른 route/버전/매핑된 `apps/<app>/src` 프레임이 없거나 조회 API 계약이 바뀌면 503으로 재시도를 요청하며 큐·공개 GitHub 이슈를 생성하지 않는다. 기존 이슈의 삭제된 버전에 현재 버전 소스맵을 대입하지 않는다. GitHub issue는 진단 증거 확인 **이후**에만 만든다.

Tail과 canonical occurrence의 route 호스트는 Worker별 정확한 목록만 허용한다: `koin-web`은 `koin-web.bcsdlab.workers.dev`와 운영 커스텀 도메인 `koreatech.in`(정확히 이 호스트, https, 포트/userinfo 없음), `koin-api`는 `koin-api.bcsdlab.workers.dev`뿐이다. `www.`/`stage.` 같은 wildcard나 `api.koreatech.in`은 Worker 신원 호스트로 추가하지 않으며, Tail 호스트와 occurrence 호스트가 서로 다른 허용 호스트여도 route 경로는 같아야 한다. 이는 DNS/커스텀 도메인 전환 자체가 아니라 전환 이후 증거 수용 범위이다.

Rocky/UMPC의 전용 실행기는 고정 HTTPS Worker origin으로 `X-Executor-Id: koin-rocky-umpc`, 전용 Bearer `AUTOFIX_EXECUTOR_TOKEN`을 보내며 인바운드 서버·임의 작업 URL을 열지 않는다. `POST /executor/claim`은 사전 영속한 `claimNonce`(64자리 hex)로 작업을 요청한다(204: 작업 없음, 200: 고정 SHA/진단/lease). 응답 유실 때 **같은 nonce**로 같은 작업/lease를 복원한다. claim 응답(`version:1`)은 `runId, leaseToken, attempt, deadlineAt, leaseExpiresAt, job`을 담는다. `leaseExpiresAt`은 필수 ms epoch 정수로 새 claim에서는 방금 부여한 2분 lease 만료, 같은 nonce로 복원한 claim에서는 **저장된 실제 현재 만료**(이미 heartbeat로 연장된 값이든 짧아진 값이든)이며 복원이 lease를 연장하지 않는다. 만료된 lease는 복원하지 않고 204로 닫는다. `POST /executor/jobs/<runId>/heartbeat`는 살아 있는 lease에서만 2분 rolling lease를 갱신해 `{deadlineAt, leaseExpiresAt}`을 돌려주되 절대 90분 기한을 넘기지 못하고, 만료된 lease는 연장하지 않고 거부한다. 실행기는 서버가 마지막으로 확인한 `leaseExpiresAt`만 신뢰해야 하며 실패한 heartbeat가 lease를 연장했다고 가정해서는 안 된다. 하나의 저장소 큐에서 진행 작업은 최대 하나이며 중복/만료 작업을 조용히 재실행하지 않는다.

`POST /executor/jobs/<runId>/model`은 살아 있는 generation lease에서만 가능하다. Worker가 `OMP_GATEWAY_TOKEN`을 보관하고 job mode가 정한 모델(오류 수정 `claude-sonnet-5-5`, PR 검토 `claude-opus-5-5`)/정적 source-only system/Read·Edit·Write·Glob·Grep JSON schema로만 omp gateway의 `/v1/messages`에 요청한다. 실행기 요청은 정확한 model/messages/다섯 tool 이름/maxTokens/lease만 담고 model은 claim한 작업의 tier와 같아야 한다. 임의 provider URL·헤더·system·서버 도구는 받지 않는다. 인증된 HTTP 본문은 최대 1 MB이며, 저장된 job mode에 따라 요청 모양을 다시 제한한다: 오류 수정은 256 KB·80개 메시지, PR 검토는 1 MB·160개 메시지. 응답은 256 KB까지다. 후보 환경에는 GitHub/gateway 키가 없다.

**작업당 모델 예산**(`MODEL_BUDGET`)은 저장소 큐 SQLite `jobs` 행의 `model_calls`/`model_started_at`/`model_input_tokens`/`model_output_tokens`에 영속되어 재시작·동시 호출·전송 실패로 초기화되지 않는다. 오류 수정: 최대 6회 호출, 첫 호출부터 4분 generation 창, 누적 입력 50,000 tokens, 누적 출력 8,000 tokens, 호출당 `maxTokens` ≤ 4,096. PR 검토: 12회, 8분, 150,000 입력, 16,000 출력, 호출당 ≤ 8,192. 호출 전에 입력(실제 전송 JSON 본문의 UTF-8 바이트당 1 token + 1,024 tokens 고정 여유)과 출력(전달할 `max_tokens`)을 하나의 조건부 UPDATE로 예약하고 `sync()`한 뒤에야 upstream을 호출한다. 전달 `max_tokens`는 남은 출력 예산으로 잘라 보내며(응답이 `stop_reason: max_tokens`로 끝날 수 있다) 남은 출력이 0이면 거부한다. 성공 응답의 `usage`가 신뢰 가능한 음이 아닌 정수(`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, `output_tokens`; 입력 0은 불신)일 때만 예약을 실제 값으로 바꾸고, 아니면(전송 실패 포함) 예약을 그대로 소비한다. 바이트 기반 입력 추정은 보수적 admission 기준이지 provider 과금 보장이 아니다(gateway가 덧붙이는 컨텍스트는 고정 여유로만 반영된다). 예산·tier·모양 위반은 `PolicyRejection`으로 Worker가 **422**(`Retry-After` 없음)로 내려보내는 종결 오류이며 같은 head/base에 대한 예산 초기화·재등록·다른 모델/계정으로의 승격은 없다. 호출당 upstream 대기는 PR 180초·오류 90초 상한에 **남은 generation 창**을 함께 적용하므로(본문 읽기 포함) 창 끝에서 시작한 호출이 추가로 180초를 쓰지 않는다. 90분 lease 기한과 검증 단계 예산은 그대로다.

비스트리밍 모델 응답 대기는 PR 모드 최대 180초, 오류 수정 최대 90초다. 전달 실패·본문 중단 등은 오류 클래스와 경과 시간만 기록하고 예외 메시지·응답 본문은 노출하지 않는다. 실행기는 이보다 짧은 남은 generation 기한과 lease 취소를 함께 적용한다.

omp gateway가 429 `rate_limit_error`를 돌려주면 Worker는 본문을 읽기 전에 `retry-after` 헤더를 확인한다. [Anthropic 문서](https://platform.claude.com/docs/en/api/rate-limits)대로 이 헤더는 기다릴 초이며, 음이 아닌 십진수(소수는 올림, 서버가 `0`이면 최소 1초, 최대 3600초)일 때만 신뢰한다. HTTP-date·부호·지수·3600 초과 값은 무효다. 유효한 헤더가 있고 `error.details.error_code`가 `enforced_spend_limit_reached`가 아닐 때만 큐 DO가 `ModelRateLimited`(`name`, 정수 `retryAfterSeconds`)를 던지고, Worker는 RPC 경계를 넘어 재구성된 이 오류를 `instanceof`가 아니라 `name === 'ModelRateLimited'`와 정수 `retryAfterSeconds`(1~3600)로 구조적으로 판별해 `429` + `Retry-After: <정수 초>` + `Cache-Control: no-store` + `{error, retryAfterSeconds}`로 응답한다. 헤더가 없거나 무효한 429(현재 stdio 브리지는 헤더를 전달하지 않으므로 항상 이 경우다), 지출 한도 429(헤더가 위조돼도), 401/403/400/502/503/529, 리다이렉트는 일반 503으로 종결되며 지연을 추정하지 않는다. 429로 끝난 요청도 job의 호출 횟수와 예약된 입력/출력 예산을 그대로 소비하고 generation 창·lease는 바뀌지 않는다. 로그에는 HTTP 상태, 허용 목록의 `error.type`/`error_code`(그 밖의 코드는 `unlisted`), 계산된 `retryAfterSeconds`, `retryable`만 남기고 provider 원문 메시지·request id·토큰은 남기지 않는다. 실행기는 같은 요청을 `Retry-After` 이상 기다린 뒤 남은 generation 창과 호출 예산 안에서만 다시 보내며, 422는 재시도하지 않는다.

`POST /executor/jobs/<runId>/verification-start`는 generation을 원자적으로 닫고 별도 검증 단계로 전환한다. 이후 모델 요청은 거부한다. 실행기는 독립적인 새 검증 작업공간과 격리된 disposable Docker 실행으로 실제 수정 전 assertion 실패/수정 후 통과, 필수 native/security suites, 타입/lint/build, API+D1/SSR/Chromium(390px 포함)을 확인한다. `POST /executor/jobs/<runId>/result`의 성공은 lease+base SHA+manifest SHA256+정확한 필수 check 목록과 verified manifest bytes가 일치할 때만 PR 발행으로 이어진다. 모델 발언이나 빈 patch를 검증 완료로 처리하지 않는다. 고정 기본 브랜치가 전진하면 발행하지 않고, 기존 브랜치/PR을 덮어쓰거나 자동 merge/배포하지 않는다. 증거가 없는 제공자 이벤트는 공개 이슈 자체를 만들지 않고, 증거를 통과한 뒤 실행 중 실패한 작업만 기존 이슈에 사실을 남긴다.

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

## 고정 저장소 PR 리뷰 모드 (선택적)

오류 경로와 별개로, 같은 큐 DO·같은 실행기 인증(`X-Executor-Id`/`AUTOFIX_EXECUTOR_TOKEN`)·같은 단일 lease를 공유하는 `mode: 'pull-request'` 작업이 있다. 기본은 닫혀 있고 `PR_REVIEW_ENABLED="true"`와 `PR_REVIEW_ALLOWED_PRS` 목록을 **둘 다** 설정해야 한다. 요청은 저장소/모델/URL/프롬프트/경로 범위를 전달하지 못하며 고정 `BCSDLab/BCSD_united`의 PR 번호와 두 SHA만 지명한다.

- `POST /executor/pull-requests/enqueue` `{version:1, executorId:'koin-rocky-umpc', pullNumber, headSha, baseSha}` → `200 {status:'queued'|'duplicate', runId}`. `runId = 'autofix-' + sha256('github-pr/<번호>/<headSha>/<baseSha>')`로 두 SHA가 모두 내구 키에 포함된다. Worker는 read 토큰으로 canonical GitHub를 조회해 같은 저장소·fork 아님·open·non-draft·base `develop`·head ref가 `main`/`preview`/`develop`이 아님·현재 head SHA와 **실제 develop tip**이 요청 pin과 정확히 같음을 확인한다. 비활성 503, 허용 목록 밖/fork/draft/closed/보호 ref/base 불일치 403, pin 불일치 409. 입력 단계는 GitHub에 아무것도 쓰지 않는다.
- `POST /executor/pull-requests/status` `{version:1, executorId, runId}` → 토큰/소스 없는 내구 영수증 `{runId, pullNumber, headSha, baseSha, status, outcome, attempt, enqueuedAt, result:{reviewedHeadSha, publishedHeadSha, decision, findingsCount, passedChecks, commentUrl}|null}`; 모르는/오류 모드 run은 404.
- claim 응답의 job은 `{mode:'pull-request', owner, repository, pullNumber, headSha, headTree, headRef, baseBranch:'develop', baseSha, changedFiles, reviewContext}`이다. `changedFiles`는 canonical `pulls/N/files` 파일명(최대 500개/64 KB), `reviewContext`는 `{version:1, title, body, comments}`로 canonical PR 제목(300자)/본문(2000자)과 reviews/review comments/issue comments(최대 50건/32 KB, 본문 2000자, 제어문자·비밀·이메일 마스킹, 자동화 자신의 댓글 제외)를 담는다. 모두 요청자가 아닌 GitHub에서 읽은 **신뢰할 수 없는 자료**이며 경로나 권한을 결정하지 않는다. `baseSha`는 실제 develop SHA이고 head와 같을 수 없다. 기존 오류 작업은 `mode` 없이 그대로다.
- `/model`은 PR 전용 정적 system prompt(리뷰 기준은 PR head, 제목/본문/diff/댓글은 자료, 기존 댓글은 코드로 검증할 가설, 전체 페이지→SPA 전환 시 상태 초기화·상위/하위 라우트와 데스크톱/모바일 접근 일관성·SSR/인증/쿠키 계약 같은 일반 불변식 점검)을 쓰고 모델은 `claude-opus-5-5`(오류 수정은 `claude-sonnet-5-5`)이며 다섯 파일 도구·호출 한도는 동일하다. 리뷰 댓글 제목에도 실제 사용한 Opus id를 표기한다.
- 결과는 `outcome:'pr-reviewed'` + `manifest`(0~24개, 빈 manifest는 PR 모드에서만 허용되고 그래도 검증 단계를 거쳐야 한다) + `review {decision:'approved'|'changes-requested', findings[{severity P1|P2|P3, path, line, message}]}` + `verification {headSha, baseSha, manifestSha256, passedChecks}`. `passedChecks`는 정확히 `['pr-head-pinned','native-fixture-tests','typecheck','autofix-security-tests','lint','build','runtime-route-smoke']`여야 하고, approved는 P1/P2 finding이 없을 때만, changes-requested는 finding이 하나 이상일 때만 유효하다. 'no-fix'/'verified'는 PR 작업에서, 'pr-reviewed'는 오류 작업에서 422로 거부된다. 큐 DO의 정책 거부(`PolicyRejection`)는 RPC 경계를 넘으면서 prototype이 아니라 `name`/`message`만 남는 일반 Error로 재구성되므로 Worker는 `name === 'PolicyRejection'`으로 구조적으로 판별해 종결 422로 내려보내며, 같은 payload 재시도는 성공할 수 없다. finding의 `path`/`message`는 한 줄 필드로 CR/LF/탭/행·단락 구분자를 공백 하나로 접고(제어문자 제거, 300/1000자 제한), 증거 댓글에 넣을 때 code span 안의 backtick은 제거하고 message의 `&`·`<`·`>`·backtick은 HTML entity로 바꿔 모델 출력이 댓글의 섹션·code span·HTML을 위조하지 못하게 한다. 수정 경로는 `changedFiles`에 등장하는 `apps/<x>/`·`packages/<x>/` 아래 소스/테스트/문서만 허용하고 `.github`, lockfile/package.json/workspace/.npmrc, wrangler/tsconfig/*.config, Dockerfile, 셸 스크립트, `scripts/`, `apps/error-automation`, `tests/autofix`, generated 파일, 비밀을 금지한다. 설정 변경은 리뷰 대상이지만 수정 권한은 없으며 모델은 차단됨을 finding으로 보고해야 한다.
- 발행 전 canonical PR을 다시 읽어 head/base/ref가 리뷰 시점과 같지 않으면 아무것도 쓰지 않고 `outcome:'pull-request-stale'`(응답 `{status:'recorded', outcome:'pull-request-stale'}`)로 닫는다. manifest가 있으면 각 파일의 `before`가 pinned head의 실제 일반 파일 내용 sha256과 일치해야 하고(symlink/불일치 거부, 새 파일은 존재하지 않아야 함) `headSha`를 부모로 `fix: PR #<번호> 자동 리뷰 수정` 커밋을 만들어 현재 head ref를 `force:false`로만 전진시킨다. 사람이 그 사이 push했으면 거부한다. 빈 manifest는 head를 유지한다. 그 뒤 `<!-- pr-review:<번호>:<headSha>:<baseSha>:<manifestSha256> -->` marker가 있는 증거 댓글(리뷰/발행 head, base, manifest 해시, 판정, finding, 적용 파일, 통과 check)을 GitHub App 봇으로 한 번만 남긴다. 응답 유실 후 중복 방지는 `bcsd-united-error-publisher[bot]`(`type: Bot`, `performed_via_github_app.id` 5522353)이 쓴 정확히 같은 marker 댓글만 인정하며, 사람이나 다른 앱이 위조한 marker는 봇 리뷰를 억제하지 못한다. 승인/merge/배포는 하지 않으며 merge는 운영자가 발행된 정확한 head와 녹색 CI를 확인한 뒤 수동으로 한다.

활성화와 상태 확인(승인된 운영 배포에서만):

```sh
# 1) 현재 승인 목록으로 wrangler.jsonc vars를 바꾼 뒤 배포 (기본값은 false / 빈 목록)
#    "PR_REVIEW_ENABLED": "true", "PR_REVIEW_ALLOWED_PRS": "3,7,9,13,14,15,16"
pnpm --dir apps/error-automation exec wrangler deploy
# 2) 실행기 자격으로 PR 하나를 pin 하여 등록
curl -sS -X POST "$ERROR_AUTOMATION_ORIGIN/executor/pull-requests/enqueue" \
  -H 'Content-Type: application/json' -H 'X-Executor-Id: koin-rocky-umpc' \
  -H "Authorization: Bearer $AUTOFIX_EXECUTOR_TOKEN" \
  -d '{"version":1,"executorId":"koin-rocky-umpc","pullNumber":3,"headSha":"<현재 head 40hex>","baseSha":"<현재 develop 40hex>"}'
# 3) 내구 영수증 조회
curl -sS -X POST "$ERROR_AUTOMATION_ORIGIN/executor/pull-requests/status" \
  -H 'Content-Type: application/json' -H 'X-Executor-Id: koin-rocky-umpc' \
  -H "Authorization: Bearer $AUTOFIX_EXECUTOR_TOKEN" \
  -d '{"version":1,"executorId":"koin-rocky-umpc","runId":"autofix-<sha256(github-pr/3/<headSha>/<baseSha>)>"}'
# 4) 처리 후 다시 닫기: PR_REVIEW_ENABLED "false", PR_REVIEW_ALLOWED_PRS "" 로 되돌려 배포
```

`#7`처럼 base가 `develop`이 아닌 PR은 base가 바뀌기 전까지 403이며, 허용 목록에 있어도 현재 head/develop SHA가 pin과 다르면 409로 다시 pin 해야 한다.

## 로컬 검증

```sh
pnpm --dir apps/error-automation typecheck
pnpm --dir apps/error-automation test
pnpm --dir apps/error-automation exec wrangler deploy --dry-run
```

`ERROR_AUTOMATION_ORIGIN`을 승인·배포된 HTTPS Worker origin으로, `CLOUDFLARE_WEBHOOK_SECRET`을 해당 전용 비밀로 안전하게 제공한 뒤 `pnpm --dir apps/error-automation smoke:local`을 실행할 수 있다. 이 명령은 인증된 공식 설정 probe의 204만 검사하며 실제 오류/모델/PR을 만들지 않는다. Node 24 테스트는 `node:sqlite` 실제 SQL과 Tail handler→DO→인증된 Issues webhook→queue의 격리된 경로를 실행하며 제공자 조회 응답과 gateway 응답만 테스트 fixture로 대체한다. 따라서 테스트/설정 probe만으로 실제 mapped stack, Rocky lease, omp gateway 모델 호출 또는 GitHub PR 성공을 주장하지 않는다.

운영 증거 상태(2026-10-30): 두 Issues 발생 1회 규칙과 공통 Generic Webhook은 실제 대시보드에서 생성·활성화되었다. Rocky executor의 인증된 `POST /executor/claim`은 작업이 없을 때 실제 204로 반복 응답했다. 호스트 `MemAvailable`이 일시적으로 8 GiB 안전 기준 아래로 내려갔을 때 preflight는 claim을 중지했고, 8 GiB 이상 회복 후 nonce 갱신과 폴링이 다시 진행됐다. 6 GiB 검증 컨테이너와 2 GiB controller의 보호 기준을 낮추거나 Home Assistant를 중단하지 않았다. 기존 koin-web 이슈의 수동 발송은 provider 활동과 Worker 도착을 입증했지만, 당시 알림의 summary만으로는 소스 위치가 없어 큐·lease·모델/PR이 생성되지 않았다. 특정 과거 preview 발생은 스크립트 버전 조회가 404이며 현재 버전의 map을 대신 쓰지 않는다. 소스맵으로 매핑된 **새 실제 예외**의 Tail/Issues/telemetry 교차 검증 성공 전까지 자동 수정 완료나 PR 발행을 주장하지 않는다. Worker Previews의 PR 브랜치는 검사만 하고 배포하지 않으며, 운영/Preview 자동 merge는 없다.

운영 연결 확인(2026-11-02): Git Build `332c364`의 Tail handler, `3cde7dd`의 koin-web/koin-api **production 전용** Tail consumer, `56d8077`의 두 정확한 source allowlist가 차례로 배포되었다. 두 생산 Worker 설정에 `bcsd-error-automation` 연결이 표시되고, 허용된 실제 버스 조회 `GET /bus?bus_type=city&depart=KOREATECH&arrival=STATION`은 200이었다. 같은 시각 자동화 Worker의 Cloudflare Observability `trace` 이벤트에 `consumedEvents.scriptName=koin-api`가 기록돼 정상 트래픽의 실제 Tail 전달을 확인했다. Rocky의 claim nonce도 최종 배포 뒤 계속 갱신됐다. 이는 **Tail 연결과 빈 큐 폴링** 증거일 뿐 매핑된 오류 프레임·lease·모델 검증·PR 증거가 아니다. 오류를 인위적으로 만들거나 기존 삭제 버전의 소스 위치를 추정하지 않았다.

## 공식 근거

- [Cloudflare Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/)
- [Generic webhook secret / test payload](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/)
- [Notifications webhook payload schema](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/)
- [Issues 조사·발생 보존 기간](https://developers.cloudflare.com/workers/observability/issues/investigate/), [Tail Worker](https://developers.cloudflare.com/workers/observability/logs/tail-workers/), [source map과 매핑 범위](https://developers.cloudflare.com/workers/observability/source-maps/)
- [Workers Observability query API와 Write 권한](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/), [정확한 Worker 버전 조회](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/)
- [Sentry webhook 서명](https://docs.sentry.io/integrations/integration-platform/webhooks/)
- [Sentry issue 생성/회귀](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)
- [Sentry event alert](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
- [GitHub App installation token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app), [Git refs/trees/PR](https://docs.github.com/en/rest/git/refs)
- [SQLite DO migration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
