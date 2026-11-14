# 오류 자동 수정 웹훅과 전용 실행기

`bcsd-error-automation` Worker는 Sentry 브라우저 오류와 Cloudflare Issues Worker/API/SSR 알림을 인증한다. 진단을 source별 SQLite Durable Object에 먼저 저장하고, 고정 저장소의 `AutofixQueue` DO에 중복 없이 등록한다. GitHub Actions `repository_dispatch` 또는 Cloudflare 유료 Container/Workflow로 후보 코드를 실행하지 않는다. 고정 등록된 Rocky/UMPC 실행기가 **아웃바운드 HTTPS로만** 작업을 요청한다. 실제 호스트 서비스 설치·비밀 등록·배포·GitHub PR 발행은 별도 운영 승인과 통합 검증 전에는 완료된 것으로 간주하지 않는다.

## 고정 배포와 권한

`wrangler.jsonc`는 `ENVIRONMENT=production`, `GITHUB_OWNER=BCSDLab`, `GITHUB_REPOSITORY=BCSD_united`, 단일 GitHub App ID `5522353`/설치 ID `176455083`, `AUTOFIX_EXECUTOR_ID=koin-rocky-umpc`를 고정한다. Preview URL은 비활성화하며 다른 저장소·App·설치·환경으로 자동화를 바꾸는 입력은 없다. 운영 외 배포는 503으로 닫힌다. 이 Worker에 대한 PR preview/별도 GitHub Actions 실행 경로를 자동화 진입점으로 사용하지 않는다.

### Git 자동 배포

운영 정책에서 웹·API·오류 자동화 Worker의 Cloudflare Workers Builds production branch는 모두 `main`이다. 기능 PR은 `develop`에 squash merge되어 stage 검사·배포를 거치고, 승인된 `develop`→`main` merge commit 뒤 production 배포가 시작된다. 이 Worker의 루트 디렉터리는 `apps/error-automation`, 빌드 명령은 `pnpm typecheck && pnpm test`, 배포 명령은 `pnpm deploy`다. 빌드 환경은 Node `24.22.1`·pnpm `12.16.1`로 고정한다. 오류 자동화의 기존 배포·권한 흐름, DNS, 다른 Worker의 런타임 설정은 이 정책만으로 변경되지 않으며 실제 Workers Builds 브랜치 설정은 별도로 확인한다.

다른 브랜치의 Preview 빌드는 검사 후 `printf "Checks only: no deployment for %s\n" "$WORKERS_CI_BRANCH"`만 실행한다. `develop`은 stage 배포·검사 브랜치이며 production 빌드와 구분한다. Preview에 운영 인증 정보를 복사하거나 존재하지 않는 `deploy:preview` 스크립트를 실행하지 않는다.

대시보드의 production 빌드와 branch Preview 빌드는 별도의 Worker tag/빌드 이력을 갖는다. Preview 검사 성공을 운영 배포 성공으로 판단하지 않는다. 실제 production tag는 Workers Scripts 목록의 `bcsd-error-automation`에서 확인하고, 해당 tag의 빌드 로그에 `pnpm deploy` 성공과 새 활성 버전이 기록되는지 확인한다. 실패 이력이나 Worker·DO 데이터는 표시를 없애기 위해 삭제하지 않는다. 로그인 게이트웨이 시크릿은 런타임 설정으로 보존하고 빌드 변수·Git 저장소에는 넣지 않는다.

설정값:

| 이름                                          | 의미                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_ORGANIZATION` / `SENTRY_PROJECT_APPS` | 허용 조직과 `{"koin-united-prod":"web","koin-united-preview":"web"}`처럼 브라우저 프로젝트만 매핑                                                    |
| `SENTRY_PROJECT_HOSTS`                        | `koreatech.in`/`stage.koreatech.in`과 `koin-web.bcsdlab.workers.dev`/`stage-koin-web.bcsdlab.workers.dev`만 각 프로젝트의 경로 호스트로 허용         |
| `CLOUDFLARE_SOURCES`                          | 실제 Issues policy의 accountId/policyId/workerName/app 정확한 매핑. 고정 계정의 `koin-web`/`koin-api`만 등록; 미설정이면 `[]`                        |
| `ERROR_PROJECT_DOMAINS`                       | 프로젝트별 GitHub PR 제목 분류. 허용 값은 `캠퍼스`, `비즈니스`, `유저`, `공통`                                                                       |
| `ERROR_SOURCE_BRANCHES`                       | 오류 출처별 진단·검증 기준 브랜치: 운영 Sentry/Cloudflare `main`, preview Sentry `develop`; 값은 이 둘만 허용하고 등록 프로젝트 누락 시 503으로 닫힘 |
| `AUTOFIX_EXECUTOR_ID`                         | `koin-rocky-umpc`만 허용. 이벤트나 요청 본문에서 변경 불가                                                                                           |
| `PR_REVIEW_ENABLED`                           | 기본 `"false"`. 정확히 `"true"`일 때 PR 리뷰 입력 활성화                                                                                             |
| `PR_REVIEW_AUTO`                              | 기본 `"false"`. `"true"`이면 서명된 GitHub PR 이벤트에서 허용 목록 없이 자동 등록                                                                    |
| `PR_REVIEW_ALLOWED_PRS`                       | 기본 `""`. 실행기 수동 enqueue에만 적용하는 쉼표 구분 PR 번호 목록                                                                                   |

`CLOUDFLARE_SOURCES`에는 BCSD 계정 `abe06b869950de952decf9df29c6f1a3`의 실제 Issues policy `3bcbfa2a0c04416ca7e3da038f77ac37`와 명시적 `koin-web:web`/`koin-api:api` 쌍만 등록한다. 두 Worker의 발생 1회 규칙은 같은 `KOIN Issues Autofix` destination/policy를 공유한다. 정책·Worker 쌍은 계정 전체에서 유일해야 하며, 서명된 제공자 알림의 정확히 한 `data.issue.services[].name`과 일치하지 않으면 거부한다. `text`/제목/임의 `data` 값에서 Worker를 추측하지 않는다.

비밀은 운영 담당자가 승인 뒤 대화형 명령으로 등록한다. 값을 저장소·명령 인자·로그에 남기지 않는다:

```sh
pnpm --dir apps/error-automation exec wrangler secret put SENTRY_CLIENT_SECRET
pnpm --dir apps/error-automation exec wrangler secret put SENTRY_READ_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put CLOUDFLARE_WEBHOOK_SECRET
pnpm --dir apps/error-automation exec wrangler secret put CLOUDFLARE_DIAGNOSTICS_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put DIAGNOSTICS_READ_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put GITHUB_DISPATCH_APP_PRIVATE_KEY
pnpm --dir apps/error-automation exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm --dir apps/error-automation exec wrangler secret put AUTOFIX_EXECUTOR_TOKEN
# 모델 upstream: Rocky omp 게이트웨이. VPC 바인딩 `OMP_GATEWAY`(wrangler.jsonc)와 이 bearer가 함께 있어야 추론이 가능하다.
pnpm --dir apps/error-automation exec wrangler secret put OMP_GATEWAY_TOKEN
# 읽기 전용 모니터: ERROR_MONITOR_TOKEN은 attendance와만, OMP_GATEWAY_MONITOR_TOKEN은 Rocky와만 공유한다.
pnpm --dir apps/error-automation exec wrangler secret put ERROR_MONITOR_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put OMP_GATEWAY_MONITOR_TOKEN
```

`SENTRY_CLIENT_SECRET`는 Sentry 웹훅 서명, `SENTRY_READ_TOKEN`은 Sentry canonical issue/event 조회에만 사용한다. `CLOUDFLARE_WEBHOOK_SECRET`는 Issues Generic Webhook의 `cf-webhook-auth`와 같은 32자 이상 전용 무작위 값이다. `CLOUDFLARE_DIAGNOSTICS_TOKEN`은 BCSD 한 계정의 Workers Observability Write(공식 조회 API도 이 권한 요구)와 **koin-web/koin-api 두 Worker만** Individual Workers Content Read-Only를 가진 별도 토큰이다. 배포/쓰기 명령에는 사용하지 않고, 고정 Cloudflare API 호스트의 승인된 두 서비스 증거 조회에만 사용한다. `DIAGNOSTICS_READ_TOKEN`은 허용 scope의 진단 GET 전용 32자 이상 값이다. `AUTOFIX_EXECUTOR_TOKEN`은 별도 32자 이상 값으로 **Rocky 전용 실행기와 Worker만** 공유한다. 다른 서비스의 광범위한 제어 토큰을 재사용하지 않고, 해당 호스트에 외부 인바운드 포트를 열지 않는다. Worker는 provider API 키를 갖지 않으며 `ANTHROPIC_API_KEY` 경로는 제거되었다.

`OMP_GATEWAY`/`OMP_GATEWAY_TOKEN`이 **유일한** 모델 upstream이다. `OMP_GATEWAY`는 Workers VPC 서비스 `koin-omp-gateway`(`01a1bdd6-d594-76d1-9898-d116f61b6be7`) 바인딩이며, Cloudflare 터널 `koin-omp-gateway-rocky`를 거쳐 Rocky의 `127.0.0.1:43129` 게이트웨이(`scripts/autofix/local-omp-gateway.mjs`, 인증은 Rocky omp auth-broker)로만 연결된다. 공개 hostname은 없다. 둘 다 없으면 접수·진단·큐는 그대로 동작하고 모델 호출만 `omp gateway not configured`로 실패한다. 둘 중 하나라도 있으면 둘 다 유효해야 한다: 바인딩은 `fetch`를 가진 서비스이고, 토큰은 헤더에 안전한 32~512자다. 잘못되거나 반쪽만 있는 설정은 `configuration()`에서 503으로 닫힌다. Worker는 고정 model/system/tools/max_tokens 본문을 바인딩의 `POST /v1/messages`에 `Authorization: Bearer <OMP_GATEWAY_TOKEN>`으로만 보내고(`x-api-key`·`anthropic-version` 없음), 리디렉션·응답 모델 불일치(`anthropic/claude-…` 같은 provider 접두 포함)·비정상 상태는 그대로 실패다. 게이트웨이 실패 뒤 다른 upstream·계정·키로 재시도하지 않는다. 토큰은 다른 secret과 함께 진단·이슈 본문에서 마스킹된다. 이 bearer는 provider 키가 아니라 게이트웨이 접근 토큰이며 실행기·후보 소스·Docker에 전달하지 않는다. Workers Builds 토큰에는 VPC 바인딩을 위한 `Connectivity Directory Bind`가 있어야 한다.

읽기 전용 모니터는 동일 바인딩의 고정 `GET /healthz`를 별도 `OMP_GATEWAY_MONITOR_TOKEN`으로 조회한다. Worker의 `GET /healthz`는 수신 저장소 요약, `GET /healthz/rocky`는 호스트 관측이며 두 경로 모두 `ERROR_MONITOR_TOKEN`으로 인증한다. 수신 요약은 VPC 없이도 동작하고 호스트 조회는 모델·실행기 자격 증명을 필요로 하지 않는다. CPU/RAM·systemd 프로세스 관측과 모델 정상 여부를 혼동하지 않으며 상세 설정·비공개 연결·기한·미확인 상태는 [읽기 전용 모니터 운영 계약](../../scripts/autofix/README.md#읽기-전용-수신-상태rocky-헬스)을 따른다.

기존 `GITHUB_DISPATCH_APP_*`은 단일 고정 App의 설정명이다. 일반 read 토큰(contents/issues/pull requests read)과 발행 write 토큰(contents/issues/pull requests write)은 기존 범위를 유지한다. **자동 merge 판정 전용** `merge-evidence` 토큰만 contents/pull requests/checks/statuses read를 요청한다. 조직 소유자가 아직 Checks/Commit statuses read 권한 변경을 승인하지 않았다면 이 토큰 발급 거절은 리뷰 발행을 막지 않고 `App 권한(checks/statuses) 승인 대기` 사유로 merge만 건너뛴다. App에는 Pull requests write, Contents write, Checks read, Commit statuses read와 Pull request webhook 이벤트가 필요하다. 키와 토큰은 모델·실행기·DO 저장소에 전달하지 않는다. `GITHUB_WEBHOOK_SECRET`은 App webhook과 일치하는 32자 이상 전용 secret이다.

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

공식 `workers_alert`/`workers_observability_alert` 예시는 Issues payload가 아니다. native Issues 알림에서 `data.issue.id`는 대시보드 canonical ID와 같고, `data.issue.services[0].name`은 Worker 이름(`koin-web` 등), `policy_id`는 위 정책 ID다. `account_id`는 보통 생략되며, 포함되면 등록 계정과 일치해야 한다. 이 필드는 관찰된 계약이며 공개 문서의 고정 schema는 아니다. 제공자가 형식을 바꾸면 다른 필드에서 Worker/이슈를 추측하지 않고 닫힌다. Cloudflare 활동의 `성공`은 Notifications 접수 표시일 뿐 Worker 진단 수락·Rocky lease·GitHub PR 성공을 뜻하지 않는다.

Cloudflare Generic Webhook의 인증된 설정 확인에는 문서의 `...configured properly.`와 실제 Issues destination wizard에서 관찰한 `...configured correctly.` 두 **정확한** 단일 `text` 메시지만 204로 응답한다. 이 경로는 HTTPS·POST·본문 제한·전용 `cf-webhook-auth`를 먼저 검증하고 진단·큐에 넣지 않는다. 다른 단일 문장이나 추가 필드는 전체 identity/증거 검증을 거친다. 설정 probe 204는 실제 Issues 알림 또는 수정 작업 증거가 아니다.

## Sentry 입력 계약

URL은 `https://<운영 호스트>/webhooks/sentry`이다. 정확한 요청 바이트를 `Sentry-Hook-Signature` HMAC SHA-256으로 검증한다. JSON 재직렬화로 서명을 검증하지 않는다.

