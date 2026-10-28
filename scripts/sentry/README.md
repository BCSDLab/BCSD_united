# Sentry 오류 → 이슈 → 독립 검증 → PR

이 워크플로는 `apps/sentry-automation`의 서명 검증 Webhook과 연결된다. `apps/web` 프런트와 `apps/api` 백엔드는 서로 독립된 Cloudflare Worker이다. 운영 배포, 실제 오류 발생, GitHub 이슈/PR 생성, 모델 호출은 설치만으로 실행되지 않는다. 기본 브랜치에 워크플로를 반영하고 아래 비밀 및 변수를 구성한 후 유효한 이벤트를 보내야 한다. 자동 merge 및 배포 단계는 없다.

Git 초기화만 한 로컬 저장소에서는 실행할 수 없다. GitHub 원격 저장소 연결, 첫 커밋과 기본 브랜치 push, Actions 활성화가 선행되어야 한다. 자동화가 임의로 원격 저장소를 선택하거나 이전 저장소의 이슈/PR에 쓰지 않는다.

## 데이터 계약과 중복 방지

`repository_dispatch.event_type`은 `sentry-autofix`이며 `client_payload`는 다음 세 필드만 허용한다.

```json
{"sentryIssueId":"12345","sentryProject":"koin-prod","sentryOrganization":"bcsdlab"}
```

ID는 1~20자리 양의 정수 문자열이며 앞자리 0, 숫자 타입, 추가 필드, 다른 조직 및 허용 목록 밖 프로젝트는 거절한다. 저장소, 브랜치, 프롬프트, API 주소를 이벤트가 지정할 수 없다. 수동 `workflow_dispatch` 입력은 ID와 프로젝트뿐이다. 기본 브랜치에서만 실행한다.

Webhook의 Durable Object 중복 방지에 더해 워크플로는 ID별 `concurrency`를 사용한다. 이슈 본문의 `<!-- sentry-autofix:조직:프로젝트:ID -->` 마커를 열린/닫힌 이슈에서 찾는다. GitHub 검색 인덱스의 지연을 피하기 위해 Issues API를 페이지 순회한다. 10,000개를 초과하면 안전하게 중단하므로 해당 규모에서는 운영자가 이슈 보관/색인 정책을 별도로 정해야 한다.

`fix/#<GitHub이슈>/sentry-<SentryID>` 브랜치의 열린/닫힌 PR이 있으면 재사용 안내만 남기고 새 모델 호출을 하지 않는다. 발행 중 장애로 브랜치만 남아 있으면 동일 트리와 부모 커밋인지 확인한 뒤 PR 생성을 재개한다. 다른 내용을 덮어쓰거나 force push하지 않는다. GitHub concurrency는 실행 중 하나와 대기 하나를 유지하므로 동일 ID의 연속 dispatch가 여러 대기 작업을 보장하지는 않는다. 중복 이벤트에는 하나의 실제 수정 실행이면 충분하며 실패 재실행은 수동 dispatch로 한다.

## 저장소 Actions 설정

### Secrets

| 이름 | 사용 작업 | 최소 권한/용도 |
| --- | --- | --- |
| `SENTRY_READ_TOKEN` | prepare만 | 해당 조직의 `event:read`, `project:read` 접근을 가진 별도 Sentry 내부 통합 토큰. 조직 이슈 상세와 최신 이벤트 조회 전용. 발행/관리 토큰을 재사용하지 않는다. |
| `ANTHROPIC_API_KEY` | agent의 공식 Action 입력만 | 별도 Anthropic workspace의 비용 한도 설정 API 키. 셸 env, 진단 JSON, 아티팩트에 기록하지 않는다. |
| `SENTRY_AUTOFIX_APP_PRIVATE_KEY` | publish만 | 아래 GitHub App의 private key. 모델 및 검증 작업에는 전달하지 않는다. |

### Variables

