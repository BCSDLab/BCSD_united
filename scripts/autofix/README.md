# 오류 알림 → 이슈 → 독립 검증 → PR

`apps/error-automation`이 인증한 `error-autofix` dispatch를 `.github/workflows/error-autofix.yml`이 처리한다. Sentry는 **브라우저 오류/Replay만**, Cloudflare Issues는 Worker/API/SSR 알림을 담당한다. 모델은 Claude Fable 5.1이며 별도 reviewer 단계, 자동 승인·merge·배포는 없다. 이 문서의 운영 명령은 설치만으로 실행되지 않는다.

## 지원 범위와 현재 제한

- **Sentry:** 고정된 Sentry API에서 프로젝트/이슈/브라우저 SDK를 확인한다. 허용 호스트의 요청 경로와 애플리케이션 소스 프레임이 있어야 모델을 호출한다. 새 행동 회귀 테스트, 기존 native fixtures, 타입/lint/build/runtime 검증을 모두 통과한 후보만 PR로 발행한다.
- **Cloudflare Issues:** 공식 Notifications 표준 envelope를 인증한 Worker가 보관한 진단을 읽고 계정·정책·Worker·앱을 재검증하여 이슈를 생성/재사용한다. **공식 문서는 `data` 내부의 Issues 예외/프레임/요청 경로 계약을 정의하지 않는다. 실제 인증된 Issues 알림의 삭제·마스킹된 샘플로 그 계약을 확인하기 전에는 자동 코드 수정/PR을 지원한다고 주장하지 않는다.** 현재 해당 단계는 `CLOUDFLARE_EVIDENCE_UNAVAILABLE`로 실패하며 이슈에 정직한 결과를 남긴다. 기존 Workers 지표 알림을 Issues 대신 쓰거나 비공개 Issues REST API를 만들어 호출하지 않는다.
- 외부 API, 인증된 사용자 상태, dependency/config/generated code 수정, Node 회귀로 재현할 수 없는 오류는 안전 범위 밖이다. 실패를 우회하거나 빈 PR을 만들지 않는다.

## 정확한 dispatch 계약

`repository_dispatch.event_type = error-autofix`. 추가 필드(프롬프트·URL·저장소·브랜치·파일 경로 포함)는 금지한다.

```json
{
  "source": "sentry",
  "sourceId": "12345",
  "project": "koin-browser",
  "app": "web",
  "scope": { "organization": "bcsdlab" }
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

Sentry ID는 앞자리 0 없는 양의 십진 문자열이다. Cloudflare correlation/account/policy ID는 정규화된 소문자 32자리 hex이며 `project = workerName`이다. Worker/앱은 알림 본문이 아니라 신뢰된 정책 매핑에서 정한다. 수동 재실행은 `workflow_dispatch.identity`에 위 JSON을 넣는다. GitHub 기본 브랜치(`BCSDLab/BCSD_united`는 `develop`)에서만 실행하며 실행 시 기본 SHA를 고정한다.

이슈 마커는 `<!-- error-autofix:source:provider-scope:project:sourceId -->`로 제공자와 계정/정책을 구분한다. 열린/닫힌 이슈를 GitHub Issues API로 최대 10,000개 순회하여 검색 인덱스 지연을 피한다. 브랜치는 `fix/#<issue>/<source>-<sourceId>`이다. 같은 브랜치의 PR이 있으면 새 모델 호출 없이 안내한다. 발행 도중 브랜치만 남은 경우 동일 부모/트리인지 확인하고 재개하며 force push하지 않는다.

## 진단 읽기 계약

Cloudflare prepare는 설정된 `ERROR_AUTOMATION_ORIGIN`의 아래 경로만 읽는다. origin은 경로·query·fragment·userinfo·비표준 port 없는 HTTPS origin이어야 한다. 리디렉션을 거부하고 응답 스트림을 100KB로 제한한다.

```text
GET /diagnostics/cloudflare/<sourceId>?project=<workerName>&accountId=<account>&policyId=<policy>&workerName=<workerName>
Authorization: Bearer <DIAGNOSTICS_READ_TOKEN>
```

응답은 정확히 `{version:1,identity:<dispatch>,capturedAt:<ISO>,summary:<string>,details:{alertType:<string>,timestamp:<nonnegative integer>,data:<object>}}`이다. Worker가 이미 제한·마스킹한 값도 prepare에서 다시 검증·마스킹한다. `data`는 **알 수 없는 제공자 데이터**이지 실행 지시나 검증된 스택/경로가 아니다. 보관 기간과 웹훅 인증은 `apps/error-automation/README.md`를 따른다.