지원 이벤트는 `issue/created`, `issue/unresolved` + `substatus: regressed`, `event_alert/triggered`이다. 나머지는 인증 후 무시한다. issue의 `project.slug`와 공식 issue URL로 조직을 확인한다. legacy `/api/0/issues/<id>/`는 `web_url` 또는 `permalink`에서 조직을 확인한다. event alert의 숫자형 project를 slug로 오인하지 않고 공식 event URL의 조직·프로젝트를 검증한다. 이 URL로 네트워크 요청을 보내지는 않는다. Sentry canonical API 조회는 Worker의 신뢰된 준비 작업에서만 수행한다.

Sentry가 소스맵으로 복원한 `../../src/`·`../../../src/` 경로는 Vite 출력 위치를 기준으로 웹 앱의 `src/` 경로로 정규화한다. `inApp`·프로젝트·SDK·요청 호스트 검증은 그대로 필요하며, 다른 깊이의 상위 경로·다른 앱·외부 URL은 소스 근거로 쓰지 않는다.

## 진단 보관과 아웃바운드 실행 계약

웹훅 인증·고정 account/policy/단일 Worker·canonical 이슈 ID를 검증한 뒤에만 진단을 검토한다. Cloudflare native 알림은 summary만 포함하며 route/소스 프레임을 직접 주지 않는다. 고정 BCSD account의 Issues occurrence read(GET, 현재 대시보드에서 관찰한 beta/비공개 계약), 공식 Workers Observability telemetry query, 정확한 Worker script version metadata와 두 Worker의 Tail 증거를 서로 비교한다. Tail은 `cf-ray`, Worker, 버전, GET, 고정 production hostname/path와 **Cloudflare가 source-map으로 매핑한 앱 소스 위치만** 7일간 전용 DO에 남기고 요청 헤더·본문·쿼리·원문 로그/스택을 저장하지 않는다. 올바른 route/버전/매핑된 `apps/<app>/src` 프레임이 없거나 조회 API 계약이 바뀌면 503으로 재시도를 요청하며 큐에 넣지 않는다. 기존 이슈의 삭제된 버전에 현재 버전 소스맵을 대입하지 않는다. 오류 모드에서는 GitHub 이슈를 생성·검색하거나 댓글을 게시하지 않는다.