| 이름 | 값 |
| --- | --- |
| `SENTRY_ORGANIZATION` | Webhook과 동일한 조직 slug |
| `SENTRY_PROJECTS` | 쉼표로 구분한 프로젝트 slug 허용 목록 |
| `SENTRY_PROJECT_DOMAINS` | 프로젝트별 명시적 한국어 제목 분류 JSON. 예: `{"koin-prod":"공통"}`. 캠퍼스/비즈니스/유저/공통만 허용한다. 프로젝트 담당자가 실제 범위에 맞춰 지정한다. |
| `SENTRY_PROJECT_APPS` | 프로젝트별 대상 앱 JSON. 예: `{"koin-prod":"web","koin-api":"api"}`. `web`/`api`만 허용하며 한 후보는 해당 앱의 소스만 변경할 수 있다. |
| `SENTRY_ALLOWED_HOSTS` | 이벤트 URL에서 경로만 추출할 허용 hostname 목록. 예: `koreatech.in,stage.koreatech.in`. URL/query/fragment는 모델에 전달하지 않는다. |
| `SENTRY_DISPATCH_BOT` | Webhook dispatch용 GitHub App의 정확한 bot login. 공식 Claude Action이 bot actor를 허용하도록 설정한다. `*`를 쓰지 않는다. |
| `SENTRY_AUTOFIX_APP_ID` | 이 저장소에만 설치한 발행 전용 GitHub App ID |
| `SENTRY_AUTOFIX_USE_GITHUB_TOKEN` | 기본 비설정. 명시적으로 `true`일 때만 발행에 내장 토큰 사용 |

발행 App의 repository 권한은 **Contents: Read & write, Issues: Read & write, Pull requests: Read & write**, Metadata: Read만 필요하다. Workflows, Administration, Secrets, Actions 쓰기는 필요하지 않다. 설치 범위는 이 저장소 하나로 제한한다. Webhook dispatch 토큰, Sentry 읽기 토큰, 발행 App을 분리한다. 발행 App은 코드 실행에 사용하지 않고 REST Git blobs/tree/commit/ref 및 PR API에만 사용한다.

내장 `GITHUB_TOKEN` 대안은 저장소의 “Allow GitHub Actions to create and approve pull requests” 설정이 필요하다. **내장 토큰으로 생성한 PR 이벤트는 다른 Actions CI를 보통 재실행하지 않는다.** 독립 검증은 이미 이 워크플로에서 수행하지만, PR CI 자동 실행이 필요한 운영에서는 App 방식을 사용해야 한다. 내장 토큰 방식은 PR CI를 사람이 별도 실행하는 환경에서만 선택한다. 별도 리뷰어 작업, 자동 리뷰어 지정, 수동 승인 게이트는 추가하지 않는다. 어느 방식이든 자동 승인·merge는 하지 않으며, 생성된 PR은 사람이 일반적인 방식으로 검토할 수 있다.

`ACTIONS_STEP_DEBUG=true`를 설정하지 않는다. 공식 Action의 debug 모드는 전체 모델/도구 출력을 노출할 수 있다. `show_full_output` 및 `display_report`도 끈 상태로 유지한다.

## 실행 및 권한 분리

