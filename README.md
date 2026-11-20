# BCSD United

KOIN 웹앱과 관련 Worker를 함께 관리하는 Cloudflare 기반 모노레포입니다.

## 구성

```text
apps/
  web/                 TanStack Start 프론트엔드·SSR Worker
  api/                 Hono API Worker (레거시 D1 비활성, KOIN_DB 배치·식단·시내버스 API)
  b-bot/               Slack 봇 Worker
  attendance/          비공개 Pi 관측 스냅샷 뷰어·오류 수신/Rocky 읽기 전용 모니터
  error-automation/    오류 웹훅 수신과 자동 수정 작업 시작
packages/
  telemetry/           공통 민감정보 마스킹
  b-bot-ai/            봇 모델 호출과 응답 검증
  b-bot-database/      봇 PostgreSQL 연결·이관 도구
scripts/
  autofix/             자동 수정 검증과 PR 발행
```

- 프론트엔드: React 19, TanStack Start/Router, React Query, Zustand, SCSS Modules + 식단 CSS Modules
- 업무 API: 기존 Java 서버(KOIN_API_V2)를 사용합니다. `apps/api`는 식단·시내버스 등 일부 API만 KOIN_DB 모드로 처리하고, 레거시 D1 API는 보존합니다.
- 도구: pnpm workspace, oxlint, oxfmt, TypeScript, ESLint·Stylelint(웹)
- 식단 화면은 끼니별 탭과 메뉴 카드를 사용하며, 사진이 미등록된 코너는 큰 이미지 자리 대신 상태 문구를 표시합니다. 등록된 사진은 확대해서 볼 수 있습니다.

## 개발 환경

Node.js `24.22.1`(`.nvmrc`), pnpm `12.16.1`(`packageManager`)을 사용합니다.

```sh
corepack pnpm install --frozen-lockfile
pnpm dev
```

| 명령             | 대상 | 주소                    |
| ---------------- | ---- | ----------------------- |
| `pnpm dev:web`   | 웹   | `http://localhost:3000` |
| `pnpm dev:api`   | API  | `http://localhost:8787` |
| `pnpm dev:b-bot` | 봇   | `http://localhost:8793` |

레거시 API를 로컬에서 실행하려면 `pnpm --filter @koin/api dev --var API_ENABLED:true`를 사용합니다.

### 로컬 설정

| 위치                    | 용도                                      |
| ----------------------- | ----------------------------------------- |
| `apps/web/.env.local`   | 공개 API 주소, Sentry DSN, 지도/분석 설정 |
| `apps/api/.dev.vars`    | JWT/CSRF 서명 키, 허용 Origin, 외부 연동  |
| `apps/b-bot/.dev.vars`  | Slack·Google·외부 서비스 설정             |
| 자동화 앱의 `.dev.vars` | 웹훅 인증, GitHub 권한                    |

`NEXT_PUBLIC_*` 값은 브라우저에 노출되므로 비밀 키를 넣지 않습니다. `.env*`, `.dev.vars*`, PEM, 데이터 스냅샷은 커밋하지 않습니다.

네이버 지도는 `NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID`를 빌드 시 주입해야 합니다. 로컬은 `apps/web/.env.local`, Cloudflare는 `koin-web`의 Workers Builds 빌드 변수에 설정합니다. 런타임 변수만 바꿔서는 이미 생성된 브라우저 번들이 갱신되지 않습니다. Workers Builds 배포 빌드는 ID가 없거나 가짜 값이면 실패하며, 키가 없는 로컬·격리 빌드는 잘못된 SDK 요청을 만들지 않습니다.

## 검증

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## 배포

`develop`에 병합하면 Cloudflare Workers Builds가 각 Worker를 운영 배포합니다. `preview` 브랜치는 선택적인 비운영 검증용입니다.

| Worker                  | Root directory          | 운영 배포     | `preview` 배포                       |
| ----------------------- | ----------------------- | ------------- | ------------------------------------ |
| `koin-web`              | `apps/web`              | `pnpm deploy` | `pnpm deploy:preview`                |
| `koin-api`              | `apps/api`              | `pnpm deploy` | `pnpm deploy:preview --name preview` |
| `bcsd-error-automation` | `apps/error-automation` | `pnpm deploy` | 검사만 실행                          |

