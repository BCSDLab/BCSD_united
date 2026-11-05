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

`AUTOFIX_EXECUTOR_ID=koin-rocky-umpc`로 고정한다. 실행기는 고정 HTTPS Worker origin에만 `Authorization: Bearer <AUTOFIX_EXECUTOR_TOKEN>` 및 `X-Executor-Id: koin-rocky-umpc`를 보내며 호스트 인바운드 네트워크 포트를 열지 않는다. `/executor/claim`의 `claimNonce` 64자리 hex를 비밀 파일과 분리해 먼저 영속하고, 응답 유실 때 같은 nonce로 동일 lease를 재요청한다. 204는 대기 작업 없음, 200은 고정 repo/base SHA/diagnostics/context/issue/lease. 2분 rolling heartbeat·90분 절대 기한·동시 한 작업을 적용한다. claim(신규·재개 모두)은 Worker가 확인한 `leaseExpiresAt`(안전 정수, 미래, `deadlineAt` 이하)을 반드시 포함하며, 실행기는 이를 마지막 확인 만료로 삼아 시작한다.

실행기 lease 유지(`keepLease`): heartbeat는 45초 간격이며 한 번에 하나만 보낸다. Worker가 확인한 마지막 `leaseExpiresAt`만 사실로 취급하고, 확인되지 않은 heartbeat는 lease를 연장한 것으로 간주하지 않는다. 연결 시간 초과·연결 거부/재설정·네트워크 도달 불가·30초 요청 시간 초과 같은 전송 계층 실패만 5초 뒤 재시도하되, 마지막 확인 만료에서 15초 안전 여유를 뺀 시점 안에 재시도가 들어갈 때만 한다. HTTP 상태 거부(인증·정책·409 등), TLS 실패, 잘못된 응답 본문, `deadlineAt` 불일치, 15초 여유보다 짧은 만료는 즉시 작업을 중단한다. 독립 fail-closed 타이머가 확인 만료 − 15초에 작업을 중단하므로 heartbeat 요청이 멈춰도 알려진 lease를 넘겨 실행하지 않으며, 그때 진행 중인 heartbeat 요청도 취소한다. 작업 완료·종료 시 타이머와 진행 중 요청을 모두 정리해 늦게 도착한 응답이 다음 작업에 영향을 주지 않는다. 확인 만료가 이미 절대 기한과 같으면 더 연장할 수 없으므로 heartbeat를 보내지 않는다.

`/executor/jobs/<runId>/model`은 살아 있는 generation lease에서만 요청한다. Worker가 정적 system prompt/고정 Fable 모델/Read·Edit·Write·Glob·Grep JSON schema만 Anthropic `/v1/messages`로 전송하고 API key를 Worker 밖에 내보내지 않는다. 모델 메시지의 파일 요청은 실행기에서 허용 경로·symlink·앱 경계를 다시 검사한다. 단일 오류 수정은 모델 40회·80개 메시지·256 KB context, PR 검토는 모델 80회·160개 메시지·1 MB context로 제한한다. generation 20분과 응답 256 KB 한도는 공통이다. 파일 도구는 단일 오류 수정에서 40회, 여러 파일의 diff와 관련 코드를 검토하는 PR에서 256회까지 허용한다. PR 검토는 diff 중심의 좁은 줄 범위와 독립 읽기 묶음을 사용한다. 후보 workspace는 이슈 진단을 **자료**로만 다루며 shell/network/MCP/GitHub credential을 사용할 수 없다.

요청당 출력 토큰은 오류 수정 4,096개, PR 검토 16,384개까지 허용한다. 큰 수정 응답이 중단되면 제공자의 `stop_reason`만 제한된 진단에 남기며, 거절·중단을 승인으로 취급하지 않는다.

PR 모델 요청은 Worker에서 최대 180초, 실행기에서 최대 190초까지 기다리되 실행기는 남은 19분 generation 시간으로 다시 제한한다. 오류 수정의 기존 90초/100초 한도는 유지한다. 모든 실행기 모델 요청은 작업 abort와 연결되어 lease 상실·종료 시 취소되며, 호출 시간 초과를 자동 재시도하거나 검증 성공으로 처리하지 않는다.

