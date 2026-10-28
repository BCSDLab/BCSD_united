# Sentry 자동 수정 웹훅

공개 앱과 별도로 실행하는 Cloudflare Worker이다. `POST /webhooks/sentry`만 처리하며 Sentry 원문이나 토큰을 모델에 전달하지 않는다. 배포·Sentry 설정·GitHub dispatch는 로컬 테스트에서 실행하지 않는다.

## 설정

루트에서 `pnpm install --frozen-lockfile` 후 사용한다. Wrangler와 TypeScript, `@cloudflare/workers-types`는 루트 개발 의존성이다.

`wrangler.jsonc`의 빈 변수 네 개를 실제 운영 설정으로 채운다. 비어 있으면 503으로 거부한다.

| 변수 | 값 |
| --- | --- |
| `SENTRY_ORGANIZATION` | 허용할 Sentry 조직 slug 하나 |
| `SENTRY_PROJECTS` | 허용할 프로젝트 slug의 쉼표 구분 목록 |
| `GITHUB_OWNER` | dispatch 대상 저장소 소유자 |
| `GITHUB_REPOSITORY` | dispatch 대상 저장소 이름 |

배포 담당자가 다음 두 secret을 설정한다. 실제 값은 저장소·명령 인자·로그에 남기지 않는다.

```sh
pnpm --dir workers/sentry-automation exec wrangler secret put SENTRY_CLIENT_SECRET
pnpm --dir workers/sentry-automation exec wrangler secret put GITHUB_DISPATCH_TOKEN
```

`SENTRY_CLIENT_SECRET`은 Sentry 내부 통합의 Client Secret이다. `GITHUB_DISPATCH_TOKEN`은 지정 저장소에만 접근하는 fine-grained PAT 또는 별도로 갱신하는 GitHub App 설치 토큰이다. repository dispatch에 필요한 `Contents: write` 권한만 부여한다. 토큰 만료 시 갱신은 배포 담당자가 관리한다. 이 토큰은 Worker에만 존재하고 모델 작업에서는 사용할 수 없다.

`workers_dev`와 preview URL은 기본적으로 꺼져 있다. 운영 담당자가 소유한 도메인에 Worker route/custom domain을 연결하거나 승인 후 `workers_dev`를 활성화해야 실제 웹훅 URL이 생긴다. 계정·도메인·resource ID를 예시 값으로 배포하지 않는다. 최초 배포에서 `v1` migration이 SQLite Durable Object 클래스를 생성한다. 이 migration과 클래스 이름을 중복 방지 기록 유지 중 삭제하지 않는다.

Sentry 내부 통합의 Webhook URL을 `https://<설정한 호스트>/webhooks/sentry`로 지정하고 issue 구독 및 필요한 issue alert action을 설정한다. GitHub 워크플로 설정은 `scripts/sentry/README.md`를 따른다. Worker와 워크플로의 조직/프로젝트 허용 목록을 동일하게 유지한다.

## 전달 및 중복 방지

- 최대 1 MiB의 정확한 요청 바이트에 HMAC SHA-256 `crypto.subtle.verify`를 적용한다. JSON을 재직렬화해 검증하지 않는다.
- 지원 형태: `issue` + `created`, `issue` + `unresolved` + `substatus: regressed`, `event_alert` + `triggered`. 문서에 없는 `issue.regressed` action과 다른 이벤트는 인증 후 무시한다.
- issue는 `data.issue.project.slug` 및 조직이 포함된 issue URL로 식별한다. 예전 `/api/0/issues/<id>/` URL이면 `web_url` 또는 `permalink`의 조직을 사용한다. alert의 숫자형 `data.event.project`를 slug로 오인하지 않고 `data.event.url`의 공식 `/api/0/projects/<org>/<project>/events/<event-id>/` 형태를 사용한다. 이 URL들로 네트워크 요청을 보내지 않는다.
- 전송 데이터는 정확히 `event_type: sentry-autofix`, `client_payload: { sentryIssueId, sentryProject, sentryOrganization }`이다. 저장소·이벤트 종류는 배포 설정/코드가 결정한다. 제목·메시지·stack·사용자 데이터는 무시한다.
- 조직/프로젝트/이슈마다 Durable Object 하나를 사용한다. 같은 객체의 진행 중 요청은 하나의 Promise를 공유하고, GitHub 204 성공만 SQLite에 영속한다. 성공한 이슈는 이후 created/alert/regression 재전달도 중복으로 처리한다. 새 수정 시도가 필요하면 운영자가 GitHub 수동 workflow dispatch를 사용한다.
- Sentry 서명은 timestamp 헤더를 포함하지 않는다. 따라서 timestamp를 보안 근거로 삼지 않고 영속적인 이슈별 기록으로 재생을 막는다.
- GitHub 성공 및 저장 완료 전 성공 응답을 보내지 않는다. GitHub 거부/네트워크 오류는 502, 내부 저장 오류는 503 및 `Retry-After: 30`으로 재시도 가능하다. 실패한 이슈를 영구 중복으로 표시하지 않는다.
- Sentry 문서는 1초 내 응답을 권장한다. GitHub 응답이 느리면 Sentry가 먼저 timeout으로 재전달할 수 있으나 진행 중 요청 공유 및 성공 기록으로 흡수한다. Worker의 GitHub 요청 제한은 8초이다. Sentry의 재전송 정책에만 의존하지 말고 실패 응답을 운영 모니터링한다.
- **GitHub 수락 직후 응답 유실/Worker 종료 시 외부 API와 SQLite 간 exactly-once는 보장할 수 없다.** repository dispatch에는 idempotency key가 없기 때문이다. 이 경우 재전달을 허용하며 워크플로의 이슈별 concurrency, 결정적 이슈 marker, 고정 PR branch가 중복 산출물을 막는다. 성공을 추정해서 이벤트를 버리지 않는다.

## 로컬 검증

```sh
pnpm --dir workers/sentry-automation typecheck
pnpm --dir workers/sentry-automation test
pnpm --dir workers/sentry-automation exec wrangler deploy --dry-run
```

Node 24 테스트는 실제 `node:sqlite`에 동일한 SQL을 실행하고 객체를 재생성하여 영속 중복 방지 전이를 확인한다. 외부 fetch만 가로채므로 GitHub 요청이나 Cloudflare 배포는 발생하지 않는다. Cloudflare output gate와 객체 라우팅은 Node 테스트가 재현하지 않으므로 최종 통합에서 Wrangler/workerd 로컬 smoke를 추가한다.

## 공식 근거

- [Sentry 서명·공통 요청 구조](https://docs.sentry.io/integrations/integration-platform/webhooks/)
- [issue 생성/회귀 형식](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)
- [event_alert 형식](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
- [GitHub repository dispatch API](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
- [SQLite Durable Object migration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