번들 복원은 공식 Worker version GET의 `include=modules,sourcemaps` 응답에서 동일 버전의 코드와 소스맵을 함께 읽는다. 버전 응답은 총 32 MiB, 디코딩한 JavaScript 모듈은 8 MiB, 소스맵은 16 MiB까지 허용한다. 번들의 `sourceMappingURL`과 맵의 `file`이 일치해야 하며, Vite의 `../../src/`·`../../../src/` 매핑 결과만 해당 앱의 소스 경로로 정규화한다. 이 정규화는 원시 Tail 스택의 상위 경로를 허용하지 않는다. 원본 코드와 `sourcesContent`는 진단이나 모델 입력에 저장하지 않는다.

Tail과 canonical occurrence의 route 호스트는 Worker별 정확한 목록만 허용한다: `koin-web`은 `koin-web.bcsdlab.workers.dev`와 운영 커스텀 도메인 `koreatech.in`(정확히 이 호스트, https, 포트/userinfo 없음), `koin-api`는 `koin-api.bcsdlab.workers.dev`뿐이다. `www.`/`stage.` 같은 wildcard나 `api.koreatech.in`은 Worker 신원 호스트로 추가하지 않으며, Tail 호스트와 occurrence 호스트가 서로 다른 허용 호스트여도 route 경로는 같아야 한다. 이는 DNS/커스텀 도메인 전환 자체가 아니라 전환 이후 증거 수용 범위이다.

Rocky/UMPC의 전용 실행기는 고정 HTTPS Worker origin으로 `X-Executor-Id: koin-rocky-umpc`, 전용 Bearer `AUTOFIX_EXECUTOR_TOKEN`을 보내며 인바운드 서버·임의 작업 URL을 열지 않는다. `POST /executor/claim`은 사전 영속한 `claimNonce`(64자리 hex)로 작업을 요청한다(204: 작업 없음, 200: 고정 SHA/진단/lease). 응답 유실 때 **같은 nonce**로 같은 작업/lease를 복원한다. claim 응답(`version:1`)은 `runId, leaseToken, attempt, deadlineAt, leaseExpiresAt, job`을 담는다. `leaseExpiresAt`은 필수 ms epoch 정수로 새 claim에서는 방금 부여한 2분 lease 만료, 같은 nonce로 복원한 claim에서는 **저장된 실제 현재 만료**(이미 heartbeat로 연장된 값이든 짧아진 값이든)이며 복원이 lease를 연장하지 않는다. 만료된 lease는 복원하지 않고 204로 닫는다. `POST /executor/jobs/<runId>/heartbeat`는 살아 있는 lease에서만 2분 rolling lease를 갱신해 `{deadlineAt, leaseExpiresAt}`을 돌려주되 절대 90분 기한을 넘기지 못하고, 만료된 lease는 연장하지 않고 거부한다. 실행기는 서버가 마지막으로 확인한 `leaseExpiresAt`만 신뢰해야 하며 실패한 heartbeat가 lease를 연장했다고 가정해서는 안 된다. 하나의 저장소 큐에서 진행 작업은 최대 하나이며 중복/만료 작업을 조용히 재실행하지 않는다.

`POST /executor/jobs/<runId>/model`은 살아 있는 generation lease에서만 가능하다. Worker는 고정 모델/정적 system/다섯 파일 도구만 omp gateway에 중계한다. 오류 수정은 256 KB·80개 메시지, PR 검토는 1 MB·240개 메시지, 응답은 256 KB까지다. PR별 20회 호출·15분 generation 창은 90분 절대 lease 안에서 검증과 발행을 위한 시간을 남긴다. 호출당 8,192 tokens는 로컬 omp 브리지의 상한과 같다.

실행기는 마지막 호출을 답변 전용으로 남기고 직전 호출에서 수정·회귀 테스트를 마치도록 안내한다. 오류 수정 prompt는 예외 재현을 `assert.doesNotThrow`/`assert.doesNotReject`로 감싸고 기대 결과도 확인하도록 명시한다. 단순히 원래 예외로 종료되는 테스트는 독립 검증의 assertion 실패 조건을 통과하지 못한다. 배포 시 이 Worker 계약을 먼저 반영한 다음 Rocky 실행기 이미지를 갱신한다.

