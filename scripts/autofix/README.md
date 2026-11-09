# 오류 알림 → 독립 검증 → 직접 PR 또는 내부 종료

`apps/error-automation` Worker가 인증한 Sentry/Cloudflare 알림을 SQLite DO에 기록하고, 고정 Rocky/UMPC 전용 실행기가 **아웃바운드 HTTPS polling**으로 작업을 받는다. Worker는 오류 수정 `claude-sonnet-5-5`, PR 검토 `claude-opus-5-5`를 고정한다. 오류 수정 PR은 자동 merge하지 않지만, 독립 검증을 마친 저영향 PR 리뷰는 엄격한 조건에서 develop에 자동 squash merge할 수 있다. develop→main 승격과 배포는 수동이다. 운영 배포·비밀 등록·실제 모델/PR 호출은 별도 운영 승인이 필요하다.

## 지원 범위와 현재 제한

- **Sentry:** 고정된 Sentry API에서 프로젝트/이슈/브라우저 SDK를 확인한다. 허용 호스트의 요청 경로와 애플리케이션 소스 프레임이 있어야 모델을 호출한다. 새 행동 회귀 테스트, 기존 native fixtures, 타입/lint/build/runtime 검증을 모두 통과한 후보만 PR로 발행한다.
- **Cloudflare Issues:** Worker가 공식 Notifications envelope를 인증하고 계정·정책·Worker·앱을 재검증한다. 불투명한 `data`를 예외/경로/소스 프레임으로 임의 해석하지 않고, 일치하는 Issues occurrence·Tail/Telemetry·고정 소스 버전의 안전한 GET 경로와 매핑된 앱 소스 프레임을 별도 확인한 경우에만 수정 후보를 만든다. 근거가 부족하면 `CLOUDFLARE_EVIDENCE_UNAVAILABLE`로 실패 기록을 남기며 원본 Cloudflare Issue는 변경하지 않는다. 기존 Workers 지표 알림을 Issues 대신 쓰거나 존재하지 않는 비공개 Issues 수정 API를 호출하지 않는다.
- 외부 API, 인증된 사용자 상태, dependency/config/generated code 수정, Node 회귀로 재현할 수 없는 오류는 안전 범위 밖이다. 실패를 우회하거나 빈 PR을 만들지 않는다.
- 2026-10-29 커밋 `68c6d24`의 독립 오프라인 실행에서 `/shops/categories` 실제 API/D1 GET, 홈 `/` SSR, 데스크톱 Chromium, 390px Android 에뮬레이션 Chromium의 홈 UI·브라우저 gateway 비교가 통과했다. 빈 로컬 D1에서 날씨 제공자 부재(`CONFIGURATION_ERROR`)와 학생식당 운영정보 부재(`NOT_FOUND_DATA`)가 명시적인 unavailable/빈 식단 UI로 표시되는 것도 확인했다. 이는 실제 휴대전화·운영 데이터·Sentry/Cloudflare/GitHub 제공자 연동의 성공을 뜻하지 않는다.
  2026-11-06 격리된 실제 workerd 스모크에서 서명된 Sentry 알림의 입장, GitHub 이슈 번호 없는 lease, 실제 실행기 결과 endpoint의 `no-fix`/`failed`, 인증된 내부 진단의 처분·사유, 무인증 401·중복 결과/알림 억제를 확인했다. 이는 운영 제공자 호출, 원격 PR 발행 또는 Rocky 호스트 설치의 증거가 아니다.

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

Sentry ID는 앞자리 0 없는 양의 십진 문자열이다. Cloudflare correlation/account/policy ID는 정규화된 소문자 32자리 hex이며 `project = workerName`이다. Worker/앱과 오류 작업의 `baseBranch`는 알림 본문이 아니라 신뢰된 정책 매핑에서 정한다: 운영 Sentry(`koin-united-prod`)와 Cloudflare(`koin-web`, `koin-api`)는 `main`, preview Sentry(`koin-united-preview`)는 `develop`. Worker 준비 단계에서 출처 브랜치의 tip `baseSha`를 조회한다. `targetBranch`는 언제나 `develop`이며 PR 검토 작업의 base도 별도로 `develop`이다. 수동 `workflow_dispatch` 재실행 경로는 없다.

GitHub 오류 이슈 생성·검색·댓글은 하지 않는다. 제공자 전체 식별자 키는 Sentry의 `sentry/<organization>/<project>/<sourceId>`, Cloudflare의 `cloudflare/<accountId>/<policyId>/<project>/<sourceId>`이고, 브랜치는 이 UTF-8 키의 전체 SHA-256 소문자 hex를 사용한 `fix/<source>-<64-hex>`이다. 동일 브랜치의 기존 PR이 있으면 새 모델 호출 없이 해당 PR URL을 내부 처분에 기록한다. 발행 도중 브랜치만 남은 경우 동일 부모/트리인지 확인하고 재개하며 force push하지 않는다. 번호 없는 오류 작업도 실행기가 식별자 형태와 브랜치 해시를 재검사한다.

## 진단·소스 근거

Worker는 source별 진단 DO에서 인증·마스킹된 기록을 내부 binding으로 읽는다. Sentry는 Worker만 `https://sentry.io/api/0/organizations/<org>/issues/<id>/` 및 `events/latest/`에서 canonical issue/event를 조회한다. 원문 request header/body/cookie, user, breadcrumbs, source context는 모델·실행기 작업공간에 쓰지 않는다. 허용 프로젝트 호스트의 안전한 GET 경로와 실제 `apps/web/src` 앱 소스 프레임이 없으면 수정하지 않는다.

Cloudflare Issues는 공식 Notifications envelope의 불투명 `data`를 임의 예외/경로/소스 프레임으로 해석하지 않는다. 신뢰된 occurrence 조회와 Tail/Telemetry·소스맵 경로의 식별자/버전 일치가 없으면 `CLOUDFLARE_EVIDENCE_UNAVAILABLE`로 실패한다. 부족한 근거는 내부 진단에만 남기며 원본 Cloudflare Issue를 생성·수정·댓글 처리하지 않는다. 진단 보존/읽기 제한은 `apps/error-automation/README.md`를 따른다.

Sentry는 `https://sentry.io/api/0/organizations/<org>/issues/<id>/` 및 `events/latest/`만 조회한다. 원문 request headers/body/cookies, user, breadcrumbs, source context를 저장하지 않는다. 문자열의 URL, 이메일, IP, 일반적인 token/password/authorization 패턴도 제거한다. 소스 프레임은 웹 앱의 `src/*.ts(x)/js(x)`만 허용한다. 마스킹은 모든 개인정보를 탐지한다는 보장이 아니므로 Sentry server-side scrubbing 및 SDK 정책도 필수다.

## Worker 비밀과 실행기 계약