Sentry는 `https://sentry.io/api/0/organizations/<org>/issues/<id>/` 및 `events/latest/`만 조회한다. 원문 request headers/body/cookies, user, breadcrumbs, source context를 저장하지 않는다. 문자열의 URL, 이메일, IP, 일반적인 token/password/authorization 패턴도 제거한다. 소스 프레임은 웹 앱의 `src/*.ts(x)/js(x)`만 허용한다. 마스킹은 모든 개인정보를 탐지한다는 보장이 아니므로 Sentry server-side scrubbing 및 SDK 정책도 필수다.

## GitHub 설정

### Secrets

| 이름                            | 사용 범위                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`             | agent 공식 Action의 `anthropic_api_key` 입력만. Worker/prepare/verifier/publisher에 전달하지 않는다. |
| `SENTRY_READ_TOKEN`             | prepare만. Issue & Event Read 및 Project Read 권한의 내부 통합 토큰.                                 |
| `DIAGNOSTICS_READ_TOKEN`        | prepare만. Worker의 동명 secret과 같은 32자 이상 비밀값.                                             |
| `ERROR_AUTOFIX_APP_PRIVATE_KEY` | publish만. 발행 전용 GitHub App private key.                                                         |

### Variables

| 이름                             | 값                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_ORGANIZATION`            | Worker와 동일한 조직 slug                                                                                           |
| `SENTRY_PROJECT_APPS`            | `{"koin-browser":"web"}`; 브라우저 프로젝트만                                                                       |
| `SENTRY_PROJECT_HOSTS`           | `{"koin-browser":["koreatech.in","stage.koreatech.in"]}`; 프로젝트별 허용 호스트                                    |
| `CLOUDFLARE_SOURCES`             | `[{"accountId":"...","policyId":"...","workerName":"koin-api","app":"api"}]`; Worker와 같은 정확한 Issues 정책 매핑 |
| `ERROR_PROJECT_DOMAINS`          | `{"sentry:koin-browser":"공통","cloudflare:koin-api":"공통"}`; 캠퍼스/비즈니스/유저/공통 중 명시적으로 선택         |
| `ERROR_AUTOMATION_ORIGIN`        | 배포된 진단 Worker의 정확한 HTTPS origin                                                                            |
| `ERROR_DISPATCH_BOT`             | dispatch App의 정확한 bot login; `*` 금지                                                                           |
| `ERROR_AUTOFIX_APP_ID`           | 이 저장소에만 설치한 발행 App ID                                                                                    |
| `ERROR_AUTOFIX_USE_GITHUB_TOKEN` | 명시적으로 `true`인 경우만 발행 App 대신 내장 토큰 사용                                                             |

발행 App 권한은 Contents/Issues/Pull requests write와 Metadata read만 필요하다. webhook dispatch 자격증명과 발행 App을 분리한다. 내장 토큰은 저장소의 Actions PR 생성 허용 설정이 필요하고 그 토큰이 생성한 PR은 일반적으로 후속 PR CI를 자동 실행하지 않으므로 App 발행을 권장한다. 진단 읽기/모델/발행 자격증명을 서로 재사용하지 않는다.

## 권한 분리와 독립 검증