**작업당 모델 예산**(`MODEL_BUDGET`)은 SQLite `jobs` 행에 영속되어 재시작·동시 호출·전송 실패로 초기화되지 않는다. 오류 수정: 최대 6회/4분/누적 입력 50,000·출력 8,000 tokens/호출당 4,096. PR 검토: 최대 20회/15분/누적 입력 400,000·출력 32,000 tokens/호출당 8,192. Worker는 전송 전 실제 upstream JSON UTF-8 바이트당 1 token + 1,024 여유 및 전달 `max_tokens`를 조건부 UPDATE로 예약·동기화하고, 신뢰 가능한 사용량에 한해 정산한다. 남은 출력이 부족하면 `max_tokens`를 줄이며, 전송 실패나 사용량 부재는 예약을 소비한다. 요청 1 MB·응답 256 KB, 메시지 240개 한도는 그대로 적용된다. 예산·tier·모양 위반은 종결 422이며, 호출당 PR 180초/오류 90초 대기에도 남은 generation 창을 적용한다. 90분 lease와 독립 검증 예산은 그대로다.

비스트리밍 모델 응답 대기는 PR 모드 최대 180초, 오류 수정 최대 90초다. 전달 실패·본문 중단 등은 오류 클래스와 경과 시간만 기록하고 예외 메시지·응답 본문은 노출하지 않는다. 실행기는 이보다 짧은 남은 generation 기한과 lease 취소를 함께 적용한다.