Worker secret은 `SENTRY_CLIENT_SECRET`/`CLOUDFLARE_WEBHOOK_SECRET`/`GITHUB_WEBHOOK_SECRET`, Sentry·진단 읽기 토큰, 기존 단일 GitHub App 키 `GITHUB_DISPATCH_APP_PRIVATE_KEY`, 모델 게이트웨이 `OMP_GATEWAY_TOKEN`, 실행기 전용 `AUTOFIX_EXECUTOR_TOKEN`이다. 전용 실행기는 마지막 토큰만 안전한 host 파일에서 사용하고 GitHub/게이트웨이/provider 비밀을 받지 않는다. 기존 `GITHUB_DISPATCH_*`은 두 번째 App이나 Actions dispatch를 뜻하지 않는다. 고정 저장소의 일반 read 토큰은 contents/issues/pull requests read이고 발행 토큰은 contents/issues/pull requests write다. 자동 merge만 contents/pull requests/checks/statuses read 전용 토큰을 별도로 요청한다. 조직의 Checks/Commit statuses 권한 승인이 대기 중이면 리뷰는 계속 발행되고 자동 merge만 건너뛴다. Anthropic API key 직접 호출은 없다.

`AUTOFIX_EXECUTOR_ID=koin-rocky-umpc`로 고정한다. 실행기는 고정 HTTPS Worker origin에만 `Authorization: Bearer <AUTOFIX_EXECUTOR_TOKEN>` 및 `X-Executor-Id: koin-rocky-umpc`를 보내며 호스트 인바운드 네트워크 포트를 열지 않는다. `/executor/claim`의 `claimNonce` 64자리 hex를 비밀 파일과 분리해 먼저 영속하고, 응답 유실 때 같은 nonce로 동일 lease를 재요청한다. 204는 대기 작업 없음, 200은 고정 repo/base SHA/제공자 식별자/diagnostics/context/branch/lease이며 오류 작업에는 GitHub `issueNumber`가 없다. 2분 rolling heartbeat·90분 절대 기한·동시 한 작업을 적용한다. claim(신규·재개 모두)은 Worker가 확인한 `leaseExpiresAt`(안전 정수, 미래, `deadlineAt` 이하)을 반드시 포함하며, 실행기는 이를 마지막 확인 만료로 삼아 시작한다.
기존 issue-number 기반 lease가 남은 상태에서 새 claim 계약으로 갈아타지 않는다. 운영 전환 시 실행기 polling을 멈추고 기존 lease를 종료/소진한 뒤 Worker와 실행기 이미지를 함께 갱신해 재개한다. 중복 억제용 보존 상태(tombstone)를 지우거나 기존 원격 GitHub 이슈를 변경하지 않는다.

실행기 lease 유지(`keepLease`): heartbeat는 45초 간격이며 한 번에 하나만 보낸다. Worker가 확인한 마지막 `leaseExpiresAt`만 사실로 취급하고, 확인되지 않은 heartbeat는 lease를 연장한 것으로 간주하지 않는다. 연결 시간 초과·연결 거부/재설정·네트워크 도달 불가·30초 요청 시간 초과 같은 전송 계층 실패만 5초 뒤 재시도하되, 마지막 확인 만료에서 15초 안전 여유를 뺀 시점 안에 재시도가 들어갈 때만 한다. HTTP 상태 거부(인증·정책·409 등), TLS 실패, 잘못된 응답 본문, `deadlineAt` 불일치, 15초 여유보다 짧은 만료는 즉시 작업을 중단한다. 독립 fail-closed 타이머가 확인 만료 − 15초에 작업을 중단하므로 heartbeat 요청이 멈춰도 알려진 lease를 넘겨 실행하지 않으며, 그때 진행 중인 heartbeat 요청도 취소한다. 작업 완료·종료 시 타이머와 진행 중 요청을 모두 정리해 늦게 도착한 응답이 다음 작업에 영향을 주지 않는다. 확인 만료가 이미 절대 기한과 같으면 더 연장할 수 없으므로 heartbeat를 보내지 않는다.

`/executor/jobs/<runId>/model`은 살아 있는 generation lease에서만 요청한다. Worker가 고정 모델/정적 system/Read·Edit·Write·Glob·Grep schema만 omp gateway에 전달하며 파일 요청은 실행기가 경로·symlink·앱 경계를 다시 검사한다. 오류 수정은 80개 메시지·256 KB, PR 검토는 240개 메시지·1 MB, 응답은 256 KB까지다. 파일 도구는 오류 수정 40회, PR 검토 400회까지다. PR 검토는 diff 중심의 좁은 줄 범위와 독립 읽기 묶음을 사용한다. 후보 환경에는 shell/network/MCP/GitHub credential이 없다.

작업당 모델 비용 상한은 Worker가 영속 집행하고 실행기가 같은 호출/시간/호출당 제한을 적용한다. 오류 수정: 6회/4분/입력 50k·출력 8k/호출당 4,096. PR 검토: 20회/15분/입력 400k·출력 32k/호출당 8,192 (`MODEL_BUDGET`). Worker는 upstream payload 바이트와 출력 예약을 실제 usage에 한해 정산한다. 실패 시 예약을 소비하고 한도 초과는 종결 실패다. 독립 Docker 검증의 예산과 90분 절대 lease는 바뀌지 않는다.

실행기는 첫 메시지에 호출·시간·호출당 출력·파일 도구 횟수·도구 결과 10,000자 절단을 명시하고 매 호출 남은 횟수를 알린다. 마지막 도구 턴은 수정과 새 회귀 테스트를 마치도록 안내한다. 마지막 호출(오류 6번째·PR 20번째) 또는 파일 도구를 모두 쓴 뒤의 호출은 `tools: []`로 답변만 요청한다. Worker는 기존 이력 schema를 유지하고 `tool_choice:{type:'none'}`으로 파일 호출을 막는다. 빈 답변·`max_tokens` 중단은 완료가 아니며 예산 거절 422는 재시도하지 않는다.

예외를 고치는 회귀 테스트는 실패 동작을 `assert.doesNotThrow`(비동기는 `await assert.doesNotReject`)로 감싸고 기대 결과도 assertion으로 확인하도록 모델에 명시한다. `assert.equal(failingCall(), expected)`만 사용하면 assertion 전에 원래 예외가 발생하므로 검증기의 `ERR_ASSERTION` 조건을 충족하지 못한다. 검증 기준을 낮추거나 로더/설정 오류를 재현으로 인정하지 않는다.

PR 모델 요청은 Worker 최대 180초·실행기 최대 190초이며 남은 15분 generation 창으로 더 제한된다. 오류 수정은 90초/100초와 4분 창이다. 모든 요청은 lease 상실 시 취소한다.

제공자 429 처리(`requestModel`): Worker는 게이트웨이 429가 숫자 `Retry-After`를 싣고 `rate_limit_error`이며 spend cap(`enforced_spend_limit_reached`)이 아닐 때만 `/model`에 429와 canonical 십진 정수 `Retry-After`(1~3600초)를 돌려준다. 실행기는 그 429에 한해 **같은 요청 바이트**(대화 transcript 무변경)를 최대 3회 재전송하되, 서버 지연 이상을 기다리고 대기가 남은 generation 창 안에 끝날 때만 한다. 창을 넘는 지연은 더 짧게 기다리지 않고 즉시 실패하며, 대기 중 작업 abort(기한·lease 상실·종료)는 재시도를 취소한다. 헤더가 없거나 잘못된 429, 예산 초과 거절, spend cap, 400/401/403, 503, TLS/전송 실패, 잘못된 본문은 재시도하지 않는다. 로컬 omp 게이트웨이의 429에는 `Retry-After`가 없으므로 현재 구성에서는 재시도가 일어나지 않는다. lease heartbeat는 대기와 무관하게 독립적으로 이어지고, 429로 끝난 요청도 Worker의 모델 호출 상한에 그대로 계산된다. 운영 로그에는 `retryAfterSeconds`와 재시도 횟수만 남기고 제공자 응답 본문은 기록하지 않는다.