웹은 `KOIN_API_ORIGIN`으로 Java API를 호출합니다. 운영은 `https://api.koreatech.in`, Preview와 로컬은 `https://api.stage.koreatech.in`입니다. stage API가 발급하는 `__Secure-koin-stage-web-*` 쿠키 이름 같은 stage 전용 값은 빌드 상수 `NEXT_PUBLIC_KOIN_ENVIRONMENT`로 고릅니다. Workers Builds의 `KOIN_PREVIEW_BRANCH` 빌드와 로컬 개발 서버는 `preview`, 나머지 빌드는 `main`입니다.

웹 게시글 상세는 Java v2의 인라인 HTML과 `static.koreatech.in`·`stage-static.koreatech.in`의 `/articles/content/board_<번호>/<파일>.txt` 본문 URL을 모두 처리합니다. 정적 본문은 웹 서버 함수가 쿠키 없이 조회하며 redirect·2 MiB 초과·20초 초과·HTML/텍스트 이외 MIME을 거부합니다. 두 형식 모두 같은 HTML 정제 정책으로 렌더링합니다.

운영 `koreatech.in`과 stage `stage.koreatech.in`의 HTTP 요청과 비표준 HTTPS 포트 요청은 SSR·Java API 호출 전에 경로와 쿼리를 보존한 기본 HTTPS Origin(443)의 308로 이동합니다. 로컬 개발 서버의 `http://localhost:3000`은 그대로 사용합니다. Java API의 Origin 허용 목록을 우회하거나 웹 요청의 Origin을 임의로 바꾸지 않습니다.

stage는 검색 색인에서 뺍니다. `KOIN_ENVIRONMENT`가 `main`이 아닌 Worker는 SSR 응답에, stage 빌드는 `_headers`로 정적 자산에 `X-Robots-Tag: noindex, nofollow`를 붙입니다. 크롤러가 이 헤더를 읽어야 기존 색인이 지워지므로 stage `robots.txt`는 크롤링을 허용하고 sitemap은 만들지 않습니다. 봇은 [별도 안내](apps/b-bot/README.md)를 따릅니다.

익명 SSR 페이지는 공개 `Cache-Control`과 `Vary: User-Agent`를 보냅니다. 공유 캐시된 HTML의 렌더 시각은 오래될 수 있으며, 브라우저 화면 이동은 캐시되지 않은 세션 응답의 서버 시각으로 기준을 맞춥니다.

API gateway는 원문 `/api` 접두사를 검증하며 인코딩된 다른 접두사는 404로 거부합니다. 게시글·분실물·상점 상세 URL의 ID는 양의 안전한 정수여야 합니다. 없는 분실물이나 다른 게시판 글의 ID는 404로 응답하며, 회원가입·비밀번호 찾기 URL에는 등록된 진행 단계만 허용합니다.

### 레거시 Worker API 비활성화와 복원

`koin-api` Worker는 `apps/api/wrangler.jsonc`의 `API_ENABLED`가 `"false"`라 모든 요청에 `503 API_DISABLED`로 응답합니다. 코드와 D1·R2·Queue·DO 리소스는 삭제하지 않습니다.

- 비활성 배포 전후: `wrangler queues pause-delivery koin-api-jobs`
- 복원: `API_ENABLED`를 `"true"`로 바꿔 배포한 뒤 `wrangler queues resume-delivery koin-api-jobs`

### KOIN_DB 모드 (식단·시내버스)

`KOIN_DB_ENABLED=true`이면 아래 API만 Worker가 처리하고 나머지 인증·쓰기는 Java로 전달합니다. D1 업무는 차단합니다. 웹 `KOIN_API_ORIGIN`은 운영 `https://api.koreatech.in`, Preview·로컬 `https://api.stage.koreatech.in`입니다.