1. **prepare**: dispatch를 다시 검증하고 기본 브랜치 SHA를 고정한다. 한국어 버그 템플릿으로 이슈를 생성/재사용한다. 고정된 `https://sentry.io/api/0/organizations/<org>/issues/<id>/`와 `events/latest/`를 읽고 프로젝트가 일치하는지 확인한다. 진단에는 제목, 원인, 제한된 exception/frame, 안전한 pathname만 담는다. request headers/body/cookies, user, breadcrumbs, source context, auth token은 저장하지 않는다.
2. **agent**: 고정된 기본 SHA를 `persist-credentials:false`로 checkout한다. 공식 `anthropics/claude-code-action` v1.0.264 커밋 `d70510b174a1244958df0b03166a54912811f3e6`을 사용한다. 작업 토큰은 Contents read뿐이다. 모델에게 GitHub 쓰기 토큰 또는 Sentry 토큰을 제공하지 않는다. 소스와 진단의 모든 문자열은 지시가 아니라 공격자가 제어할 수 있는 데이터이다.
3. 모델의 도구는 **Read/Edit/Write/Glob/Grep만** 설치한다. 셸, 서브에이전트, 네트워크, MCP, 노트북 실행을 제공하지 않는다. `--setting-sources ""`와 strict empty MCP로 저장소/사용자 설정이 다른 실행 경로를 추가하지 못하게 한다. 신뢰된 PreToolUse hook이 실제 경로를 검사해 `apps/web/src`, `apps/api/src`, 새 `tests/sentry/*.test.mjs`, 진단 JSON 외의 읽기/쓰기를 차단한다. `apps/sentry-automation` 자체, `.git`, `/proc`, 홈 디렉터리, workflow 및 hook에 접근할 수 없다. 이 **도구 권한 sandbox**는 프롬프트 문구와 독립적이다. 모델의 코드 실행은 하지 않는다.
4. **verify**: 별도 깨끗한 runner에서 후보 JSON을 검사한다. 24개 파일, 파일당 256KB, 전체 1MB, 정규 텍스트와 지정 확장자만 허용한다. 경로 순회/중복/심볼릭 링크/생성 코드/설정/스크립트/lockfile/기존 테스트 변경을 거절하고 기본 파일의 SHA256을 확인한다.
5. 기본 코드의 의존성만 Node 24.22.1 + pnpm 10.32.1 Docker 환경에서 `pnpm install --frozen-lockfile`로 설치한다. 후보를 적용하기 전에 설치를 끝낸다. 그 다음 모든 후보 실행은 **네트워크 없음, GitHub/Sentry/Anthropic/Cloudflare 자격증명 없음, Docker socket 없음, non-root, capability 제거, resource 제한** 환경에서 수행한다. 전체 소스/테스트/설정/의존성은 읽기 전용이다. 빌드/preview의 명시적 출력 디렉터리만 쓰기가 가능하다. 호스트의 신뢰된 스크립트가 각 컨테이너의 종료 코드를 직접 검사한다.
6. 새 `node:test` 회귀가 원본에서 `ERR_ASSERTION`으로 실패하고 수정 후 통과해야 한다. loader/import 오류는 재현 성공이 아니다. 루트의 aggregate `pnpm typecheck`, `pnpm lint`, `pnpm build`를 실제 실행한다. 기본 소스/설정/의존성은 읽기 전용이며 앱별 `dist`, `.wrangler`와 웹 빌드 캐시만 쓰기를 허용한다. 웹의 `apps/web/src/routeTree.gen.ts`는 커밋된 최신 상태여야 한다.
   - 웹 프로젝트는 이벤트 pathname을 `apps/web/src/routes` 및 해당 앱 tsconfig의 정적 import 그래프에 연결한다. 모든 변경 소스가 해당 경로에서 도달 가능해야 한다. 독립 로컬 API Worker를 먼저 시작하고 `pnpm preview --host 127.0.0.1 --port 4173`와 Chromium으로 DOM, URL, 페이지 로드, 문서 상태, 미처리 예외 및 console.error를 검사한다.
   - API 프로젝트는 정식 이벤트의 메서드가 GET이고 `apps/api/src`의 정적 `app.get` 등록 경로에 연결되어야 한다. 해당 핸들러의 import 그래프와 Worker 진입점으로 변경 범위를 확인한다. 실제 로컬 Worker에 GET을 보내 2xx 및 유효한 JSON 응답을 확인한다. 인증, 필수 query, 운영 fixture가 필요한 응답이나 동적 경로를 판별할 수 없으면 실패한다. POST/PUT/PATCH/DELETE를 자동 재생하지 않는다.
   - API 실행은 `pnpm --filter @koin/api db:migrate:local` 후 `pnpm --filter @koin/api dev --local --ip 127.0.0.1 --port 4174`이다. 준비 상태는 `/health`로 확인한다. D1은 폐기 가능한 로컬 DB뿐이다. 웹의 `NEXT_PUBLIC_API_PATH`는 `http://127.0.0.1:4174`이며 모든 후보 실행의 외부 네트워크는 차단된다. 실제 인증/운영 데이터는 사용하지 않는다.
7. 안전한 이벤트 URL이 없거나 라우트/변경 관계를 결정할 수 없거나, 로컬 API 데이터 부재로 화면이 실패하면 **검증을 생략하지 않고 실패**한다. SSR/브라우저 smoke는 기능별 사용자 인터랙션의 완전한 대체가 아니다. 테스트 타당성과 UI는 사람의 리뷰가 필요하다.
8. **publish**: 성공한 verify 아티팩트의 hash, run ID, 기본 SHA와 검증 목록을 확인한다. 기본 브랜치가 실행 중 바뀌면 발행하지 않는다. 후보 코드를 실행/checkout하지 않고 검증한 파일 bytes만 GitHub Git API로 발행한다. 한국어 conventional commit, 링크된 이슈, 실제 통과한 체크만 포함하는 PR을 만든다.
9. 실패/변경 없음은 별도 **outcome** 작업이 이슈에 단계 결과와 실행 로그 링크를 남긴다. 진단 원문, 모델 주장, 토큰을 댓글에 복사하지 않는다. 불완전한 수정 PR을 만들지 않는다.