자원 프로필은 검증 컨테이너당 RAM 상한 **3 GiB**, CPU 2개다. 단계는 한 컨테이너씩 순차 실행되므로 상한이 동시에 쌓이지 않는다. claim 전 `MemAvailable` 기준은 이 상한에 공유 호스트 여유 1 GiB를 더한 **4 GiB**다(이전 5 GiB는 여유를 2 GiB로 잡았다). 2026-11-09 Rocky에서 실제 PR 검증 2건을 cgroup으로 측정한 단계별 최대 익명 메모리는 web build 약 1.9 GiB, `@koin/web` lint 1.6 GiB, 런타임 smoke 1.3 GiB, typecheck 1.1 GiB, api smoke 0.9 GiB, install 0.5 GiB(cgroup `memory.peak`는 2.3 GiB)여서 실사용은 상한보다 충분히 낮다. 컨트롤러의 기존 2 GiB 상한(실사용 약 0.1 GiB)은 유지하고, workspace 타입 검사·테스트·빌드는 하나씩 실행해 중첩 메모리 피크를 줄인다. 한도 초과로 검증 프로세스가 종료되면 실패로 처리하며 검증 생략·자동 한도 상향·다른 서비스 중지는 하지 않는다.

실행기는 공개 저장소의 검증된 고정 SHA를 각 작업의 별도 model/verifier git worktree로 준비한다. verifier image는 미리 빌드해 재사용하되, 후보 소스는 독립적인 새 검증 작업공간/매번 disposable Docker 실행으로 검증한다. `/verification-start` 이후 모델 프록시는 닫힌다. source-only 모델이 낸 manifest는 최대 24 text 파일, 파일당 256 KB, 합계 1 MB이며 수정 앱 src와 새 `tests/autofix/*.test.mjs`로만 제한한다. 기존 테스트/설정/lockfile/schema/generated 변경과 다른 앱 변경은 거부한다.

독립 검증은 수정 전 새 assertion 실패/수정 후 통과, 기존 native fixtures와 autofix 보안 테스트, 타입/lint/build, 실제 로컬 API+D1+SSR+Chromium/390px 모바일 smoke를 수행한다. 네트워크 없는 Docker, 비루트/capability 제거, read-only source/dependencies와 제한된 scratch를 사용한다. proof는 출처 `baseSha`·검증된 manifest SHA256·정확한 필수 check 목록에 결속한다. Worker는 출처 `baseBranch` tip이 전진하지 않았는지 재조회하고 verified bytes로 `baseSha` 위에 커밋을 만들어 `develop` 대상 PR을 직접 발행한다. force push, 자동 merge/배포는 없다. 안전한 수정 근거가 없거나 모델이 무변경을 반환하면 `no-fix`를 내부 `wont-fix`와 사유로 기록한다. 실행·검증·발행 실패는 별도 `failed`와 사유로 기록하며 둘 다 GitHub 이슈를 만들거나 댓글을 남기지 않는다. 검증 성공 PR 또는 기존 PR은 내부 인증 진단에서 URL로 확인한다.
운영자는 인증된 진단 조회에서 `disposition`의 `runId`, `status`, `outcome`(`wont-fix`/`failed`/`published`/`existing-pr`), `reason`, `prUrl`을 확인한다. 이 내부 상태는 GitHub 이슈 또는 Cloudflare Issue의 상태/댓글이 아니며, `no-fix`와 실행 실패를 혼동하지 않는다.

Rocky/UMPC의 root 신뢰 실행기는 고정 SHA 소스에서 후보와 독립 검증 worktree를 분리하고, 사전 빌드된 **두 이미지의 검증 스크립트 SHA256 일치**를 작업 전·검증 전 확인한다. 검증 스냅샷은 `git archive`가 아니라 고정 tree의 `git ls-tree -r` + `git cat-file --batch`로 object database에서 그대로 복원한다(`patch.mjs` `exportTree`). 따라서 스냅샷 안의 `.gitattributes`(`export-ignore`/`export-subst`)는 어떤 파일도 빼거나 바꿀 수 없고, 심볼릭 링크는 링크로 기록될 뿐 호스트 쓰기에서 따라가지 않으며 submodule·알 수 없는 mode는 실패한다. 검증용 의존성은 자격 증명 없는 신뢰 설치 컨테이너에서 `pnpm install --frozen-lockfile --ignore-scripts`로 획득하고(유일한 네트워크 단계, lifecycle 없음), 승인된 lifecycle `pnpm rebuild --pending`은 **별도의 `--network none`, non-root 컨테이너**에서 소스·설정·테스트가 모두 read-only이고 설치기가 만든 실제 `node_modules` 디렉터리만 쓰기 가능한 상태로 실행한다. 이후의 회귀·타입·lint·빌드·API/D1/SSR/브라우저 확인은 별도 매번 폐기되는 `--network none`, cap-drop-all, no-new-privileges, non-root 컨테이너에서 수행한다. 설치와 후보 실행은 동일 컨테이너가 아니며 모델은 어떤 코드를 실행하거나 Docker socket을 읽지 못한다. root 컨트롤러에 CAP_CHOWN을 추가하지 않고, 고정 scratch·의존성 디렉터리만 마운트한 신뢰 CHOWN 전용 도우미와 UID 1000의 무권한 정리 도우미가 소유권·회수를 처리한다.

두 단계는 `PNPM_CONFIG_CACHE_DIR=/work/node_modules/.cache/pnpm`을 공유한다. 온라인 획득 단계의 공급망 정책 검증 캐시를 오프라인 rebuild에서도 사용하며, 정책 검사 자체를 끄거나 lifecycle에 네트워크를 열지 않는다.

heartbeat 실패 원인(원인 체인의 오류 코드 포함)과 중단·실패한 하위 명령의 마지막 12 KB는 실행기 운영 로그에만 남긴다. URL과 긴 토큰형 문자열은 제거하고 사유는 500자로 제한하며, 이 진단을 PR 댓글이나 검증 성공 증거로 사용하지 않는다.

2026-10-29 Rocky 호스트에서 고정 커밋 `68c6d24`의 root 컨트롤러 이미지로 오프라인 전체 스모크가 종료 코드 0으로 완료됐다. 검증 코드가 Docker 내부 `id -u`의 비루트 일치를 확인했고, 실제 로컬 API/D1 GET·홈 SSR/Chromium·390px 모바일 게이트가 통과했으며 격리 컨테이너와 소스 스냅샷 정리까지 끝났다. 이는 후보 패치의 회귀 전후 검증, 실제 제공자 호출 또는 운영 PR 발행의 증거는 아니다.

검증 세부 조건:

1. **검증 격리:** 별도 깨끗한 worktree에서 24개 파일/파일당 256KB/총 1MB/일반 파일/앱 경계/baseline SHA256을 검사한다. 기본 코드에 frozen install을 끝낸 다음 후보를 적용한다. 이후 모든 실행은 네트워크·자격증명·Docker socket 없이 non-root/capability 제거/resource 제한 컨테이너에서 수행한다. 소스/설정/테스트/의존성은 read-only이며 빌드·런타임 출력 디렉터리만 명시적으로 쓸 수 있다.
2. 새 `tests/autofix/*.test.mjs`는 수정 전 실제 assertion 실패, 수정 후 통과해야 한다. loader/setup 실패는 재현이 아니다. 오류 모드에서는 고정 base의 기존 native fixtures를 후보 적용 **전과 후** 모두 실행해 이미 통과하던 테스트를 보존한다. API 후보는 `@koin/api...`, 웹 후보는 추가로 `@koin/web...` 의존성 범위의 기존 native fixtures·타입·빌드를 검사하고 autofix 보안 테스트와 해당 범위 lint를 수행한다. B-BOT의 별도 PostgreSQL 런타임은 이 자동 수정 대상이 아니며 저장소 전체 검증에서 따로 검사한다. 기존 fixture/test 파일은 패치에서 수정할 수 없다.
3. 웹은 정적 route/import graph에서 모든 변경 소스가 관측 경로에 도달하는지 확인한다. 오류 작업은 인증된 관측 경로를 그대로 사용하며, PR/단독 오프라인 스모크만 홈 `/`를 사용한다. 웹 검증 전 로컬 D1 migration을 적용하고, Vite 빌드에 검증 전용 `koin-api` auxiliary Worker를 포함하여 SSR service binding과 브라우저 gateway가 동일한 실제 로컬 API/D1을 사용하게 한다. API smoke는 별도 실제 Wrangler Worker에서 관측된 GET endpoint 실행과 2xx/JSON을 확인한다. 배포 설정의 레거시 Worker API는 `API_ENABLED` 기본 비활성(`"false"`)이므로, `local-api.mjs`는 격리 Miniflare에만 `API_ENABLED`를 `"true"`로 명시한다(`wrangler dev --var API_ENABLED:true`, auxiliary Worker 사본의 `vars` 치환). 이 값은 로컬 프로세스에만 적용되며 원격 Worker·D1·Queue 설정을 바꾸지 않는다. `SOURCE_SYNC_ENABLED`는 그대로 `"false"`이고 검증기가 별도 게이트를 추가하지 않는다. 데스크톱 SSR/Chromium 후 문서를 떠나 `requestContext.ts`의 모바일 분류와 일치하는 Android Mobile UA로 **같은 관측 경로**의 SSR/390px Chromium을 새로 열고, 문서·gateway 응답, 앱 DOM, console.error·예외·hydration 경고·HTTP 오류를 확인한다. 홈에서는 실제 인사·식단 위젯과 SSR의 로컬 API 요청도 확인하되, 정적 경로에 존재하지 않는 API 요청을 강요하지 않는다. 빈 로컬 D1에서 `/weather` 503과 `/coopshop/1` 404는 정확한 API 오류 코드와 명시적 unavailable/빈 식단 UI를 모두 확인한 경우에만 허용한다. 임시 entrypoint·registry·브라우저 프로필·프로세스·컨테이너·source snapshot을 정리한다. mutating 요청/인증/필수 query/운영 데이터 의존은 자동 재생하지 않으며 운영 데이터나 가짜 fallback을 사용하지 않는다.

## omp 게이트웨이 (Rocky 상주)

Worker의 **유일한** 모델 인증 경로다. 직접 Anthropic API key 호출 경로는 제거되었고 복원용 fallback도 없다. Worker는 Workers VPC 바인딩 `OMP_GATEWAY`와 secret `OMP_GATEWAY_TOKEN`이 모두 설정된 경우에만 고정 system/tools/model 본문을 바인딩의 `POST /v1/messages`에 `Authorization: Bearer <OMP_GATEWAY_TOKEN>`으로 보내며 redirect를 따르지 않는다. 둘 중 하나라도 없으면 모델 호출은 설정 오류로 실패하고 작업은 종료된다. Rocky에서는 `scripts/autofix/local-omp-gateway.mjs`가 `127.0.0.1:43129`에만 바인딩되어 요청마다 공식 `omp auth-gateway stdio` 자식 한 개를 띄워 추론만 위임한다. omp 자식은 Rocky의 기존 omp auth-broker(`127.0.0.1:8766`)로 인증하며, access/refresh token·API key를 읽거나 복사하거나 내보내지 않고, 계정 회전이나 한도 우회를 하지 않는다. omp 한도가 소진되면 요청은 그대로 실패한다.

경로: Worker → VPC 서비스 `koin-omp-gateway`(HTTP, `127.0.0.1:43129`) → 원격 관리 터널 `koin-omp-gateway-rocky`(Rocky `koin-omp-tunnel.service`, 아웃바운드 전용) → `koin-omp-gateway.service`. 공개 hostname은 없다(koreatech.in 하위 도메인은 koin-web preview 와일드카드가 가로챈다). 설치:

```sh
# 스크립트·유닛 배치 (root)
install -D -m 0644 scripts/autofix/local-omp-gateway.mjs /usr/local/lib/koin-autofix/local-omp-gateway.mjs
install -m 0644 scripts/autofix/koin-omp-gateway.service scripts/autofix/koin-omp-tunnel.service /etc/systemd/system/
# 게이트웨이 전용 HOME: broker bearer 복사 + 게이트웨이 bearer 생성 (homebutler 소유 0600)
install -d -o homebutler -g homebutler -m 0700 /home/user/.home-butler/koin-omp-gateway /home/user/.home-butler/koin-omp-gateway/.omp
install -o homebutler -g homebutler -m 0600 /home/user/.home-butler/auth-home/.omp/auth-broker.token /home/user/.home-butler/koin-omp-gateway/.omp/auth-broker.token
sudo -u homebutler sh -c 'umask 077; node -e "process.stdout.write(require(\"node:crypto\").randomBytes(32).toString(\"hex\"))" > /home/user/.home-butler/koin-omp-gateway/omp-gateway.token'
# 터널 토큰(대시보드 Networks > Tunnels > koin-omp-gateway-rocky)은 /etc/koin-autofix/omp-tunnel.token (root 0600)
systemctl daemon-reload && systemctl enable --now koin-omp-gateway koin-omp-tunnel
# 같은 게이트웨이 bearer를 Worker secret으로 등록
cat /home/user/.home-butler/koin-omp-gateway/omp-gateway.token | pnpm --dir apps/error-automation exec wrangler secret put OMP_GATEWAY_TOKEN
```

게이트웨이 계약:

- `OMP_GATEWAY_TOKEN_FILE`은 현재 uid 소유의 **0600 일반 파일**(symlink 불가)이어야 하며 32–512자 URL-safe 토큰 한 줄을 담는다. 조건이 하나라도 어긋나면 시작하지 않는다. `OMP_GATEWAY_PORT` 기본값은 `43129`다.
- 정확히 `POST /v1/messages`만 받는다(query 포함 다른 경로 404, 다른 메서드 405). bearer는 시간 일정 비교로 먼저 검사하며(실패 401), 인증 전에는 omp를 실행하지 않는다. broker/usage/models 등 다른 게이트웨이 경로는 노출하지 않는다.
- 요청 본문은 1 MiB까지(초과 시 즉시 413 후 연결 종료, 나머지 바이트는 버퍼링하지 않음) JSON 객체여야 하고 `model`은 정확히 `claude-sonnet-5-5` 또는 `claude-opus-5-5`, `max_tokens`는 1–8,192만 허용한다. 퍼지 이름·role(`@smol`)·provider 접두사·`stream`·provider 실행 도구(`type`이 `custom`이 아닌 tool)·알 수 없는 필드는 400이다. 브리지는 도구를 실행하지 않으며 본문을 해석·수정하지 않고 `model`만 `anthropic/<같은 id>`로 바꿔 전달한다.
- 응답은 요청한 모델이 실제로 답한 `message` envelope(`anthropic/<요청 id>` 또는 bare id)일 때만 200이며 `model`을 요청한 bare id로 정규화한다. 다른 모델·fallback chain이 답하면 502다. omp 상위 429는 `rate_limit_error`로 429를 돌려주되 `Retry-After`는 붙이지 않고(stdio는 헤더를 주지 않음), 그 밖의 상위 실패는 상위 오류 문구 없이 502 `upstream_error`다. omp의 오류 문구와 자식 stderr는 로컬 경로·계정 정보를 담을 수 있어 응답·로그 어디에도 쓰지 않는다.
- 동시 요청은 하나만 처리한다(진행 중이면 503 + `Retry-After: 5`, Worker는 이를 종료 실패로 취급). 요청당 180초 기한은 본문 수신부터 적용되어 본문이 멈추거나 추론이 늦으면 504이며, 기한 초과·클라이언트 연결 종료·종료 신호 때 브리지가 띄운 omp 자식을 SIGKILL하고 슬롯을 즉시 비운다. 자식 stdout은 4 MiB까지만 읽고 초과 시 자식을 종료한다. shell을 거치지 않고 `omp auth-gateway stdio`를 직접 실행한다.
- 로그는 경로 분류·상태·소요 시간만 남긴다.
- **자식 환경과 재시도 차단:** omp 자식은 허용 목록 환경만 받는다(`PATH`/`HOME`/`USER`/`TMPDIR`/`LANG`/`LC_*`/`XDG_*`/`PI_CONFIG_DIR`/`PI_PROXY`/proxy 변수/`NODE_EXTRA_CA_CERTS`/`OMP_AUTH_BROKER_*`). `ANTHROPIC_API_KEY`·`ANTHROPIC_OAUTH_TOKEN`·`ANTHROPIC_BASE_URL`·`CLAUDE_CODE_*`·다른 `*_API_KEY`와 운영자의 `PI_CONFIG_FILES`는 전달되지 않으므로 브리지 환경으로 요청을 다른 endpoint나 key로 돌릴 수 없다. 브리지는 시작 시 0600 임시 overlay(`PI_CONFIG_FILES`)로 `retry.enabled=false`, `maxRetries=0`, `modelFallback=false`, `usageAwareFallback=false`, `waitForUsageReset=false`, `rateLimitWalksChain=false`, 두 모델의 `fallbackChains=[]`를 자식 프로세스에만 적용한다(사용자 전역 `config.yml`은 수정하지 않음). 따라서 Worker가 예산에 계산하는 게이트웨이 호출 한 번은 provider 시도 한 번이며, 같은 모델 재시도·다른 모델 fallback·usage reset 대기는 일어나지 않는다. overlay가 stdio에 적용되는 것은 `disabledProviders` overlay로 `/v1/models` 결과가 바뀌는 것으로 확인했고, 실패 상황에서의 fallback 억제 자체는 실제 오류를 유발하지 않고는 관측하지 않았다.
- **시작 게이트:** 시작 시 `GET /v1/models`(quota 소비 없음)로 `anthropic/claude-sonnet-5-5`와 `anthropic/claude-opus-5-5`가 omp의 자격증명 선택에 따라 실제 서비스되는지 확인하고, 하나라도 없으면 listen하지 않고 종료한다. 로그인 만료 등은 요청 시점에 502로 드러나며 브리지가 로그인을 대신 수행하지 않는다.
- **인증 방식 한계:** `omp auth-gateway stdio`는 다른 omp 명령과 같은 자격증명 사다리(runtime key → `models.yml` `apiKey` → 저장된 OAuth → 로그인 저장 key → env → 기타 저장 key)를 쓴다. 저장된 OAuth 로그인이 있으면 env key보다 우선하지만, 브리지가 **OAuth 전용을 강제할 수는 없다**: `apiKeys:false` 계정 풀은 broker 모드 전용이고 로컬 저장소에는 같은 스위치가 없다. 따라서 "OAuth-only"가 아니라 "운영자의 기존 omp 로그인 선택을 그대로 사용"이 정확한 표현이다. 같은 provider의 다른 계정으로의 credential 회전은 설정으로 끄는 항목이 아니며 현재 Anthropic 로그인이 하나뿐이라 발생하지 않는다; 계정을 추가하면 이 전제가 깨진다. 브리지는 로컬 자격증명을 읽거나 삭제·수정하지 않는다.

제한과 해제: 게이트웨이는 공개 주소가 없고 VPC 바인딩을 가진 Worker만 도달하며, bearer가 추가로 접근을 막는다. 게이트웨이 bearer는 연결 인증용 비밀이며 provider 자격증명이 아니다. 해제할 때는 두 유닛을 내리고 토큰 파일을 삭제한 뒤 Worker의 `OMP_GATEWAY_TOKEN`과 VPC 바인딩을 제거한다. 그 시점부터 새 인증 게이트웨이를 설정할 때까지 **모델 처리는 불가능**하며(모델 호출이 설정 오류로 실패), API key를 다시 등록하는 복구 경로는 없다. 게이트웨이는 Rocky와 omp auth-broker 상태에 의존하고, 모델 호출 외의 어떤 Worker 동작(발행·검증·merge)도 바꾸지 않는다.

## 기존 PR 검토·수정 모드 (`mode: 'pull-request'`)

같은 Worker 큐와 실행기 lease를 쓰는 별도 `mode:'pull-request'` 작업이다. 수동 `/executor/pull-requests/enqueue`는 `PR_REVIEW_ENABLED==='true'`와 명시적 허용 PR 번호가 필요하다. 자동 경로는 `PR_REVIEW_ENABLED==='true'` + `PR_REVIEW_AUTO==='true'` + 서명된 `POST /webhooks/github`의 opened/reopened/synchronize/ready_for_review 이벤트다. Worker는 canonical PR을 조회해 fork/draft/봇/보호 ref와 자동화 자신이 생성한 수정 head SHA를 제외하고 실제 develop tip과 head를 pin한다. develop보다 뒤처진 head는 write 토큰 확보 후 SHA당 최대 3번 update-branch를 시도한다(일시적 실패만 재시도, 409/422 충돌은 한 marker 댓글로 종결). 성공 후 synchronize를 기다린다.