- 운영 진입점은 AWS nginx입니다. 해당 경로만 Worker로 보내고 5xx·시간 초과는 Java가 처리합니다(`PATCH /dining/like*`는 Java로 대체하지 않음). 설정 원본은 `bcsdpdevops-ops/host/koin-edge`입니다.
- KOIN_DB 조회는 고정 SELECT 전용 계정을 쓰는 AWS HTTPS 브리지로만 합니다(`dining_menus` 열 + `sold_out_source`, `dining_likes(dining_id,user_id)`, `users(id,user_type,is_deleted,is_authed,name,nickname,device_token)`, `dining_soldout_report*`, `coop_semester(id,is_applied)`·`coop_names(id,name)`·`coop_shop(id,coop_name_id,semester_id)`·`coop_opens`, `notification_subscribe(id,user_id,subscribe_type,detail_type)`). Tunnel·VPC·Hyperdrive와 `api.koreatech.in` DNS 프록시는 사용하지 않습니다.
- `GET /bus/timetable/city`: Pi 배치가 매일 쓰는 KV(`bus:city:v1:<번호>:<방향>`)로 응답하고, KV 누락·비정규 파라미터는 Java로 전달합니다.
- 시내버스 실시간은 Durable Object `CITY_BUS`(`cheonan`)가 TAGO(`TAGO_SERVICE_KEY`, 천안 34010)로 만듭니다. 7개 정류소 경유 노선은 하루 한 번 받고, 운행 시간(KV 시간표 첫차-15분~막차+120분)에만 1분 cron이 노선 위치를 조회해 정류소 도착을 DO SQLite에 8주 보관합니다. `CITY_BUS_TRACKING`: `location`(기본, 위치 API 실패 시 30분간 도착 API로 대체)·`arrival`·`off`.
- `GET /bus?bus_type=city`: Java `BusRemainTimeResponse`와 같습니다. 다른 `bus_type`·비정규 파라미터·TAGO 실패는 Java로 전달합니다. `GET /bus/city/arrival-history?station=&direction=north|south&bus_number=&weeks=1..8`: 지난 주들의 같은 요일 현재 시각 ±30분 실제 도착.
- 식단·좋아요 원본은 Durable Object `DINING`(KST 날짜별 인스턴스)입니다. 메뉴는 1분 cron이 브리지 MySQL로 덮어쓰고(어제~6일 뒤), 좋아요는 DO만 씁니다. 변경 시 DO alarm이 KV(`koin:dining:v1:<날짜>`)를 다시 씁니다.
- `GET /dinings`: 익명은 KV, 로그인은 DO의 `is_liked`. `PATCH /dining/like`, `/dining/like/cancel`: Java와 같은 권한·오류 JSON. Bearer는 `KOIN_JWT_SECRET`(Java `jwt.secret-key`)로 검증하고 회원 상태는 브리지 `/users`(30초 캐시)로 확인합니다. 웹 쿠키는 Java `GET /v2/web/auth/session`으로 세션·출처를 확인하고 CSRF 토큰을 비교합니다.
- 품절·사진·품절 제보 소유권(`KOIN_DINING_COOP_OWNER=true` + nginx `$koin_dining_coop_owner 1`): DO `coop` 인스턴스가 원본입니다. Worker 처리: `PATCH /coop/dining/soldout|image`, `GET /coop/dining/excel|image`, `GET /dinings/search`(COOP), `POST /dinings/{id}/soldout-reports`(STUDENT), `/internal/dining/soldout-reports/**`(`X-Koin-Service-Token` = `DINING_REPORT_BOT_TOKEN`), `GET /admin/dining/soldout-reports[/{id}]`(ADMIN). 품절·사진 FCM은 Java와 같은 조건·장소별 2시간 제한으로 직접 보냅니다(`FCM_PROJECT_ID`·`FCM_CLIENT_EMAIL`·`FCM_PRIVATE_KEY`, MySQL `notification` 이력은 남기지 않음).
- 가져오기(workers.dev, `Authorization: Bearer <KOIN_DB_BRIDGE_TOKEN>`, 반복 실행 안전): 좋아요 `POST /internal/workers/dining-likes/import?from=YYYY-MM-DD&to=YYYY-MM-DD`(최대 62일), 품절·제보 `POST /internal/workers/dining-coop/import`(재전환은 `?force=1`). 완료된 가져오기에 뒤늦게 도착한 페이지는 `409 DINING_COOP_ALREADY_IMPORTED`로 거부하여 전환 후 저장한 사진·품절·제보를 보존합니다.
- 소유권 전환 순서: 브리지·권한 배포 → Worker 배포(플래그·시크릿) → nginx `$koin_dining_coop_owner 1`(가져오기 전 coop 쓰기는 503) → 수 초 뒤 coop 가져오기. 되돌림: nginx 0 + 플래그 `false`(다음 cron에 MySQL 값). 전환 중 DO에서만 생긴 제보·품절·사진은 MySQL로 돌아가지 않습니다.

## 오류 추적

- Worker/API/SSR 오류: Cloudflare Issues
- 브라우저 오류·세션 리플레이: Sentry (`koin-united-prod`, `koin-united-preview`)
- 자동 수정: [apps/error-automation](apps/error-automation/README.md)

기여 방법은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.
