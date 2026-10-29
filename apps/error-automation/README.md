# 오류 자동 수정 웹훅

공개 앱과 분리한 `bcsd-error-automation` Worker이다. Cloudflare Issues는 Worker/API/SSR 오류, Sentry는 브라우저 오류를 담당한다. 인증한 알림을 SQLite Durable Object에 먼저 기록한 뒤 고정 저장소에 `error-autofix` 이벤트를 보낸다. 모델은 웹훅 원문·GitHub 쓰기 토큰·진단 읽기 토큰을 받지 않는다. 실제 배포, 외부 알림 전송, GitHub dispatch는 로컬 테스트에서 실행하지 않는다.

## Production과 native Preview

이 Worker는 GitHub Workers Builds에서 `main`을 production branch로, `preview`를 비운영 branch로 연결한다. Root directory는 `apps/error-automation`, 빌드 명령은 `pnpm typecheck && pnpm test`, 운영 배포 명령은 `pnpm deploy`, 비운영 배포 명령은 `pnpm deploy:preview --name preview`로 설정한다. 배포용 GitHub Actions나 별도 stage/test Worker를 추가하지 않는다.

`wrangler.jsonc`의 top-level `ENVIRONMENT`는 `production`, `previews.vars.ENVIRONMENT`는 `preview`다. native Preview는 `wrangler preview`로 생성하며 `wrangler versions upload`나 `--env preview`를 사용하지 않는다. `preview_urls: false`는 기존 버전 Preview URL 설정이며 native `previews` 설정을 대신하지 않는다. `ERROR_ISSUES`는 Preview마다 새 SQLite DO namespace를 자동 할당받는다. 기존 Worker namespace와 중복 억제·진단 상태를 공유하지 않는다.

Preview는 기본적으로 provider allowlist와 안전한 GitHub 대상이 비어 있어 **503으로 거부**한다. 운영의 `GITHUB_DISPATCH_TOKEN`만 넣어서는 dispatch가 활성화되지 않으며, 무시한 이벤트인 것처럼 성공 응답하지 않는다. 환경 구분이 없거나 알 수 없는 값이어도 503이다.

Preview에서 실제 end-to-end 자동화를 시험하려면 별도 sandbox 저장소와 해당 저장소에만 `Contents: write` 권한을 가진 fine-grained PAT 또는 GitHub App 설치 토큰을 준비한다. `previews.vars.PREVIEW_GITHUB_OWNER`와 `PREVIEW_GITHUB_REPOSITORY`를 sandbox로 명시하고, 그 Preview에만 `PREVIEW_GITHUB_DISPATCH_TOKEN` 시크릿을 넣는다. `BCSDLab/BCSD_united`와 설정된 운영 저장소는 대소문자와 무관하게 거부한다. 운영 토큰과 동일한 값도 거부한다. Preview 토큰은 GitHub 요청과 진단의 시크릿 마스킹에 별도로 사용한다.

```sh
pnpm --dir apps/error-automation exec wrangler preview secret put PREVIEW_GITHUB_DISPATCH_TOKEN --name preview
pnpm --dir apps/error-automation exec wrangler preview secret put SENTRY_CLIENT_SECRET --name preview
pnpm --dir apps/error-automation exec wrangler preview secret put CLOUDFLARE_WEBHOOK_SECRET --name preview
pnpm --dir apps/error-automation exec wrangler preview secret put DIAGNOSTICS_READ_TOKEN --name preview
```

실제로 사용할 provider의 allowlist·전용 웹훅 secret과 별도 진단 읽기 토큰도 설정해야 한다. sandbox 저장소의 자동화 workflow, provider 허용 목록, `ERROR_AUTOMATION_ORIGIN`, 진단 읽기 토큰은 해당 Preview와 일치시킨다. 운영 알림과 운영 GitHub 자격 증명을 Preview로 복사하지 않는다. GitHub 연결·sandbox 자격 증명 없이 HTTP 응답을 받았다는 이유로 이슈·PR 생성을 검증했다고 기록하지 않는다.