claim의 PR 작업 형태: `{mode:'pull-request', owner:'BCSDLab', repository:'BCSD_united', pullNumber, headSha, headTree, headRef, baseBranch:'develop', baseSha, changedFiles:string[], reviewContext:{version:1, comments:[...]}}`. `changedFiles`는 GitHub canonical `pulls/N/files` 파일명(최대 500개, 64KB)이며 **자료**다. `baseSha`는 실제 develop 대상 SHA이고 `headSha`로 대체하지 않는다. `reviewContext`는 GitHub App이 canonical `/pulls/N`에서 읽은 PR 제목(≤300자)·본문(≤4,000자)과 기존 리뷰/댓글(최대 50개, 본문 4,000자, 제어문자 제거, 총 64KB)로, 모델에게 **검증할 가설·자료**로만 전달된다.

실행기는 `headSha`·`baseSha`를 모두 object cache에 고정하고, model/verifier 두 worktree를 **headSha**로 체크아웃한 뒤 `headSha^{tree} == headTree`를 확인한다. 모델 worktree에는 신뢰 git이 만든 `pr-input/review.json`(번호·ref·SHA·changedFiles·reviewContext)과 `pr-input/diff.patch`(`git diff baseSha headSha -- changedFiles`, 512KB 상한)만 추가된다. 모델 도구는 기존 Read/Edit/Write/Glob/Grep 다섯 개 그대로이며:

- **읽기:** `pr-input/*`, changedFiles에 등장하는 `apps/<x>/`, `packages/<x>/` 트리, 공개 루트 의존성/설정(`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, README/CONTRIBUTING), 그리고 changedFiles 자체. `.env*`/`.dev.vars*`/PEM/키/비밀 파일명은 제외. 큰 lockfile도 줄 범위 Read로 검토 가능하다(수정 불가).
- **쓰기:** 관련 앱/패키지 디렉터리 안의 소스·테스트·문서(`ts|tsx|js|jsx|mjs|cjs|scss|css|md|mdx|json`)만. `package.json`/lockfile/`pnpm-workspace.yaml`/`.npmrc`/`wrangler*`/`tsconfig*`/`*.config.*`/Dockerfile/`*.sh`/`.env*`/PEM·키, `.github/`, `scripts/`, `tests/autofix/`, `apps/error-automation/`, generated/routeTree, `apps/api/src/db/schema.ts`는 거부된다. 보호 파일 수정이 필요하면 모델은 이를 **finding으로 보고**해야 하며 조용히 우회하지 않는다. 최대 24개 파일·1MB는 동일하다.

모델 최종 답변의 마지막 ` ```json ` 블록이 구조화 리뷰 `{decision:'approved'|'changes-requested', findings:[{severity:'P1'|'P2'|'P3', path, line, message}]}`다. `approved`는 P1/P2 finding이 0개일 때만, `changes-requested`는 finding 1개 이상일 때만 유효하고 finding ≤50, message ≤1,000자, 제어문자 제거다. 블록이 없거나 enum 밖이면 리뷰를 지어내지 않고 `failed`로 끝난다. 수정 manifest는 `headSha` 기준 `before` SHA256으로 수집되며 **비어 있어도 PR 모드에서만 허용**되고, 그래도 verifier는 반드시 실행된다. 모델 승인은 테스트 증거가 아니다.

독립 verifier(PR 모드)는 pinned head를 object database에서 정확히 복원해 스냅샷하고 `pr-head-pinned`(worktree HEAD·commit·tree·develop base 존재·**`git merge-base --is-ancestor baseSha headSha`**·무변경 확인) 후 신뢰 네트워크 단계에서 `pnpm install --frozen-lockfile --ignore-scripts`를 수행한다. 운영자가 enqueue 전에 각 PR 브랜치를 현재 develop으로 update-branch하므로 base가 head의 조상이 아니면 오래된 통합 상태를 조용히 검토하지 않고 실패한다(실행기는 shallow cache를 최대 3×200 커밋 deepen하여 조상 관계를 판정한다). PR head의 lockfile/lifecycle은 신뢰하지 않으므로 PR 모드 설치 컨테이너는 **root가 아닌 UID 1000**으로만 실행한다. 스냅샷 소스는 컨트롤러 소유·읽기 전용으로 유지하고, 루트 및 `apps/*`·`packages/*` workspace의 `node_modules`만 미리 만들어 CHOWN 전용 도우미로 넘겨 쓰기 마운트한다. `pnpm rebuild --pending`도 소스가 read-only인 오프라인 non-root 컨테이너에서 의존성 디렉터리만 쓰며, 그 직후 수정 manifest 적용 전에 스냅샷을 고정 tree와 다시 대조한다(`patch.mjs` `assertSnapshotMatchesTree`: 모든 고정 blob·symlink·실행 비트 일치, `node_modules` 밖의 추가 파일 없음). 설치·lifecycle이 head 소스를 바꾸거나 파일을 추가하면 실패한다. 종료 시 의존성·scratch 내용은 해당 UID의 무권한 도우미가 제거한 뒤 컨트롤러가 자신의 스냅샷을 회수한다. CAP_FOWNER·DAC_OVERRIDE를 추가하지 않는다. PR 모드에서는 `tests/autofix`를 호스트에 만들지 않으므로 head가 `tests`를 symlink로 바꿔도 호스트 쓰기가 발생하지 않는다. 이후 모든 검사는 기존과 같은 `--network none`, non-root, read-only source 컨테이너다. 수정 manifest는 설치 후 head 위에 적용된다.

`node_modules` 안의 `.vite-temp` 같은 scratch도 그 디렉터리 소유자 UID의 무권한·오프라인 도우미가 경로별 symlink 검사를 거쳐 만든다. 웹 Vite와 B-BOT Vitest의 설정 번들용 `.vite-temp`를 각각 허용하여 설정 파일 옆에 임시 모듈을 쓰지 않게 한다. 컨트롤러가 후보 소유 디렉터리에 직접 mkdir/chmod하거나 이를 위해 권한을 넓히지 않는다. 정리는 상위 의존성 마운트에서 한 번만 수행한다.

B-BOT native fixture 단계만 `node_modules/.vitest-cache`(변환 캐시)와 `apps/b-bot/.data`(기존 검토 HTML 테스트 산출물)를 추가로 쓸 수 있다. 해당 경로가 pinned 소스에 포함되면 거부하며, 모델·타입 검사·빌드·런타임 smoke에 새 쓰기 권한을 주지 않는다. 테스트 종료 후 다른 scratch와 함께 회수한다.

타입 검사는 신뢰 `workspace-typecheck.mjs`가 각 workspace의 기존 `typecheck` 스크립트(예: `nitro prepare && tsc --noEmit`)를 그대로 실행하되, 증분 캐시를 workspace 경로 해시별 `/tmp/*.tsbuildinfo`로 지정한다. 소스를 쓰기 가능하게 만들거나 타입 검사를 생략하지 않으며 병렬 workspace가 같은 캐시 파일을 공유하지 않는다.

B-BOT은 신뢰 `bbot-build.mjs`가 실제 Nitro API의 public asset 복사·prerender·production build·close를 실행한다. `.output` 마운트 자체를 지우는 대신 내용만 완전히 비우고 같은 server/public 디렉터리를 준비한다. build 스크립트·출력 배치가 달라지거나 출력 안에 보존해야 할 public asset이 있으면 실패한다. Wrangler dry-run은 원본 설정의 모든 바인딩을 유지한 사본에서 이미 수행한 custom build 훅만 제거하고 main/assets 경로를 절대 경로로 고정한다. 실제 배포하지 않으며 원본 설정·소스는 바꾸지 않는다.

PR 모드의 온라인 설치에는 `--ignore-pnpmfile`도 강제합니다. `--ignore-scripts`만으로는 `.pnpmfile.cjs` 및 config dependency의 JavaScript 훅 실행이 차단되지 않습니다. 승인된 lifecycle과 후보 코드 실행은 네트워크를 끊은 뒤에만 허용합니다.

런타임 프로필은 changedFiles에서만 도출하는 allowlist다(PR 본문·설정이 명령을 바꾸지 못한다):

| 변경 위치                                                                                             | 프로필          | 실행 내용                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/**`, `packages/telemetry/**`                                                                | web (+api 의존) | `@koin/web...`/`@koin/api...` typecheck·native tests·build, oxlint+ESLint/Stylelint, 로컬 API/D1 GET `/shops/categories`, 홈 `/` SSR + 데스크톱 Chromium + Android Mobile UA/390px TanStack smoke. PR에는 단일 관측 오류 경로가 없으므로 변경된 모든 route의 재현을 주장하지 않는다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/**`                                                                                         | api             | `@koin/api...` typecheck·tests·build, 실제 로컬 Wrangler/D1 GET `/shops/categories`. 신뢰 `local-api.mjs`는 격리 로컬 인스턴스에 **항상** `--var API_ENABLED:true`를 넣는다(게이트 없는 기존 설정에는 no-op, #16의 `"false"` 기본값 설정에서는 업무 경로를 503 없이 검증; 원격 설정은 바뀌지 않음). head 설정이 게이트를 선언하면 추가로 opt-in 없는 인스턴스에서 `503 API_DISABLED`(`Cache-Control: no-store`, `Retry-After`) 비활성 시나리오도 확인                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/b-bot/**`, `apps/b-bot-crawler/**`, `packages/b-bot-ai/**`, `packages/b-bot-database/**`        | b-bot           | `@koin/b-bot...`(+crawler 존재 시) typecheck(`nitro prepare`)·vitest/node native suites·`nitro build`·`wrangler deploy --dry-run`, 그리고 AI 바인딩·build hook·account 없이 로컬 KV/Queue만 가진 smoke 설정 사본으로 `wrangler dev` 후 `GET /health == {ok:true, service:'b-bot'}`와 미지 경로 404 확인. `apps/b-bot-crawler`가 있으면 `crawler-smoke.mjs`가 실제 `tsx src/main.ts` 데몬을 loopback에서 띄운다: 임시 bearer token, scratch SQLite, preflight 존재 검사만 통과시키는 placeholder DB/Cloudflare 문자열, `NOTION_TOKEN` 없음 → `/health` 200, 무토큰/오토큰 401, 미지 job 404, 잘못된 요청 400, 같은 idempotencyKey 재요청 200(같은 id)/다른 본문 409, Notion job이 provider·DB·AI 호출 전에 `failed`로 닫히는지와 job 레코드에 설정값 누출이 없는지 확인(network none). 이는 데몬 health/auth/idempotency/fail-closed 증거일 뿐 **실제 외부 색인 실행의 증거가 아니다**. DB(`DB_*`)·유료 AI(`RUN_AI_LIVE_TESTS`)·Slack·Superset 연동 suite는 env가 없어 skip되며 **실행된 것으로 간주하지 않는다**(Pi 배포는 범위 밖) |
| 루트 `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`/`.npmrc`/`.nvmrc`/`tsconfig*`/`.github/**` | 전체            | 세 프로필 모두                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 앱을 건드리지 않는 PR(문서만, `apps/error-automation`만 등)                                           | 전체            | skip 대신 저장소 전체 검증                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

웹 smoke는 production `KOIN_API_ORIGIN`으로 기존 Worker API 또는 Java `https://api.koreatech.in`(#9) 둘 중 하나만 허용하고, 오프라인에서는 여전히 로컬 `koin-api` auxiliary service binding이 묶여 있어야 한다. 새 synthetic 회귀 테스트는 PR 모드의 요구사항이 아니다(오류 모드만 요구).
검증 설계 근거: [SWE-bench의 fail-to-pass/pass-to-pass 채점](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py)은 새 회귀 assertion과 기존 정상 테스트를 구분한다. [Playwright의 web-first assertion 권장](https://playwright.dev/docs/best-practices#use-web-first-assertions)을 따라 브라우저 로드·요청 종료·홈 위젯 같은 관측 가능한 조건을 제한 시간 동안 폴링하며 고정 3초 대기를 쓰지 않는다. [React hydrateRoot 문서](https://react.dev/reference/react-dom/client/hydrateRoot#caveats)는 서버/클라이언트 최초 렌더 일치를 요구한다. 콘솔과 예외로 노출된 hydration 오류는 실패로 처리하지만 앱이 내부 `onRecoverableError`에서 Sentry로만 전송하고 콘솔을 남기지 않는 경우까지 이 오프라인 smoke가 증명하지는 못한다.

모든 변경 파일은 읽을 수 있지만 설정·의존성·파이프라인은 계속 읽기 전용이다. 허용된 앱/패키지 소스·테스트·문서는 최소 수정할 수 있다. 최종 `findings`에는 수정 후에도 남은 결함만 넣으며, 미해결 P1/P2가 없을 때만 `approved`를 반환한다.

proof는 head/base/manifest SHA와 고정 독립 검증 check 목록에 결속된다. Worker는 pinned head의 correction commit(비-force), 리뷰 댓글과 영수증을 발행한다. 빈 manifest이고 approved·P1/P2 없음·open/non-draft/develop/동일 head/base/mergeable/사람 작성자/`automerge:skip` 라벨 없음인 PR만 저영향 자동 squash merge 후보가 된다. canonical 변경 파일 ≤10, 추가+삭제 ≤300이어야 하고 `.github/`, `scripts/`, `apps/error-automation/`, `apps/api/drizzle/`, migrations, API schema/commerce/identity, auth/payment/session 경로, dependency/config/Dockerfile/`.env*`를 건드리지 않아야 한다. 모든 check run은 completed+success/neutral/skipped이고 commit status는 모두 success여야 한다. pending/failed/불명확한 결과는 merge하지 않고 사유를 댓글·durable receipt에 기록한다. 통과할 때만 `sha=reviewedHead`, `merge_method=squash`, 제목 `<PR 제목> (#번호)`로 develop에 merge한다. main 승격은 수동 merge commit으로 남는다. 실행기는 GitHub 키를 받지 않는다.

대기 중인 head check/status는 종결 skip이 아니라 `pending-checks`로 내구 기록해 2분마다 최대 30분 동안 DO alarm으로 전체 정책을 재평가한다. rename의 이전/현재 경로도 보호 경로 정책에 모두 대입한다. merge 직전 PR의 develop 대상, open/non-draft, 동일 head/base를 다시 확인한다. main ruleset은 merge commit만 허용하여 App의 squash 요청을 GitHub가 거부하는 두 번째 방벽이다. 오류 수정 PR은 App 봇 작성이어서 자동 리뷰 merge 대상이 아니며, 오류 후보는 출처 브랜치(main 또는 develop)에서 검증되고 develop 통합은 PR CI가 검사한다.

proof의 check 목록은 `['pr-head-pinned','native-fixture-tests','typecheck','autofix-security-tests','lint','build','runtime-route-smoke']`와 정확히 같아야 한다. PR 모드의 종결 422/409/400 결과 거절은 동일 payload를 반복하지 않고 한 번 `failed`로 기록한다. 오류 모드의 durable receipt 재전송 계약은 유지한다.

결정적 로컬 검사: `node --test scripts/autofix/security.test.mjs scripts/autofix/executor.test.mjs scripts/autofix/executor-model.test.mjs scripts/autofix/pr-review.test.mjs` (경로 정책, 프로필 도출, reviewContext 경계, 구조화 리뷰 파서, B-BOT smoke 설정, API 게이트 감지, claim union·`leaseExpiresAt` 검증, mock 타이머 기반 lease heartbeat 복구·여유 중단·거부 즉시 중단·정리, `Retry-After` 파싱과 429 재시도의 서버 지연 준수·abort·generation 창·3회 상한·비재시도 실패).

## 프롬프트 출처와 적용 범위

Worker의 정적 source-only system prompt는 아래 공개 구현에서 **원칙만 새로 서술**했다. 실행 중 upstream 프롬프트/스크립트를 다운로드하지 않는다.

- [OpenHands Datadog debugging prompt](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/debug_prompt.jinja) 및 [integration](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/datadog_debugging.py): 오류 데이터→관련 코드→원인 가설→재현→수정 또는 정직한 조사 결과 흐름. upstream의 curl/credential/repo clone/모델 PR 발행 권한은 채택하지 않았다.
- [OpenHands basic agent](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/agent_script.py) 및 [workflow](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/workflow.yml): 명시적인 task/model/API key 연결을 참고하되 upstream runtime URL fetch/광범위 GitHub write 권한은 채택하지 않았다.
- [Sweep planning prompts](https://github.com/sweepai/sweep/blob/a8b8b67bda4f89faac9314d34e7c7d5a64f76046/sweepai/core/planning_prompts.py): 파일·함수 이름을 명시한 원자적 최소 변경, 기존 helper 재사용, placeholder 금지. upstream의 테스트 제외 지침 및 speculative 범위 확대는 채택하지 않았다.
- [Anthropic 모델 개요](https://platform.claude.com/docs/en/models/overview), [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create): Worker가 작업 종류별 정확한 모델 ID(`claude-sonnet-5-5`/`claude-opus-5-5`)와 다섯 파일 도구 schema를 고정하고, 설정된 omp 게이트웨이로만 호출한다.
- [Cloudflare Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/), [Notifications webhook envelope](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/), [공유 비밀 인증](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/).

## 검증 명령

로컬 결정적 행동 검사는 `node --test scripts/autofix/security.test.mjs scripts/autofix/executor.test.mjs scripts/autofix/executor-model.test.mjs scripts/autofix/pr-review.test.mjs scripts/autofix/local-omp-gateway.test.mjs`이다. 전체 독립 verifier는 Linux/WSL2 + Docker, 커밋된 base SHA, 실제 `error-input/context.json`과 `error-patch/patch.json`이 필요하다.

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

### Rocky 실행기 이미지 갱신과 실제 PR 작업 투입

두 이미지의 `/automation`·`/opt/autofix` 검증 스크립트 SHA256(`verify.mjs`, `patch.mjs`, `common.mjs`, `local-api.mjs`, `smoke.mjs`, `api-smoke.mjs`, `bbot-smoke.mjs`, `crawler-smoke.mjs`, `security.test.mjs`, `source-graph.mjs`)이 일치해야 claim이 진행된다. 실행기 서비스가 사용하는 호스트에서 같은 커밋으로 둘 다 다시 빌드한다(`--pull=never`이므로 레지스트리 없이 로컬 태그만 쓴다).

```sh
docker build --tag koin-error-verifier --file scripts/autofix/Dockerfile scripts/autofix
docker build --tag koin-autofix-executor --file scripts/autofix/Executor.Dockerfile scripts/autofix
sudo systemctl restart koin-autofix-executor && sudo journalctl -u koin-autofix-executor -n 50 --no-pager
```

PR 검토 작업은 Worker 배포본의 `PR_REVIEW_ENABLED='true'`와 허용 목록이 켜진 뒤, 실행기와 **같은 고정 ID·scoped token**으로 enqueue한다(토큰은 `/etc/koin-autofix/executor.env`에서만 읽고 셸 history에 남기지 않는다). `headSha`/`baseSha`는 현재 PR head와 현재 `develop` SHA 그대로여야 하며 Worker가 canonical GitHub와 대조한다.

```sh
set -a; . /etc/koin-autofix/executor.env; set +a
HEAD=$(gh pr view 9 --repo BCSDLab/BCSD_united --json headRefOid --jq .headRefOid)
BASE=$(gh api repos/BCSDLab/BCSD_united/git/ref/heads/develop --jq .object.sha)
curl -sS -X POST "$AUTOFIX_WORKER_ORIGIN/executor/pull-requests/enqueue" \
  -H "Authorization: Bearer $AUTOFIX_EXECUTOR_TOKEN" -H 'X-Executor-Id: koin-rocky-umpc' -H 'Content-Type: application/json' \
  -d "{\"version\":1,\"executorId\":\"koin-rocky-umpc\",\"pullNumber\":9,\"headSha\":\"$HEAD\",\"baseSha\":\"$BASE\"}"
# → {"status":"queued","runId":"autofix-…"}; 실행기가 30초 polling으로 claim한다.
curl -sS -X POST "$AUTOFIX_WORKER_ORIGIN/executor/pull-requests/status" \
  -H "Authorization: Bearer $AUTOFIX_EXECUTOR_TOKEN" -H 'X-Executor-Id: koin-rocky-umpc' -H 'Content-Type: application/json' \
  -d '{"version":1,"executorId":"koin-rocky-umpc","runId":"autofix-…"}'
```

상태 영수증의 `result.reviewedHeadSha`/`publishedHeadSha`/`decision`/`passedChecks`/`commentUrl`로 검토·발행 결과를 확인한다. 순서대로 한 PR씩 처리하며 `#7`은 `#3` merge·develop retarget 뒤에만 enqueue한다. 실행기 로그(`journalctl -u koin-autofix-executor`)의 `claim unavailable`/`run failed`는 lease·proof·정책 거부 사유이고, 어떤 경우에도 실행기는 PR을 직접 만들거나 merge하지 않는다.

실제 Rocky 실행기 설치·모델 호출·PR 발행·운영 배포는 별도 명시적 승인과 통합 확인 뒤에만 수행한다. 이 로컬 검증 명령은 provider delivery 또는 운영 PR 성공을 대신하지 않는다.