omp gateway가 429 `rate_limit_error`를 돌려주면 Worker는 본문을 읽기 전에 `retry-after` 헤더를 확인한다. [Anthropic 문서](https://platform.claude.com/docs/en/api/rate-limits)대로 이 헤더는 기다릴 초이며, 음이 아닌 십진수(소수는 올림, 서버가 `0`이면 최소 1초, 최대 3600초)일 때만 신뢰한다. HTTP-date·부호·지수·3600 초과 값은 무효다. 유효한 헤더가 있고 `error.details.error_code`가 `enforced_spend_limit_reached`가 아닐 때만 큐 DO가 `ModelRateLimited`(`name`, 정수 `retryAfterSeconds`)를 던지고, Worker는 RPC 경계를 넘어 재구성된 이 오류를 `instanceof`가 아니라 `name === 'ModelRateLimited'`와 정수 `retryAfterSeconds`(1~3600)로 구조적으로 판별해 `429` + `Retry-After: <정수 초>` + `Cache-Control: no-store` + `{error, retryAfterSeconds}`로 응답한다. 헤더가 없거나 무효한 429(현재 stdio 브리지는 헤더를 전달하지 않으므로 항상 이 경우다), 지출 한도 429(헤더가 위조돼도), 401/403/400/502/503/529, 리다이렉트는 일반 503으로 종결되며 지연을 추정하지 않는다. 429로 끝난 요청도 job의 호출 횟수와 예약된 입력/출력 예산을 그대로 소비하고 generation 창·lease는 바뀌지 않는다. 로그에는 HTTP 상태, 허용 목록의 `error.type`/`error_code`(그 밖의 코드는 `unlisted`), 계산된 `retryAfterSeconds`, `retryable`만 남기고 provider 원문 메시지·request id·토큰은 남기지 않는다. 실행기는 같은 요청을 `Retry-After` 이상 기다린 뒤 남은 generation 창과 호출 예산 안에서만 다시 보내며, 422는 재시도하지 않는다.

`POST /executor/jobs/<runId>/verification-start`는 generation을 원자적으로 닫고 별도 검증 단계로 전환한다. 이후 모델 요청은 거부한다. 오류 작업의 `baseBranch`는 제공자 프로젝트별 고정 `ERROR_SOURCE_BRANCHES`에서 결정한다(`sentry:koin-united-prod`, `cloudflare:koin-web`, `cloudflare:koin-api`는 `main`; `sentry:koin-united-preview`는 `develop`). 해당 브랜치 tip인 `baseSha`로 모델·독립 검증 worktree를 체크아웃하고, PR의 `targetBranch`는 항상 `develop`이다. 실행기는 별도 깨끗한 작업공간과 격리된 disposable Docker 실행으로 실제 수정 전 assertion 실패/수정 후 통과, 필수 native/security suites, 타입/lint/build, API+D1/SSR/Chromium(390px 포함)을 확인한다. `POST /executor/jobs/<runId>/result`의 성공은 lease+base SHA+manifest SHA256+정확한 필수 check 목록과 verified manifest bytes가 일치할 때만 **이슈 없이 직접 PR 발행**으로 이어진다. 모델 발언이나 빈 patch를 검증 완료로 처리하지 않는다. 검증한 출처 브랜치 tip이 전진하면 발행하지 않고, 기존 브랜치/PR을 덮어쓰거나 자동 merge/배포하지 않는다. 수정 커밋은 `baseSha`를 부모로 만들고 `develop`을 PR base로 지정한다. PR 본문에는 출처 브랜치@SHA와 PR 대상 브랜치를 모두 담되 원문 진단은 공개하지 않는다.

오류 모드의 `outcome:'no-fix'`는 `status:'completed', outcome:'wont-fix'`로, 실행·검증의 `outcome:'failed'`는 `status:'failed', outcome:'failed'`로 저장한다. 둘 다 500자 이내의 사유를 기존 진단 마스킹으로 처리하고 GitHub 쓰기 없이 `{status:'recorded', outcome}`을 반환한다. `wont-fix`는 안전하게 검증할 수정안이 없다는 **내부 자동화 결정**이지 오류가 해결됐다는 뜻이 아니다. Cloudflare/Sentry 원본 이슈의 상태는 변경하지 않는다. 같은 lease의 결과 재전달은 멱등적이며 다른 outcome으로 덮어쓸 수 없다. 준비 실패·lease 만료·발행 결과 불명확도 별도 실패로 남기며 `wont-fix`로 위장하지 않는다.

진단 읽기는 `Authorization: Bearer <DIAGNOSTICS_READ_TOKEN>`을 요구한다. query token, 쿠키, CORS 공개 읽기, 목록 조회는 지원하지 않는다.

- `GET /diagnostics/cloudflare/<sourceId>?project=<worker>&accountId=<account>&policyId=<policy>&workerName=<worker>`
- `GET /diagnostics/sentry/<sourceId>?project=<project>&organization=<organization>`

query는 정확한 필드 집합만 허용하고 중복/추가 필드는 거부한다. 모든 scope는 배포 허용 목록과 일치해야 한다. 토큰 오류는 401, 허용 목록 밖 scope는 403, 없는/만료된 진단은 404이다. 응답은 `Cache-Control: no-store`이다.

응답 JSON은 `{ version: 1, identity: <제공자 식별자>, capturedAt: <ISO 시각>, summary: <문자열>, details: <객체>, disposition: <처리 결과|null> }`이다. `disposition`은 `{runId, status, outcome, reason, prUrl}`이며 PR 발행은 `published`, 준비 시 이미 존재하는 PR 발견은 `existing-pr`, 수정하지 않는 결정은 `wont-fix`로 표시한다. 아직 큐에 등록되지 않았으면 null이다. `reason`은 마스킹된 비신뢰 자료이며 검증 증거가 아니다. Cloudflare details는 `{ alertType, timestamp, data }`, Sentry details는 `{ resource, action }`이다. `data`는 마스킹한 불투명 제공자 필드이지 검증된 예외/경로 정보가 아니다. 실제 코드 위치/재현 입력이 없으면 준비 단계는 자료 부족을 명시하고 원인을 창작하지 않는다.

진단 privacy 제한:

- summary 최대 4096자, opaque data 최대 8192 UTF-8 bytes, 전체 진단 최대 16 KiB이다.
- data 깊이 5, 배열 20개, 객체 30개, 개별 문자열 1024자로 제한한다. 초과분은 `[TRUNCATED]` 또는 `truncated: true`로 표시한다.
- request/response/body/payload/user/context/extra/header/cookie/URL/route 및 비밀·개인정보 관련 키를 버린다. 나머지 문자열도 배포 secret 원문, 인증값, key=value 비밀, URL, 이메일, IP, 긴 opaque 값 패턴을 마스킹한다.
- 마스킹은 알려진 키·패턴에 대한 방어이며 임의 자연어 개인정보를 완벽하게 감지하지 못한다. 생산 telemetry 자체에 비밀·민감 요청 내용을 넣지 않는다. 마스킹 이후에도 문자열은 공격자가 통제할 수 있는 **자료**이며 지시가 아니다. 공개 GitHub 이슈에 전문을 게시하지 않는다.
- 진단은 7일 뒤 읽기가 차단되고 DO alarm이 원문 열을 비운다. 중복 방지 식별자/성공 tombstone은 유지한다. 중복 재전달이 진단 보존 기간을 연장하거나 덮어쓰지 않는다.

## 재시도와 중복 방지

source + 조직/프로젝트 또는 계정/정책/Worker + sourceId별 진단 DO가 진행 중 웹훅 요청 하나의 Promise를 공유한다. 진단을 SQLite에 저장·sync한 뒤 고정 저장소 큐에 등록하고 그 수락을 저장한 후 응답한다. 큐 장애는 503 및 `Retry-After: 30`으로 재전달을 요청한다. 과거 Actions의 `accepted_at`은 큐 등록 증거가 아니므로 새 `queue_admitted_at`을 별도 사용한다. 진단 만료·중복 전달은 기존 작업을 새로 모델 실행시키지 않는다.

큐는 최대 100건 대기, 동시에 하나의 lease만 허용한다. 기한/heartbeat 상실은 실패로 닫고 모호한 실행을 자동 중복 발행하지 않는다. 결과 응답 유실 시 같은 lease/outcome으로 이미 저장한 결과만 다시 확인할 수 있다. 제공자 marker와 `fix/<source>-<sha256(identityKey)>` 브랜치, 고정 base SHA/트리 검사를 사용한다. 해시에는 source·조직/계정·정책·프로젝트·sourceId가 포함되어 서로 다른 오류 범위가 충돌하지 않는다. GitHub PR 발행 도중 실패하면 운영자가 기존 브랜치·PR을 조사해야 하며 force push하지 않는다.

이슈 없는 계약으로 전환할 때 기존 실행을 완료하고 작업 사이에서 executor polling을 중지한 뒤 Worker와 executor를 함께 갱신하고 재개한다. 이전 `issueNumber` claim은 새 실행기가 수용하지 않는다. SQLite migration은 기존 identity/PR/outcome tombstone을 유지하고 미사용 `issue_number` 열을 제거하며 `reason`을 추가한다. `targetBranch`가 없는 과거 prepared 오류 job은 기존 `baseBranch`/`baseSha`와 lease를 보존한 채 PR 대상만 `develop`으로 해석한다. 기존 GitHub 이슈를 자동으로 닫거나 삭제하지 않고, 과거 오류를 재실행하려고 DO를 초기화하지 않는다. 별도 PR 리뷰 모드의 기존 PR 댓글 기능과 권한은 유지한다.

## 고정 저장소 PR 리뷰 모드 (선택적)

오류 경로와 별개로 같은 큐 DO·실행기 lease를 공유하는 `mode:'pull-request'` 작업이 있다. 기본은 닫혀 있다. `PR_REVIEW_ENABLED="true"`에서 실행기 수동 enqueue는 `PR_REVIEW_ALLOWED_PRS` 목록으로 제한하고, `PR_REVIEW_AUTO="true"`는 서명된 GitHub 이벤트로 적격 PR을 자동 등록한다. 둘 다 꺼져 있으면 리뷰 작업은 등록되지 않는다.

- `POST /executor/pull-requests/enqueue` `{version:1, executorId:'koin-rocky-umpc', pullNumber, headSha, baseSha}` → `200 {status:'queued'|'duplicate', runId}`. `runId = 'autofix-' + sha256('github-pr/<번호>/<headSha>/<baseSha>')`로 두 SHA가 모두 내구 키에 포함된다. Worker는 read 토큰으로 canonical GitHub를 조회해 같은 저장소·fork 아님·open·non-draft·base `develop`·head ref가 `main`/`preview`/`develop`이 아님·현재 head SHA와 **실제 develop tip**이 요청 pin과 정확히 같음을 확인한다. 비활성 503, 허용 목록 밖/fork/draft/closed/보호 ref/base 불일치 403, pin 불일치 409. 입력 단계는 GitHub에 아무것도 쓰지 않는다.
- `POST /webhooks/github`: 정확한 본문 바이트의 `X-Hub-Signature-256` HMAC-SHA256을 32자 이상 `GITHUB_WEBHOOK_SECRET`으로 검증한다. `pull_request`의 opened/reopened/synchronize/ready_for_review만 처리한다. canonical open/non-draft/same-repo/non-fork/develop/base tip/보호 ref/봇 작성 여부를 다시 확인하고, 자동화가 수정한 head SHA는 DO 기록으로 등록에서 제외한다. develop이 head 조상이 아니면 compare의 `behind_by`를 확인한다. write 토큰을 먼저 발급한 뒤 head SHA당 최대 3회 `update-branch(expected_head_sha)`를 내구 예약한다. 409/422 충돌은 한 marker 댓글로 종결하고, 일시적인 실패는 예약을 재시도 가능 상태로 풀어 다음 이벤트에서 제한적으로 재시도한다. 성공 후 synchronize 이벤트를 기다리고 다른 이벤트는 200으로 무시한다.
- `POST /executor/pull-requests/status`는 인증된 내구 영수증 `{runId, pullNumber, headSha, baseSha, status, outcome, attempt, enqueuedAt, result, autoMerge:{status:'merged'|'skipped'|'pending-checks', reason}|null}`을 반환한다. 모르는 run은 404다.
- claim 응답의 job은 `{mode:'pull-request', owner, repository, pullNumber, headSha, headTree, headRef, baseBranch:'develop', baseSha, changedFiles, reviewContext}`이다. `changedFiles`는 canonical `pulls/N/files` 파일명(최대 500개/64 KB), `reviewContext`는 `{version:1, title, body, comments}`로 canonical PR 제목(300자)/본문(2000자)과 reviews/review comments/issue comments(최대 50건/32 KB, 본문 2000자, 제어문자·비밀·이메일 마스킹, 자동화 자신의 댓글 제외)를 담는다. 모두 요청자가 아닌 GitHub에서 읽은 **신뢰할 수 없는 자료**이며 경로나 권한을 결정하지 않는다. `baseSha`는 실제 develop SHA이고 head와 같을 수 없다. 기존 오류 작업은 `mode` 없이 그대로다.
- `/model`은 PR 전용 정적 system prompt(리뷰 기준은 PR head, 제목/본문/diff/댓글은 자료, 기존 댓글은 코드로 검증할 가설, 전체 페이지→SPA 전환 시 상태 초기화·상위/하위 라우트와 데스크톱/모바일 접근 일관성·SSR/인증/쿠키 계약 같은 일반 불변식 점검)을 쓰고 모델은 `claude-opus-5-5`(오류 수정은 `claude-sonnet-5-5`)이며 다섯 파일 도구·호출 한도는 동일하다. 리뷰 댓글 제목에도 실제 사용한 Opus id를 표기한다.
- 결과는 `outcome:'pr-reviewed'` + `manifest`(0~24개, 빈 manifest는 PR 모드에서만 허용되고 그래도 검증 단계를 거쳐야 한다) + `review {decision:'approved'|'changes-requested', findings[{severity P1|P2|P3, path, line, message}]}` + `verification {headSha, baseSha, manifestSha256, passedChecks}`. `passedChecks`는 정확히 `['pr-head-pinned','native-fixture-tests','typecheck','autofix-security-tests','lint','build','runtime-route-smoke']`여야 하고, approved는 P1/P2 finding이 없을 때만, changes-requested는 finding이 하나 이상일 때만 유효하다. 'no-fix'/'verified'는 PR 작업에서, 'pr-reviewed'는 오류 작업에서 422로 거부된다. 큐 DO의 정책 거부(`PolicyRejection`)는 RPC 경계를 넘으면서 prototype이 아니라 `name`/`message`만 남는 일반 Error로 재구성되므로 Worker는 `name === 'PolicyRejection'`으로 구조적으로 판별해 종결 422로 내려보내며, 같은 payload 재시도는 성공할 수 없다. finding의 `path`/`message`는 한 줄 필드로 CR/LF/탭/행·단락 구분자를 공백 하나로 접고(제어문자 제거, 300/1000자 제한), 증거 댓글에 넣을 때 code span 안의 backtick은 제거하고 message의 `&`·`<`·`>`·backtick은 HTML entity로 바꿔 모델 출력이 댓글의 섹션·code span·HTML을 위조하지 못하게 한다. 수정 경로는 `changedFiles`에 등장하는 `apps/<x>/`·`packages/<x>/` 아래 소스/테스트/문서만 허용하고 `.github`, lockfile/package.json/workspace/.npmrc, wrangler/tsconfig/*.config, Dockerfile, 셸 스크립트, `scripts/`, `apps/error-automation`, `tests/autofix`, generated 파일, 비밀을 금지한다. 설정 변경은 리뷰 대상이지만 수정 권한은 없으며 모델은 차단됨을 finding으로 보고해야 한다.
- 결과 발행 전 canonical PR의 head/base/ref를 재조회한다. 이동했다면 쓰기 없이 stale로 닫는다. manifest 수정은 pinned head의 실제 일반 파일 내용 sha256을 확인하고 비-force fast-forward correction commit을 적용한다. 빈 manifest는 원본 head를 유지한다. 증거 댓글의 정확한 `pr-review:<번호>:<headSha>:<baseSha>:<manifestSha256>` marker는 동일 GitHub App 봇 댓글만 중복 방지 증거로 인정한다. 리뷰 댓글을 발행한 뒤 고정된 저영향 정책을 다시 평가하고 결과를 댓글과 durable receipt에 기록한다. GitHub review approval은 제출하지 않는다.

**저영향 자동 squash merge:** approved이고 P1/P2 finding이 없으며 수정 manifest가 비어 있어야 한다. canonical PR이 여전히 open·non-draft·develop 대상, head/base/ref 불변, mergeable이고 작성자가 사람이면서 `automerge:skip` 라벨이 없어야 한다. 변경 파일 ≤10, 추가+삭제 ≤300이며 rename 전후 경로 모두 `.github/`, `scripts/`, `apps/error-automation/`, `apps/api/drizzle/`, 모든 migrations, API schema/commerce/identity, auth/payment/session 경로, package/lock/workspace/wrangler/tsconfig/`*.config.*`/Dockerfile/`.env*`를 제외한다. head SHA의 모든 페이지에서 check run은 completed+success/neutral/skipped이고, commit status는 전부 success여야 한다. status가 0개일 때 GitHub combined state `pending`은 상태 미존재로 판단하되 check run 검증은 필수다. 실패·불명확한 결과는 skip; 대기는 `pending-checks`로 영속해 2분마다 최대 30분 동안 DO alarm으로 모든 정책 사실을 재조회한다. merge 직전에도 PR의 develop 대상·head/base·open/non-draft 상태를 다시 조회한다. 통과하면 `sha=<리뷰 head>`, `merge_method=squash`, 제목 `<PR 제목> (#번호)`로 develop에만 merge한다. main 브랜치 ruleset은 merge commit만 허용하므로 App의 squash merge 요청을 GitHub가 거부하는 두 번째 방벽이다. **develop→main 승격은 항상 수동 merge commit**이다.

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
# 4) 자동 등록도 종료: PR_REVIEW_AUTO "false", PR_REVIEW_ENABLED "false"로 되돌려 배포
```

`#7`처럼 base가 `develop`이 아닌 PR은 base가 바뀌기 전까지 403이며, 허용 목록에 있어도 현재 head/develop SHA가 pin과 다르면 409로 다시 pin 해야 한다.

## 확장

새 오류 출처·검증 프로필은 [확장 가이드](../../scripts/autofix/EXTENDING.md)를 참고한다.

## 로컬 검증

```sh
pnpm --dir apps/error-automation typecheck
pnpm --dir apps/error-automation test
pnpm --dir apps/error-automation exec wrangler deploy --dry-run
```

`ERROR_AUTOMATION_ORIGIN`을 승인·배포된 HTTPS Worker origin으로, `CLOUDFLARE_WEBHOOK_SECRET`을 해당 전용 비밀로 안전하게 제공한 뒤 `pnpm --dir apps/error-automation smoke:local`을 실행할 수 있다. 이 명령은 인증된 공식 설정 probe의 204만 검사하며 실제 오류/모델/PR을 만들지 않는다. Node 24 테스트는 `node:sqlite` 실제 SQL과 Tail handler→DO→인증된 Issues webhook→queue의 격리된 경로를 실행하며 제공자 조회 응답과 gateway 응답만 테스트 fixture로 대체한다. 따라서 테스트/설정 probe만으로 실제 mapped stack, Rocky lease, omp gateway 모델 호출 또는 GitHub PR 성공을 주장하지 않는다.

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