공유 Preview 시크릿이 필요한 경우 `wrangler preview base-config secret put`을 사용할 수 있으나 Base 변경은 새 Preview에만 적용된다. 기존 Preview는 개별 갱신해야 한다. [Cloudflare Preview 설정](https://developers.cloudflare.com/workers/previews/configuration/)과 [DO 격리](https://developers.cloudflare.com/workers/previews/resources/)를 따른다.

## 배포 설정

루트 `pnpm install --frozen-lockfile` 후 Wrangler 설정을 운영 값으로 채운다. 기본 HTTPS 주소는 `https://bcsd-error-automation.bcsdlab.workers.dev`이며 사용자 지정 도메인을 연결할 수도 있다. 공개 주소에서도 웹훅 인증과 진단 읽기 토큰 검증은 필수이고, provider 설정이 없으면 요청을 거부한다.

| 설정                                 | 정확한 형식                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_ORGANIZATION`                | 허용 조직 slug                                                                                                                                                       |
| `SENTRY_PROJECT_APPS`                | JSON 객체: `{"browser-project":"web"}`. 브라우저 프로젝트만 허용하며 `api`는 거부한다. 미사용이면 `{}`                                                               |
| `CLOUDFLARE_SOURCES`                 | JSON 배열: `[{"accountId":"<32자리 소문자 hex>","policyId":"<실제 UUID>","workerName":"<실제 Worker 이름>","app":"api"}]`. `app`은 `web` 또는 `api`. 미사용이면 `[]` |
| `GITHUB_OWNER` / `GITHUB_REPOSITORY` | `BCSDLab` / `BCSD_united`                                                                                                                                            |

`CLOUDFLARE_SOURCES`에는 **실제 해당 Worker의 Issues automation에 연결된 policy만** 등록한다. 하나의 account/policy 쌍은 정확히 하나의 Worker와 앱을 가리켜야 한다. 여러 Worker를 섞은 정책, 일반 자원 사용량 경고 정책은 Issues 정책 대신 등록하지 않는다. payload 내부의 Worker 이름·앱·프로젝트는 라우팅을 바꿀 수 없다. 운영 담당자가 대시보드의 실제 policy 연결을 확인해야 하며 Worker가 Cloudflare 계정을 조회하여 이를 추정하지 않는다. 계정·정책을 모르는 상태에서 예시 ID로 배포하지 않는다.

Secret은 배포 담당자가 대화형 명령으로 등록하며 값은 저장소·명령 인자·로그에 남기지 않는다.

```sh
pnpm --dir apps/error-automation exec wrangler secret put SENTRY_CLIENT_SECRET
pnpm --dir apps/error-automation exec wrangler secret put CLOUDFLARE_WEBHOOK_SECRET
pnpm --dir apps/error-automation exec wrangler secret put DIAGNOSTICS_READ_TOKEN
pnpm --dir apps/error-automation exec wrangler secret put GITHUB_DISPATCH_TOKEN
```

- `SENTRY_CLIENT_SECRET`: Sentry 내부 통합 Client Secret. 해당 provider를 쓸 때 필수이다.
- `CLOUDFLARE_WEBHOOK_SECRET`: Cloudflare Generic Webhook destination Secret과 같은 32자 이상의 무작위 값. 해당 provider를 쓸 때 필수이다.
- `DIAGNOSTICS_READ_TOKEN`: 다른 secret과 별도로 생성한 32자 이상의 무작위 값. 이 배포의 허용된 source/account/policy/project에만 접근한다. 준비 작업에만 GitHub secret으로 제공한다. 다른 프로젝트의 진단을 격리하려면 별도 Worker 배포와 토큰을 사용한다.
- `GITHUB_DISPATCH_TOKEN`: 지정 저장소에만 접근하는 fine-grained PAT 또는 갱신 관리되는 GitHub App 설치 토큰. repository dispatch에 필요한 `Contents: write`만 부여한다. 모델 작업에 전달하지 않는다.

GitHub 준비 작업의 `ERROR_AUTOMATION_ORIGIN`은 이 Worker의 고정 HTTPS origin이다. 진단 URL이나 인증 헤더를 이벤트/모델이 지정하지 못하게 한다. GitHub 설정은 `scripts/autofix/README.md`를 따른다. 양쪽의 조직·프로젝트·계정·정책·Worker·앱 허용 목록을 일치시킨다.

최초 배포의 `v1` migration은 `ErrorIssueDispatch` SQLite 클래스를 생성하고 `ERROR_ISSUES` binding을 사용한다. 아직 배포하지 않은 초기 migration 기준이다. 운영 후 클래스나 migration을 제거하면 중복 방지 상태를 잃으므로 임의로 변경하지 않는다.

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

UUID는 소문자 32자리 hex 또는 표준 하이픈 표기를 받고, 저장/dispatch에서는 하이픈 없는 32자리로 정규화한다. `alert_event`는 선택적 문자열이며 알려진 `ALERT_STATE_EVENT_END`는 인증·식별 검증 후 무시한다. 요청 본문은 1 MiB까지 받는다.

공식 문서의 네이티브 `workers_alert` 예시는 `data.scripts[].script_name`, `workers_observability_alert` 예시는 `data.episode`를 포함한다. 이들은 **Issues 전용 payload fixture가 아니며 이 서비스의 Issues 설정 예제로 대체하지 않는다.** 수신기는 특정 `alert_type` 이름이나 `data.issue.id`/stack 위치를 발명하지 않고 표준 envelope만 해석한다. 테스트의 `fixture_issue_notification`은 합성 식별자이며 실제 Cloudflare 타입이라고 주장하지 않는다.

Issues 전용 `data` 구조와 실제 alert type은 공개 문서에 상세히 고정되어 있지 않다. 배포 후 운영 담당자가 해당 Worker Issues 화면에서 실제 오류를 선택해 destination으로 수동 전송하고, 진단 읽기 경로로 마스킹된 결과를 확인해야 한다. 테스트는 네이티브 Issues 전달 성공의 증거가 아니다. 실제 알림에 account/policy/correlation UUID가 빠져 있거나 형식이 다르면 400/403으로 거부하며 text/임의 data 값에서 ID를 추측하지 않는다. 이런 경우 필요한 자료는 **secret·개인정보를 제거한 실제 envelope와 대시보드의 정책-Worker 연결 정보**이다. 문서화되지 않은 Issues REST endpoint나 가짜 canonical 오류 이벤트는 사용하지 않는다.

Cloudflare의 Save and Test가 보내는 `{ "text": "Hello World! ..." }`는 운영 알림 식별자가 없으므로 400이다. 이 테스트를 통과시키려고 인증이나 identity 검증을 우회하지 않는다.

## Sentry 입력 계약

URL은 `https://<운영 호스트>/webhooks/sentry`이다. 정확한 요청 바이트를 `Sentry-Hook-Signature` HMAC SHA-256으로 검증한다. JSON 재직렬화로 서명을 검증하지 않는다.

지원 이벤트는 `issue/created`, `issue/unresolved` + `substatus: regressed`, `event_alert/triggered`이다. 나머지는 인증 후 무시한다. issue의 `project.slug`와 공식 issue URL로 조직을 확인한다. legacy `/api/0/issues/<id>/`는 `web_url` 또는 `permalink`에서 조직을 확인한다. event alert의 숫자형 project를 slug로 오인하지 않고 공식 event URL의 조직·프로젝트를 검증한다. 이 URL로 네트워크 요청을 보내지는 않는다. Sentry canonical API 읽기는 신뢰된 workflow 준비 작업에서 수행한다.

## 전달 및 진단 읽기

GitHub 전송은 정확히 다음 식별자만 포함한다. 본문 오류 문자열, prompt, URL, 파일 경로, 저장소 선택, 수정 명령은 포함하지 않는다.

```json
{
  "event_type": "error-autofix",
  "client_payload": {
    "source": "cloudflare",
    "sourceId": "<정규화한 alert_correlation_id>",
    "project": "<설정한 Worker 이름>",
    "app": "api",
    "scope": { "accountId": "<계정 ID>", "policyId": "<정규화한 정책 UUID>", "workerName": "<설정한 Worker 이름>" }
  }
}
```

Sentry는 같은 공통 필드에서 `source: sentry`, 양의 10진 문자열 `sourceId`, 프로젝트 slug, `app: web`, `scope: { organization }`을 사용한다.

진단 읽기는 `Authorization: Bearer <DIAGNOSTICS_READ_TOKEN>`을 요구한다. query token, 쿠키, CORS 공개 읽기, 목록 조회는 지원하지 않는다.

- `GET /diagnostics/cloudflare/<sourceId>?project=<worker>&accountId=<account>&policyId=<policy>&workerName=<worker>`
- `GET /diagnostics/sentry/<sourceId>?project=<project>&organization=<organization>`

query는 정확한 필드 집합만 허용하고 중복/추가 필드는 거부한다. 모든 scope는 배포 허용 목록과 일치해야 한다. 토큰 오류는 401, 허용 목록 밖 scope는 403, 없는/만료된 진단은 404이다. 응답은 `Cache-Control: no-store`이다.

응답 JSON은 `{ version: 1, identity: <dispatch 식별자>, capturedAt: <ISO 시각>, summary: <문자열>, details: <객체> }`이다. Cloudflare details는 `{ alertType, timestamp, data }`, Sentry details는 `{ resource, action }`이다. `data`는 정규화한 exception 모델이 아니라 원래 불투명 필드를 마스킹한 객체이다. 실제 코드 위치/재현 입력이 없다면 준비 작업은 자료 부족을 명시해야 하며 오류 원인을 창작하지 않는다.

진단 privacy 제한:

- summary 최대 4096자, opaque data 최대 8192 UTF-8 bytes, 전체 진단 최대 16 KiB이다.
- data 깊이 5, 배열 20개, 객체 30개, 개별 문자열 1024자로 제한한다. 초과분은 `[TRUNCATED]` 또는 `truncated: true`로 표시한다.
- request/response/body/payload/user/context/extra/header/cookie/URL/route 및 비밀·개인정보 관련 키를 버린다. 나머지 문자열도 배포 secret 원문, 인증값, key=value 비밀, URL, 이메일, IP, 긴 opaque 값 패턴을 마스킹한다.
- 마스킹은 알려진 키·패턴에 대한 방어이며 임의 자연어 개인정보를 완벽하게 감지하지 못한다. 생산 telemetry 자체에 비밀·민감 요청 내용을 넣지 않는다. 마스킹 이후에도 문자열은 공격자가 통제할 수 있는 **자료**이며 지시가 아니다. 공개 GitHub 이슈에 전문을 게시하지 않는다.
- 진단은 7일 뒤 읽기가 차단되고 DO alarm이 원문 열을 비운다. 중복 방지 식별자/성공 tombstone은 유지한다. 중복 재전달이 진단 보존 기간을 연장하거나 덮어쓰지 않는다.

## 재시도와 중복 방지

source + 조직/프로젝트 또는 계정/정책/Worker + sourceId별 DO를 사용한다. 진행 중 요청은 하나의 Promise를 공유한다. 진단 기록 및 저장 sync를 완료한 **다음** GitHub로 dispatch한다. GitHub 204만 성공으로 기록하며 저장을 마친 뒤 성공을 반환한다. 네트워크/HTTP 거부는 502, 저장 실패는 503과 `Retry-After: 30`을 반환한다. 실패 기록은 재시도 가능하다. 성공한 이슈는 재생·회귀 전달도 중복으로 처리한다.

GitHub가 수락한 직후 응답 유실/Worker 종료가 발생하면 외부 API와 SQLite 사이의 exactly-once는 보장할 수 없다. 성공을 추정해 이벤트를 버리지 않으며 workflow의 source별 concurrency, 결정적 issue marker, 고정 PR branch가 중복 산출물을 막는다. GitHub 호출 timeout은 8초이며 provider의 전송 재시도에만 의존하지 말고 실패를 운영 모니터링한다.

## 로컬 검증

```sh
pnpm --dir apps/error-automation typecheck
pnpm --dir apps/error-automation test
pnpm --dir apps/error-automation exec wrangler deploy --dry-run
```

Node 24 테스트는 `node:sqlite`에 실제 SQL을 실행하고 객체를 재생성한다. 외부 fetch는 가로채며 secret 인증, 교차 계정 거부, allowlist, source 분리, 동시성, 재시도, 저장 선행, 읽기 권한, privacy, 만료를 확인한다. Cloudflare output gate와 실제 Issues 전송은 Node 테스트가 재현하지 못하므로 배포 담당자의 실제 알림 확인이 별도로 필요하다.

## 공식 근거

- [Cloudflare Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/)
- [Generic webhook secret / test payload](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/)
- [Notifications webhook payload schema](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/)
- [Sentry webhook 서명](https://docs.sentry.io/integrations/integration-platform/webhooks/)
- [Sentry issue 생성/회귀](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)
- [Sentry event alert](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
- [GitHub repository dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
- [SQLite DO migration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