Claude Action은 자체 git 초기화에 read-only 토큰을 사용할 수 있으므로 checkout의 `persist-credentials:false`만으로 보안을 설명하지 않는다. 실제 경계는 읽기 전용 작업 권한, 실행 도구 제거, 고정 hook의 파일 접근 검사, 별도 verifier/publisher이다. 생성 코드 자체가 악성일 가능성도 있으므로 verifier에 호스트 권한이나 네트워크를 추가해서는 안 된다.

## 개인정보 및 운영 전제

진단은 최소화하지만 exception 메시지/파일 이름에도 개인정보가 들어갈 수 있다. **Sentry 서버 측 data scrubbing 및 SDK의 beforeSend 정책을 먼저 구성**해야 한다. 진단은 Anthropic으로 전달되며 GitHub Actions 아티팩트에 최대 1일 보관된다. 공개 저장소의 Actions 로그/아티팩트 접근 정책을 확인하고 개인정보를 제거하기 전에는 자동화를 활성화하지 않는다. Sentry token은 아티팩트에 저장하지 않는다.

실제 루트 원인이 dependency, workflow, generated file, 서버 데이터, 인증된 화면, 외부 API에 있거나 Node 기반 회귀 테스트로 재현할 수 없으면 이 자동화의 안전 범위를 벗어난다. 범위를 임의로 넓히지 말고 실패 이슈를 사람이 처리한다. Worker의 webhook ack 성공 후 GitHub 작업이 실패한 경우 동일 웹훅 재전송은 DO에서 중복으로 처리될 수 있으므로 Actions 수동 dispatch를 사용한다.

## 로컬 결정적 검사

아래 명령은 네트워크/모델/GitHub/Sentry 요청 없이 payload 검증, 경로 제한, 크기 제한, baseline hash 및 symlink 거절을 검사한다.

```sh
node --test scripts/sentry/security.test.mjs
node --check scripts/sentry/prepare.mjs
node --check scripts/sentry/verify.mjs
node --check scripts/sentry/smoke.mjs
node --check scripts/sentry/api-smoke.mjs
node --check scripts/sentry/local-api.mjs
node --check scripts/sentry/source-graph.mjs
node --check scripts/sentry/publish.mjs
```

전체 verifier는 Linux 또는 WSL2 + Docker, 커밋된 기본 SHA, `sentry-input/context.json`, `sentry-patch/patch.json`의 실제 로컬 입력이 필요하다. 토큰 없이 다음 명령을 사용한다. Docker image/dependencies 다운로드만 네트워크를 사용하며 후보 실행은 offline이다.

```sh
docker build --tag koin-sentry-verifier --file scripts/sentry/Dockerfile scripts/sentry
node scripts/sentry/verify.mjs
```

`prepare.mjs`, `publish.mjs`, `report.mjs`는 실제 외부 API에 쓰는 운영 스크립트이다. 로컬 단위 테스트 대신 실행하지 않는다. 초기 운영 점검은 별도 테스트용 저장소/Sentry 프로젝트에서 명시적으로 승인한 이벤트로 진행한다.

## 1차 자료

- [Claude Action security 및 credential guidance](https://github.com/anthropics/claude-code-action/blob/d70510b174a1244958df0b03166a54912811f3e6/docs/security.md)
- [고정 버전의 Action 입력](https://github.com/anthropics/claude-code-action/blob/d70510b174a1244958df0b03166a54912811f3e6/action.yml)
- [Claude 도구 권한](https://code.claude.com/docs/en/permissions)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [GitHub GITHUB_TOKEN의 이벤트 재실행 제한](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
- [Sentry 이슈 상세 API](https://docs.sentry.io/api/events/retrieve-an-issue/)
- [Sentry 최신 이벤트 API](https://docs.sentry.io/api/events/retrieve-an-issue-event/)