제공자 429 처리(`requestModel`): Worker는 upstream Anthropic 429가 숫자 `Retry-After`를 싣고 spend cap(`enforced_spend_limit_reached`)이 아닐 때만 `/model`에 429와 canonical 십진 정수 `Retry-After`(1~3600초)를 돌려준다. 실행기는 그 429에 한해 **같은 요청 바이트**(대화 transcript 무변경)를 최대 3회 재전송하되, 서버 지연 이상을 기다리고 대기가 남은 19분 generation 창 안에 끝날 때만 한다. 창을 넘는 지연은 더 짧게 기다리지 않고 즉시 실패하며, 대기 중 작업 abort(기한·lease 상실·종료)는 재시도를 취소한다. 헤더가 없거나 잘못된 429, spend cap, 400/401/403, 503, TLS/전송 실패, 잘못된 본문은 재시도하지 않는다. lease heartbeat는 대기와 무관하게 독립적으로 이어지고, 429로 끝난 요청도 Worker의 모델 호출 상한에 그대로 계산된다. 운영 로그에는 `retryAfterSeconds`와 재시도 횟수만 남기고 제공자 응답 본문은 기록하지 않는다.

자원 프로필은 검증 컨테이너당 RAM 최대 **3 GiB**, CPU 2개다. 시작 시 가용 메모리 **5 GiB**를 확인해 검증기 상한 외에 2 GiB 여유를 둔다. 컨트롤러의 기존 2 GiB 상한은 유지하고, workspace 타입 검사·테스트·빌드는 하나씩 실행해 중첩 메모리 피크를 줄인다. 한도 초과로 검증 프로세스가 종료되면 실패로 처리하며 검증 생략·자동 한도 상향·다른 서비스 중지는 하지 않는다.

실행기는 공개 저장소의 검증된 고정 SHA를 각 작업의 별도 model/verifier git worktree로 준비한다. verifier image는 미리 빌드해 재사용하되, 후보 소스는 독립적인 새 검증 작업공간/매번 disposable Docker 실행으로 검증한다. `/verification-start` 이후 모델 프록시는 닫힌다. source-only 모델이 낸 manifest는 최대 24 text 파일, 파일당 256 KB, 합계 1 MB이며 수정 앱 src와 새 `tests/autofix/*.test.mjs`로만 제한한다. 기존 테스트/설정/lockfile/schema/generated 변경과 다른 앱 변경은 거부한다.

독립 검증은 수정 전 새 assertion 실패/수정 후 통과, 기존 native fixtures와 autofix 보안 테스트, 타입/lint/build, 실제 로컬 API+D1+SSR+Chromium/390px 모바일 smoke를 수행한다. 네트워크 없는 Docker, 비루트/capability 제거, read-only source/dependencies와 제한된 scratch를 사용한다. proof는 base SHA·검증된 manifest SHA256·정확한 필수 check 목록에 결속한다. Worker는 원본 기본 브랜치 SHA가 전진하지 않았는지 재조회하고 verified bytes만 Git tree/commit/PR로 발행한다. force push, 자동 merge/배포는 없다. 실행·검증 실패나 무변경은 verified PR로 표시하지 않고 이슈에 원문 비밀 없이 사실만 남긴다.

Rocky/UMPC의 root 신뢰 실행기는 고정 SHA 소스에서 후보와 독립 검증 worktree를 분리하고, 사전 빌드된 **두 이미지의 검증 스크립트 SHA256 일치**를 작업 전·검증 전 확인한다. 검증 스냅샷은 `git archive`가 아니라 고정 tree의 `git ls-tree -r` + `git cat-file --batch`로 object database에서 그대로 복원한다(`patch.mjs` `exportTree`). 따라서 스냅샷 안의 `.gitattributes`(`export-ignore`/`export-subst`)는 어떤 파일도 빼거나 바꿀 수 없고, 심볼릭 링크는 링크로 기록될 뿐 호스트 쓰기에서 따라가지 않으며 submodule·알 수 없는 mode는 실패한다. 검증용 의존성은 자격 증명 없는 신뢰 설치 컨테이너에서 `pnpm install --frozen-lockfile --ignore-scripts`로 획득하고(유일한 네트워크 단계, lifecycle 없음), 승인된 lifecycle `pnpm rebuild --pending`은 **별도의 `--network none`, non-root 컨테이너**에서 소스·설정·테스트가 모두 read-only이고 설치기가 만든 실제 `node_modules` 디렉터리만 쓰기 가능한 상태로 실행한다. 이후의 회귀·타입·lint·빌드·API/D1/SSR/브라우저 확인은 별도 매번 폐기되는 `--network none`, cap-drop-all, no-new-privileges, non-root 컨테이너에서 수행한다. 설치와 후보 실행은 동일 컨테이너가 아니며 모델은 어떤 코드를 실행하거나 Docker socket을 읽지 못한다. root 컨트롤러에 CAP_CHOWN을 추가하지 않고, 고정 scratch·의존성 디렉터리만 마운트한 신뢰 CHOWN 전용 도우미와 UID 1000의 무권한 정리 도우미가 소유권·회수를 처리한다.