1. **prepare:** 정확한 식별자를 검증하고 source-namespaced 이슈를 생성/재사용한다. 제공자 진단에서 최소 데이터만 만들고 trusted context와 함께 1일짜리 artifact로 전달한다.
2. **agent:** `anthropics/claude-code-action@d70510b174a1244958df0b03166a54912811f3e6` + `--model claude-fable-5-1`. read-only GitHub token, `persist-credentials:false`, Read/Edit/Write/Glob/Grep만 허용한다. 신뢰된 hook이 실제 경로·symlink를 검사한다. shell/network/MCP/subagent/secret 접근, automation/config/generated/schema/기존 테스트 수정은 금지한다. 저장소 설정 로딩과 MCP 서버도 비활성화한다.
3. **verify:** 별도 깨끗한 runner에서 24개 파일/파일당 256KB/총 1MB/일반 파일/앱 경계/baseline SHA256을 검사한다. 기본 코드에 frozen install을 끝낸 다음 후보를 적용한다. 이후 모든 실행은 네트워크·자격증명·Docker socket 없이 non-root/capability 제거/resource 제한 컨테이너에서 수행한다. 소스/설정/테스트/의존성은 read-only이며 빌드·런타임 출력 디렉터리만 명시적으로 쓸 수 있다.
4. 새 `tests/autofix/*.test.mjs`는 수정 전 실제 assertion 실패, 수정 후 통과해야 한다. loader/setup 실패는 재현이 아니다. 이어서 **`pnpm test`(기존 native fixture 전체), `pnpm typecheck`, `pnpm lint`, `pnpm build`**와 독립 route smoke를 수행한다. 기존 fixture/test 파일은 패치에서 수정할 수 없다.
5. 웹은 정적 route/import graph에서 모든 변경 소스가 관측 경로에 도달하는지 확인한다. 실제 local D1 migration/API Worker, preview, Chromium으로 페이지/DOM/URL/console/runtime 오류를 검사한다. API는 실제 GET 경로와 정적 handler graph를 확인하고 local Worker의 2xx/JSON을 검사한다. mutating 요청/인증/필수 query/운영 데이터 의존은 자동 재생하지 않는다. 운영 데이터나 가짜 fallback은 사용하지 않는다.
6. **publish:** 같은 run/base/검증 목록/patch hash를 확인하고 검증된 bytes만 Git API로 발행한다. 기본 브랜치가 전진했으면 중단한다. 후보 코드를 실행하거나 배포하지 않는다. 성공한 검사만 체크한 linked PR을 생성한다.
7. **실패 보고:** publish 작업의 마지막 단계가 실패/변경 없음의 단계 결과와 실행 링크를 이슈에 남긴다. GitHub write 권한은 prepare/publish에만 있다. 원문 진단·모델 주장·비밀값을 댓글에 복사하지 않는다.

`ACTIONS_STEP_DEBUG`, `show_full_output`, `display_report`를 켜지 않는다. 공개 저장소의 로그/artifact 접근 정책과 Anthropic 데이터 전송 정책을 검토한 후 활성화한다. SDK의 보안 기능만 믿지 않고 read-only 작업 권한·도구 hook·독립 verifier/publisher를 함께 유지한다.

## 프롬프트 출처와 적용 범위

워크플로의 정적 프롬프트는 아래 실제 오픈소스 구현에서 **원칙만 새로 서술**했다. 실행 중 upstream 프롬프트/스크립트를 다운로드하지 않는다.

- [OpenHands Datadog debugging prompt](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/debug_prompt.jinja) 및 [integration](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/datadog_debugging.py): 오류 데이터→관련 코드→원인 가설→재현→수정 또는 정직한 조사 결과 흐름. upstream의 curl/credential/repo clone/모델 PR 발행 권한은 채택하지 않았다.
- [OpenHands basic agent](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/agent_script.py) 및 [workflow](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/workflow.yml): 명시적인 task/model/API key 연결을 참고하되 upstream runtime URL fetch/광범위 GitHub write 권한은 채택하지 않았다.
- [Sweep planning prompts](https://github.com/sweepai/sweep/blob/a8b8b67bda4f89faac9314d34e7c7d5a64f76046/sweepai/core/planning_prompts.py): 파일·함수 이름을 명시한 원자적 최소 변경, 기존 helper 재사용, placeholder 금지. upstream의 테스트 제외 지침 및 speculative 범위 확대는 채택하지 않았다.
- [Claude Fable 5.1 공식 모델 ID](https://platform.claude.com/docs/en/models/fable-5-1/overview), [고정 Action 입력](https://github.com/anthropics/claude-code-action/blob/d70510b174a1244958df0b03166a54912811f3e6/action.yml): `claude_args`의 `--model claude-fable-5-1`, `anthropic_api_key` 지원 확인.
- [Cloudflare Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/), [Notifications webhook envelope](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/), [공유 비밀 인증](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/).

## 검증 명령

로컬 결정적 행동 검사는 `node --test scripts/autofix/security.test.mjs`이다. 전체 독립 verifier는 Linux/WSL2 + Docker, 커밋된 base SHA, 실제 `error-input/context.json`과 `error-patch/patch.json`이 필요하다.

```sh
docker build --tag koin-error-verifier --file scripts/autofix/Dockerfile scripts/autofix
node scripts/autofix/verify.mjs
```

`prepare.mjs`, `publish.mjs`, `report.mjs`는 실제 GitHub에 쓰는 운영 스크립트이므로 로컬 검사 대신 실행하지 않는다. 실제 모델/이슈/PR/배포는 별도의 명시적 운영 승인으로만 점검한다.