두 단계는 `PNPM_CONFIG_CACHE_DIR=/work/node_modules/.cache/pnpm`을 공유한다. 온라인 획득 단계의 공급망 정책 검증 캐시를 오프라인 rebuild에서도 사용하며, 정책 검사 자체를 끄거나 lifecycle에 네트워크를 열지 않는다.

heartbeat 실패 원인(원인 체인의 오류 코드 포함)과 중단·실패한 하위 명령의 마지막 12 KB는 실행기 운영 로그에만 남긴다. URL과 긴 토큰형 문자열은 제거하고 사유는 500자로 제한하며, 이 진단을 PR 댓글이나 검증 성공 증거로 사용하지 않는다.

2026-10-29 Rocky 호스트에서 고정 커밋 `68c6d24`의 root 컨트롤러 이미지로 오프라인 전체 스모크가 종료 코드 0으로 완료됐다. 검증 코드가 Docker 내부 `id -u`의 비루트 일치를 확인했고, 실제 로컬 API/D1 GET·홈 SSR/Chromium·390px 모바일 게이트가 통과했으며 격리 컨테이너와 소스 스냅샷 정리까지 끝났다. 이는 후보 패치의 회귀 전후 검증, 실제 제공자 호출 또는 운영 PR 발행의 증거는 아니다.

검증 세부 조건:

1. **검증 격리:** 별도 깨끗한 worktree에서 24개 파일/파일당 256KB/총 1MB/일반 파일/앱 경계/baseline SHA256을 검사한다. 기본 코드에 frozen install을 끝낸 다음 후보를 적용한다. 이후 모든 실행은 네트워크·자격증명·Docker socket 없이 non-root/capability 제거/resource 제한 컨테이너에서 수행한다. 소스/설정/테스트/의존성은 read-only이며 빌드·런타임 출력 디렉터리만 명시적으로 쓸 수 있다.
2. 새 `tests/autofix/*.test.mjs`는 수정 전 실제 assertion 실패, 수정 후 통과해야 한다. loader/setup 실패는 재현이 아니다. API 후보는 `@koin/api...`, 웹 후보는 추가로 `@koin/web...` 의존성 범위의 기존 native fixtures·타입·빌드를 검사하고 autofix 보안 테스트와 해당 범위 lint를 수행한다. B-BOT의 별도 PostgreSQL 런타임은 이 자동 수정 대상이 아니며 저장소 전체 검증에서 따로 검사한다. 기존 fixture/test 파일은 패치에서 수정할 수 없다.
3. 웹은 정적 route/import graph에서 모든 변경 소스가 관측 경로에 도달하는지 확인한다. 웹 검증 전 로컬 D1 migration을 적용하고, Vite 빌드에 검증 전용 `koin-api` auxiliary Worker를 포함하여 SSR service binding과 브라우저 gateway가 동일한 실제 로컬 API/D1을 사용하게 한다. API smoke는 별도 실제 Wrangler Worker에서 관측된 GET endpoint 실행과 2xx/JSON을 확인한다. API 요청 로그와 SSR 전후 요청 수, 브라우저 응답 본문을 대조한다. 데스크톱 후 앱 문서를 떠난 다음 390px 모바일 문서를 새로 열어 실제 홈 인사·식단 위젯·gateway와 콘솔/HTTP 오류를 확인한다. 빈 로컬 D1에서 `/weather` 503과 `/coopshop/1` 404는 정확한 API 오류 코드와 명시적 unavailable/빈 식단 UI를 모두 확인한 경우에만 허용한다. 임시 entrypoint·registry·브라우저 프로필·프로세스·컨테이너·source snapshot을 정리한다. mutating 요청/인증/필수 query/운영 데이터 의존은 자동 재생하지 않으며 운영 데이터나 가짜 fallback을 사용하지 않는다.

## 기존 PR 검토·수정 모드 (`mode: 'pull-request'`)

같은 Worker 큐·같은 실행기 lease·같은 모델 프록시를 쓰는 **별도 typed union**이다. 오류 작업(Sentry/CF)은 `mode` 없이 기존 형태 그대로이고, PR 작업만 `mode:'pull-request'`를 갖는다. 가짜 오류 identity를 만들지 않으며 `/executor/pull-requests/enqueue`(운영자 opt-in `PR_REVIEW_ENABLED==='true'` + 허용 PR 번호 목록)가 Worker 쪽 유일한 진입점이다. 실행기는 요청 본문에서 저장소·모델·URL·프롬프트·명령·경로를 절대 받지 않는다.

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
| `apps/web/**`, `packages/telemetry/**`                                                                | web (+api 의존) | `@koin/web...`/`@koin/api...` typecheck·native tests·build, oxlint+ESLint/Stylelint, 로컬 API/D1 GET `/shops/categories`, `/` SSR + 데스크톱 Chromium + 390px 모바일 TanStack smoke(기존 그대로)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/api/**`                                                                                         | api             | `@koin/api...` typecheck·tests·build, 실제 로컬 Wrangler/D1 GET `/shops/categories`. 신뢰 `local-api.mjs`는 격리 로컬 인스턴스에 **항상** `--var API_ENABLED:true`를 넣는다(게이트 없는 기존 설정에는 no-op, #16의 `"false"` 기본값 설정에서는 업무 경로를 503 없이 검증; 원격 설정은 바뀌지 않음). head 설정이 게이트를 선언하면 추가로 opt-in 없는 인스턴스에서 `503 API_DISABLED`(`Cache-Control: no-store`, `Retry-After`) 비활성 시나리오도 확인                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/b-bot/**`, `apps/b-bot-crawler/**`, `packages/b-bot-ai/**`, `packages/b-bot-database/**`        | b-bot           | `@koin/b-bot...`(+crawler 존재 시) typecheck(`nitro prepare`)·vitest/node native suites·`nitro build`·`wrangler deploy --dry-run`, 그리고 AI 바인딩·build hook·account 없이 로컬 KV/Queue만 가진 smoke 설정 사본으로 `wrangler dev` 후 `GET /health == {ok:true, service:'b-bot'}`와 미지 경로 404 확인. `apps/b-bot-crawler`가 있으면 `crawler-smoke.mjs`가 실제 `tsx src/main.ts` 데몬을 loopback에서 띄운다: 임시 bearer token, scratch SQLite, preflight 존재 검사만 통과시키는 placeholder DB/Cloudflare 문자열, `NOTION_TOKEN` 없음 → `/health` 200, 무토큰/오토큰 401, 미지 job 404, 잘못된 요청 400, 같은 idempotencyKey 재요청 200(같은 id)/다른 본문 409, Notion job이 provider·DB·AI 호출 전에 `failed`로 닫히는지와 job 레코드에 설정값 누출이 없는지 확인(network none). 이는 데몬 health/auth/idempotency/fail-closed 증거일 뿐 **실제 외부 색인 실행의 증거가 아니다**. DB(`DB_*`)·유료 AI(`RUN_AI_LIVE_TESTS`)·Slack·Superset 연동 suite는 env가 없어 skip되며 **실행된 것으로 간주하지 않는다**(Pi 배포는 범위 밖) |
| 루트 `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`/`.npmrc`/`.nvmrc`/`tsconfig*`/`.github/**` | 전체            | 세 프로필 모두                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 앱을 건드리지 않는 PR(문서만, `apps/error-automation`만 등)                                           | 전체            | skip 대신 저장소 전체 검증                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

웹 smoke는 production `KOIN_API_ORIGIN`으로 기존 Worker API 또는 Java `https://api.koreatech.in`(#9) 둘 중 하나만 허용하고, 오프라인에서는 여전히 로컬 `koin-api` auxiliary service binding이 묶여 있어야 한다. 새 synthetic 회귀 테스트는 PR 모드의 요구사항이 아니다(오류 모드만 요구).

모든 변경 파일은 읽을 수 있지만 설정·의존성·파이프라인은 계속 읽기 전용이다. 허용된 앱/패키지 소스·테스트·문서는 최소 수정할 수 있다. 최종 `findings`에는 수정 후에도 남은 결함만 넣으며, 미해결 P1/P2가 없을 때만 `approved`를 반환한다.

proof는 `{headSha, baseSha, sha256(manifest), checks:['pr-head-pinned','native-fixture-tests','typecheck','autofix-security-tests','lint','build','runtime-route-smoke'], profiles}`이며 실행기가 headSha/baseSha/sha256/check 목록을 대조한 뒤 `{outcome:'pr-reviewed', manifest, review, verification:{headSha, baseSha, manifestSha256, passedChecks}}`를 제출한다. 어떤 check라도 실패하면 `failed` + 사유다. **PR 모드에 한해** Worker가 `pr-reviewed` 결과를 422/409/400으로 거부하면 같은 bytes를 무한 재시도하지 않고 한 번 `failed` 기록으로 낮춘 뒤 nonce를 돌린다(오류 모드의 durable receipt 재전송 의미는 그대로다). 발행(원본 head 부모의 correction commit, 비-force head 갱신, 리뷰 COMMENT, 영수증)과 merge 판단은 Worker/운영자 몫이며 실행기는 GitHub 자격 증명을 갖지 않는다.

결정적 로컬 검사: `node --test scripts/autofix/security.test.mjs scripts/autofix/executor.test.mjs scripts/autofix/executor-model.test.mjs scripts/autofix/pr-review.test.mjs` (경로 정책, 프로필 도출, reviewContext 경계, 구조화 리뷰 파서, B-BOT smoke 설정, API 게이트 감지, claim union·`leaseExpiresAt` 검증, mock 타이머 기반 lease heartbeat 복구·여유 중단·거부 즉시 중단·정리, `Retry-After` 파싱과 429 재시도의 서버 지연 준수·abort·generation 창·3회 상한·비재시도 실패).

## 프롬프트 출처와 적용 범위

Worker의 정적 source-only system prompt는 아래 공개 구현에서 **원칙만 새로 서술**했다. 실행 중 upstream 프롬프트/스크립트를 다운로드하지 않는다.

- [OpenHands Datadog debugging prompt](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/debug_prompt.jinja) 및 [integration](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/04_datadog_debugging/datadog_debugging.py): 오류 데이터→관련 코드→원인 가설→재현→수정 또는 정직한 조사 결과 흐름. upstream의 curl/credential/repo clone/모델 PR 발행 권한은 채택하지 않았다.
- [OpenHands basic agent](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/agent_script.py) 및 [workflow](https://github.com/OpenHands/software-agent-sdk/blob/46b1fa5cb91ada17e6ec938c7e8624a4fa19fa98/examples/03_github_workflows/01_basic_action/workflow.yml): 명시적인 task/model/API key 연결을 참고하되 upstream runtime URL fetch/광범위 GitHub write 권한은 채택하지 않았다.
- [Sweep planning prompts](https://github.com/sweepai/sweep/blob/a8b8b67bda4f89faac9314d34e7c7d5a64f76046/sweepai/core/planning_prompts.py): 파일·함수 이름을 명시한 원자적 최소 변경, 기존 helper 재사용, placeholder 금지. upstream의 테스트 제외 지침 및 speculative 범위 확대는 채택하지 않았다.
- [Claude Fable 5.1 공식 모델 ID](https://platform.claude.com/docs/en/models/fable-5-1/overview), [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create): Worker가 `claude-fable-5-1`과 다섯 파일 도구 schema 및 `ANTHROPIC_API_KEY`를 고정한다.
- [Cloudflare Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/), [Notifications webhook envelope](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/), [공유 비밀 인증](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/).

## 검증 명령

로컬 결정적 행동 검사는 `node --test scripts/autofix/security.test.mjs scripts/autofix/executor.test.mjs scripts/autofix/executor-model.test.mjs scripts/autofix/pr-review.test.mjs`이다. 전체 독립 verifier는 Linux/WSL2 + Docker, 커밋된 base SHA, 실제 `error-input/context.json`과 `error-patch/patch.json`이 필요하다.

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

실제 Rocky 실행기 설치·모델 호출·이슈/PR 발행·운영 배포는 별도 명시적 승인과 통합 확인 뒤에만 수행한다. 이 로컬 검증 명령은 provider delivery 또는 운영 PR 성공을 대신하지 않는다.
