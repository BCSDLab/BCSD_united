# BCSD United

KOIN의 웹앱과 업무 API를 함께 관리하는 Cloudflare 기반 모노레포입니다.

> 현재 전환 작업과 통합 검증이 진행 중입니다. 소스가 있다는 이유만으로 운영 이관이 완료된 것은 아닙니다. 운영 DB의 데이터를 아직 가져오지 않았으며, 운영 도메인도 전환하지 않았습니다.

> **업무 API의 현재 방향은 기존 Java 서버 유지입니다.** `apps/api`의 TypeScript Worker API는 레거시로 분류하며 배포 설정에서 `API_ENABLED`가 기본 `"false"`(비활성)입니다. 코드·D1 데이터·R2·Queue·DO·마이그레이션은 삭제하지 않고 그대로 보존합니다. 절차와 미확인 항목은 [레거시 Worker API 비활성화와 복원](#레거시-worker-api-비활성화와-복원)을 참고하세요.

## 구성

```text
apps/
  web/                 TanStack Start 프론트엔드·SSR Worker
  api/                 Hono 업무 API Worker(레거시, 기본 비활성·코드와 데이터 보존)
  b-bot/               Slack 봇 HTTP·Queues·Workers AI Worker
  error-automation/    오류 웹훅 수신과 자동 수정 작업 시작
packages/
  telemetry/           공통 민감정보 마스킹
  b-bot-ai/            GPT-6 Luna 호출과 응답 검증
  b-bot-database/      봇 PostgreSQL 연결·이관 도구(D1 이전 미포함)
scripts/
  autofix/             독립 검증과 GitHub 이슈·PR 발행
```

- 프론트엔드: React 19, TanStack Start/Router, React Query, Zustand, SCSS Modules.
- 업무 API: 기존 Java 서버를 유지합니다. 저장소의 TypeScript·Hono·Drizzle ORM·Cloudflare D1 Worker는 레거시로 보존하며 `API_ENABLED`가 정확히 `"true"`일 때만 업무 경로를 실행합니다.
- 파일: R2. 실시간 연결·일부 변경 요청의 직렬화: Durable Objects.
- 비동기 작업: Queues. KOIN 원본 동기화와 API 정기·복구 Cron은 비용 검증 전까지 비활성화합니다.
- 도구: pnpm workspace, oxlint, oxfmt, TypeScript. 웹 전용 규칙에는 ESLint·Stylelint도 사용합니다.
- 웹·API·봇·오류 자동화는 별도 Worker로 배포합니다. 하나의 Worker에 웹·업무 API·자동화 권한을 합치지 않습니다.

## 개발 환경

Node.js는 Cloudflare Workers Builds가 지원하는 `24.22.1`(`.nvmrc`), pnpm은 `12.16.1`(루트 `package.json`의 `packageManager`)로 고정합니다. Node 버전을 먼저 선택하고 Corepack으로 pnpm을 실행합니다. Workers Builds의 `NODE_VERSION`·`PNPM_VERSION`도 같은 값으로 유지합니다.

```sh
corepack pnpm install --frozen-lockfile
pnpm --filter @koin/api db:migrate:local
pnpm dev
```

앱을 따로 실행할 수도 있습니다.

```sh
pnpm dev:web
pnpm dev:api
pnpm dev:b-bot
```

웹 개발 서버는 `http://localhost:3000`, API의 Wrangler 개발 서버는 기본 `http://localhost:8787`, 봇은 `http://localhost:8793`을 사용합니다.

레거시 API Worker는 `wrangler.jsonc`의 `API_ENABLED`가 `"false"`이므로 `pnpm dev:api`만으로는 `/health`·`/docs`를 포함한 모든 경로가 `503 API_DISABLED`로 응답합니다. 로컬에서 업무 경로를 실행하려면 해당 프로세스에만 값을 넣습니다: `pnpm --filter @koin/api dev --var API_ENABLED:true`. 이 값은 로컬 Miniflare에만 적용되며 배포 설정을 바꾸지 않습니다. `scripts/autofix`의 격리 검증기도 같은 방식으로 로컬 Worker에만 `"true"`를 명시합니다.

### 로컬 설정

| 위치                    | 용도                                                   |
| ----------------------- | ------------------------------------------------------ |
| `apps/web/.env.local`   | 공개 API 주소·브라우저 Sentry DSN·지도/분석 설정       |
| `apps/api/.dev.vars`    | JWT/CSRF 서명 키, 허용 Origin, 외부 연동 자격 증명     |
| `apps/b-bot/.dev.vars`  | Slack 서명·봇 토큰, 웹훅 인증, Google·외부 서비스 설정 |
| 자동화 앱의 `.dev.vars` | 웹훅 인증과 GitHub 작업 시작 권한                      |

웹의 `NEXT_PUBLIC_API_PATH`는 실행할 API 주소로 설정합니다. 기존 공개 환경 변수 이름은 유지하지만 Next.js 런타임을 사용하지 않습니다. `NEXT_PUBLIC_*` 값은 브라우저에 노출될 수 있으므로 비밀 키를 넣으면 안 됩니다.

이미지는 `components/ui/Image`가 `/api/image?url=...&w=...&q=...`와 반응형 `srcset`을 생성하고 Cloudflare Images binding이 변환합니다. 원본 `KOIN_WEB_RECODE`의 `next/image`와 같은 선택 방식이며, `sizes="672px"`처럼 고정 크기를 지정해도 후보 URL 여러 개가 나오는 것은 정상입니다. 브라우저는 화면 밀도에 맞는 후보를 선택합니다. 허용된 원본 호스트·리디렉션 검증과 20 MiB 스트림 제한은 유지하며, 업로드 서버의 잘못된 `Content-Type` 목록 때문에 정상 사진을 거부하지 않도록 실제 이미지 디코더가 바이트를 검증합니다. 원본 응답을 그대로 전달하지 않고 AVIF/WebP/JPEG로 변환한 결과만 반환합니다. PC 학식 확대 사진은 중첩된 고정 높이 컨테이너 없이 원본 비율과 화면 최대 크기에 맞춰 표시합니다.

API 로그인에는 `JWT_SECRET`, `WEB_CSRF_SECRET`, `AUTH_ALLOWED_ORIGINS`가 필요합니다. 네이티브 앱 토큰 발급에는 `NATIVE_ACCESS_TTL_SECONDS`도 필요합니다. 파일·문자·메일·결제·푸시 연동은 해당 공급자의 실제 설정이 있어야 동작하며, 누락된 설정을 가짜 성공 응답으로 대체하지 않습니다.

`.env*`, `.dev.vars*`, PEM, 데이터 스냅샷, `.claude`, `.vscode`는 공개 커밋 대상이 아닙니다. 운영 시크릿은 Wrangler secret 또는 GitHub Actions secret에 저장합니다.

봇은 [별도 운영 안내](apps/b-bot/README.md)를 따릅니다. `pnpm deploy:b-bot`으로 해당 Worker만 배포하며, 초기 설정에서는 운영 DB 연결·Cron·기존 Slack 엔드포인트 전환을 활성화하지 않습니다. Luna는 Cloudflare 계정 크레딧·한도에 따라 사용하고 다른 유료 모델로 자동 전환하지 않습니다.

### API 문서

API Worker의 `GET /docs`는 Swagger UI를, `GET /openapi.json`은 OpenAPI 3.0.3 계약을 제공합니다. 두 경로는 인증이나 DB 조회 없이 공개되지만 `API_ENABLED` 게이트의 예외는 아니므로 비활성 상태에서는 `/health`와 함께 `503 API_DISABLED`로 응답합니다. 문서는 `apps/api/src/openapi/source-contract.json`에 보관된 운영 API 계약(2026-10-27)의 DTO와 464개 작업을 유지하고, Worker의 `/health`와 서명된 R2 파일 접근 작업을 추가합니다. 소스 운영 계약에 없는 테스트·개발용 작업을 임의로 공개 문서에 추가하지 않습니다.

서버 URL은 `/`이므로 **Try it out은 문서를 연 API Worker에 실제 요청**을 보냅니다. 운영 API 주소로 자동 전환하지 않습니다. `/health`는 Worker 응답 상태만 확인하며 DB·외부 연동 readiness 검사가 아닙니다. Swagger UI는 고정 버전 `5.32.0`의 CSS/JavaScript를 jsDelivr에서 로드하므로 브라우저의 해당 CDN 접근이 필요합니다. 외부 계약 validator 호출과 인증 정보 영속 저장은 비활성화합니다.

Bearer 인증은 **Authorize → Jwt Authentication**에 JWT 값만 입력합니다. 브라우저의 HttpOnly 웹 인증 쿠키는 Swagger 입력란에서 직접 설정할 수 없으며, 같은 API의 웹 로그인으로 발급받아야 합니다. 쿠키 인증 요청은 허용 Origin 설정이 필요하고, 상태를 바꾸는 요청에는 세션과 일치하는 `X-CSRF-Token`이 필요합니다. 문서에서 `WebCsrfToken` 인증 항목에 현재 CSRF 값을 입력할 수 있지만, Swagger UI가 쿠키를 읽어 CSRF 값을 자동 동기화하거나 만료된 세션을 갱신하지는 않습니다. Bearer와 쿠키를 동시에 보내면 일반 API 인증은 Bearer를 우선하며, `/v2/web/auth/*`는 별도의 웹 세션 규칙을 따릅니다.

R2 capability URL은 URL 자체가 만료 시각·메서드·파일에 묶인 접근 권한입니다. 외부에 공유하거나 로그에 남기지 않습니다. 업로드 본문은 원본 파일 바이트이며 서명된 `Content-Type`과 바이트 길이를 정확히 맞춰야 합니다. Swagger UI는 서명된 업로드 메타데이터를 자동 추론하지 않으므로 파일 업로드 클라이언트에서 해당 값을 지정합니다. capability 요청에도 웹 세션 쿠키가 함께 전송되면 공통 Origin/CSRF 검사가 적용됩니다.

## 검증

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`pnpm format`은 oxfmt로 코드를 정렬합니다. 위 명령은 검증 진입점이며, 현재 브랜치의 통과 여부는 실제 실행 결과와 CI를 확인해야 합니다.

커밋 훅은 웹뿐 아니라 API·자동화·공용 패키지의 staged JavaScript/TypeScript와 JSON/JSONC·문서 파일도 포맷합니다. 웹 소스의 포맷·ESLint는 같은 작업 안에서 순서대로 실행해 동시 파일 수정을 피합니다. `Quality` Actions는 저장소 전체의 포맷·린트·타입을 검사하며, 오류 자동 수정 작업의 실행기는 아닙니다.

Zustand 5의 선택자는 상태가 변하지 않으면 같은 참조를 반환해야 합니다. 객체·배열을 새로 조합하는 선택자는 `useShallow` 등으로 결과를 안정화하고, 웹 변경은 데스크톱뿐 아니라 모바일 뷰포트에서도 실제 렌더와 브라우저 오류를 확인합니다. 타입 검사·빌드 또는 데스크톱만의 smoke 결과로 모바일 렌더 성공을 대신하지 않습니다.

`pnpm --filter @koin/api test`는 TypeScript API 회귀 테스트와 `scripts/*.test.mjs`의 D1 데이터·파일 이관 동작 테스트를 함께 실행합니다. 이관 도구만 확인하려면 다음 명령을 사용합니다.

```sh
node --test "apps/api/scripts/*.test.mjs"
```

API 회귀 테스트는 SQLite의 실제 제약조건·원자 배치와 HTTP 계약을 확인합니다. 테스트 통과만으로 운영 공급자나 실제 사용자 데이터 이관이 검증되는 것은 아닙니다.

## D1 데이터 이관

`apps/api/drizzle/`의 마이그레이션과 `apps/api/src/db/schema.ts`가 영속 스키마를 정의합니다. 기존 MySQL의 과거 주문·결제 테이블도 보존합니다. MongoDB 및 Redis에 있던 업무 데이터는 D1으로 이전하며, DO를 두 번째 업무 DB로 사용하지 않습니다.

- 웹 refresh 토큰의 해시, 세션·CSRF·만료 상태를 D1에 저장합니다.
- 기존 앱용 인증은 별도 세션 저장소로 기존 계약을 유지합니다.
- 만료 여부는 요청 시 검사합니다. 만료 행 삭제 Cron에 인증 유효성이 의존하지 않습니다.
- Drizzle의 파라미터화 SQL과 D1 원자 배치를 사용합니다. MySQL의 행 잠금이나 대화형 트랜잭션을 그대로 흉내 내지 않습니다.
- bigint·UUID·TTL·채팅 이력을 손실 없이 옮기도록 검사합니다.
- SQLite와 MySQL의 Unicode collation은 완전히 같지 않습니다. 제공된 정규화·충돌 검증을 통과시키고 실제 데이터의 차이를 확인해야 합니다.

이관 절차와 제한은 `apps/api/scripts/migration-contract.json` 및 같은 디렉터리의 실행 도구를 따릅니다. 기본 경로는 쓰기가 중단된 스냅샷이며, 저장소별 온라인 스냅샷은 명시적인 운영자 승인과 `--allow-online-bootstrap`으로만 허용합니다. 온라인 캡처를 저장소 전체의 동일 시점 스냅샷으로 간주하지 않습니다. 적용한 마이그레이션은 수정하지 않고 새 순번으로 변경합니다.

### 원본 DB 호스트의 임시 배치 필드 동기화

**현재 중지 상태입니다.** 비용 문제로 원본 서버의 운영·프리뷰 동기화 Cron 등록을 제거하고 실행 중인 동기화를 종료했습니다. Cloudflare `koin-api` Cron도 제거했으며 저장소의 `triggers.crons`는 빈 배열입니다. 2026-11-04 원본 호스트 읽기 전용 확인 결과 `sync-enabled` 없음, `sync-paused` 있음, crontab 등록 0건, 실행 중인 동기화 프로세스 없음이었으며 추가 삭제나 cron 수정은 하지 않았습니다. 레거시 Worker API의 `API_ENABLED` 비활성화와는 별개의 게이트이며 이 상태를 바꾸지 않습니다. 변경 행만 반영하는 증분 방식의 로컬 검증과 비용 검토 후 사용자가 다시 승인하기 전에는 원격 동기화, 초기 기준선 조회·적용, Cron 재등록을 실행하지 않습니다. 아래 실행 설명은 운영 참고이며 재실행 승인이 아닙니다.

원본 DB 호스트용 `source-sync-uploader.py`, `source-sync-cron.sh`, `source-sync-mysql-prep.py`는 비공개 운영 도구이며 공개 Git에 포함하지 않습니다. 검증한 배포본과 저장소의 `source-schema.json`을 원본 DB 호스트의 `$HOME/.local/share/koin-d1-sync/`(0700)에 복사합니다. 운영과 프리뷰는 각각 `production/`, `preview/` 상태 디렉터리(0700)와 독립된 `config.json`(0600)의 `source_sync_secret`을 사용합니다. 실제 설정·출력 데이터·비밀번호는 커밋하거나 명령행 인자로 전달하지 않습니다. 호스트에는 Python 3, Docker, `flock`, `timeout`이 필요합니다. 읽기는 지정된 KOIN 컨테이너에 한정합니다. `--environment production|preview`는 각각 고정된 `https://koin-api.bcsdlab.workers.dev/internal/source-sync`, `https://preview-koin-api.bcsdlab.workers.dev/internal/source-sync`만 선택하며 임의의 원격 URL은 허용하지 않습니다. 기본 대상은 운영이고, 기본 상태 디렉터리도 선택한 환경에 따라 분리됩니다.

HTTP 클라이언트는 실제 프로그램 이름인 `User-Agent: KOINSourceSync/2.0`을 명시합니다. HMAC 인증과 고정 대상 URL은 유지하며 브라우저로 위장하거나 Cloudflare 보안 검사를 비활성화하지 않습니다.

운영 API의 `secrets.required`는 `JWT_SECRET`, `WEB_CSRF_SECRET`, `SOURCE_SYNC_SECRET`을 선언합니다. 누락된 비밀값이 있으면 Wrangler 배포가 실패해야 하며, 값 자체는 설정 파일에 쓰지 않습니다. 네이티브 프리뷰의 인증·동기화 키는 프리뷰 설정에서 독립적으로 관리합니다. 이 선언은 로컬 `.dev.vars`/`.env`에서 불러올 키도 제한하므로 새 공급자 비밀값을 활성화할 때 선언과 실제 저장값을 함께 갱신합니다. 대시보드나 CLI의 명시적인 비밀값 삭제까지 막는 기능은 아닙니다.

증분 v2는 원본 서버에서 일곱 데이터셋을 읽고 환경별 마지막 ACK 기준의 행·그룹 지문과 비교합니다. 변경이 없으면 HTTP 요청과 D1 쓰기가 모두 0건입니다. `sync --environment production --dry-run`은 로컬 변경 계획만 계산하며 프리뷰는 `--environment preview`를 사용합니다. 기준선이 없으면 자동 전체 업로드하지 않고 중단합니다. 사용자 승인 후의 명시적 `initialize-baseline`만 현재 원본 키에 해당하는 대상의 소유 필드를 제한된 읽기 전용 요청으로 비교합니다. 기준선과 재전송할 원문은 환경별 `fingerprints-v2.json`에 보존하고 ACK 후에만 진행합니다. 기존 v1 체크포인트·스풀은 초기화하거나 삭제하지 않습니다.

v2 API는 변경된 엔터티만 페이지별 원자 배치로 반영합니다. 조회수만 바뀐 공지는 검색 인덱스·첨부파일·본문을 쓰지 않습니다. 제목 변경 시 검색 토큰은 달라진 위치만 UPDATE/INSERT하고 사라진 위치만 DELETE합니다. 첨부파일도 실제 차이만 처리합니다. 강의·시간표 버전은 작은 완전 그룹으로 비교해 동일 행 ID를 재사용하고, 연결된 시간표를 잃는 삭제나 모호한 매핑은 거부합니다. 삭제는 이전 기준선에 있던 원본 키가 실제 사라진 명시적 tombstone에 한하며 전체 대상 테이블을 비우지 않습니다. 날짜만 새로 캡처한 동일 날씨는 변경으로 보지 않습니다.

요청은 256KiB, 페이지당 100 엔터티, 그룹 데이터는 1,000행 이내입니다. 기준선 응답은 1MiB로 제한하며 그 크기 오류에만 키 묶음을 나눠 조회합니다. 클라이언트 기본 한도는 변경 행·그룹 구성원·첨부파일·검색 위치 예상 작업을 합쳐 100 작업 단위입니다. 초과하면 원격 쓰기 전에 중단하며 검토한 정확한 `--approve-work-units` 값이 필요합니다. 이 수치는 청구 금액이나 실제 D1의 인덱스·트리거 포함 청구 행 수를 보장하지 않습니다.

`source-sync-cron.sh`는 기본 비활성화입니다. 원본 서버의 `sync-enabled` 승인 파일이 없거나 `sync-paused`가 있으면 자식 동기화 프로세스를 실행하지 않습니다. API도 `SOURCE_SYNC_ENABLED`가 정확히 `"true"`가 아니면 D1에 접근하기 전에 거부하며 운영·프리뷰 설정은 현재 `"false"`입니다. 예외적인 수동 네트워크 허용 옵션은 사용자 재승인을 받은 작업에만 사용합니다. 재개 전에는 새 메타데이터 마이그레이션 `0004_incremental_source_sync.sql`, 읽기 전용 기준선, 변경 계획·비용 검토를 순서대로 확인해야 합니다. 이 마이그레이션은 기존 v1 staging/receipt를 교체하며 업무 데이터 테이블을 초기화하지 않습니다. 현재 원격 마이그레이션·기준선 초기화·동기화·Cron 재등록은 실행하지 않습니다.

`full-snapshot`은 회원·원본 ID·비밀번호 해시·계정 상태·주문·게시글을 포함한 **전체 원본**과 Mongo/Redis를 비공개 스냅샷으로 보존하는 별도 경로입니다. 기본 경로는 `--quiescence-attestation`으로 모든 원본 쓰기의 중단 증빙을 요구합니다. 승인된 온라인 초기 이관에서는 저장소별 캡처 시각과 비일관성 한계를 기록하고, MySQL DATETIME은 운영자가 지정한 `+09:00`으로 해석합니다. 실제 JVM/JDBC 시간대가 확인된 것으로 주장하지 않습니다. 원본 로그인·재설정·인증 증명과 포털 로그인 쿠키는 비공개 스냅샷에만 보존하고 D1의 활성 상태 및 원본 보관 테이블에서 제외합니다. 회원·비밀번호 해시는 유지하고 운영·프리뷰에서 각각 새 로그인 권한을 발급합니다. Cron 경로는 초기 전체 이관의 대체물이 아니며 회원·인증·주문 같은 대상 소유 필드를 재동기화하지 않습니다.

원격 반입은 검증된 동일 스냅샷을 비어 있는 운영·프리뷰 D1에 각각 적용합니다. 대상별 `import-remote-<database>.json`의 `verified:true`는 모든 체크포인트·테이블 행 수·메타데이터 해시·외래키·대용량 Redis 바이트 해시와 D1 용량 검증을 통과했음을 뜻합니다. 가져온 스키마 해시와 일치하는 SQL 파일만 `d1_migrations`에 기준 이력으로 등록해 이후 마이그레이션이 기존 테이블을 다시 생성하지 않도록 합니다. 두 대상의 검증이 끝난 뒤 Worker 바인딩을 전환하고 실제 API·화면을 확인합니다. 읽기 전용 추출이나 로컬 검증만으로 운영 이관 또는 Cron 활성화가 완료됐다고 판단하지 않습니다.

## 배포

### Workers Builds와 브랜치

GitHub 저장소는 [BCSDLab/BCSD_united](https://github.com/BCSDLab/BCSD_united)입니다. 기능 브랜치의 PR을 `develop`에 병합하면 웹·API·오류 자동화 Worker의 운영 배포가 자동으로 시작되는 정책을 사용합니다. `preview`는 필요할 때 안정적인 통합 검증에 사용하는 선택적 비운영 브랜치이며, 운영 배포를 위한 필수 승격 단계가 아닙니다. 브랜치마다 같은 변경을 다시 커밋하거나 cherry-pick하지 않습니다. 각 Worker(`koin-web`, `koin-api`, `bcsd-error-automation`)를 같은 저장소의 Cloudflare **Workers Builds**에 연결합니다. API를 `api-test`/`stage`/`prod`라는 별도 Worker로 나누지 않고, 웹·API Worker 안에서 production과 **native Preview**를 구분합니다.

Workers Builds의 Root directory는 각 앱 폴더로 설정합니다. pnpm은 상위 workspace의 lockfile과 공용 패키지를 사용하며, 아래 명령은 해당 앱 폴더에서 실행됩니다. 운영 배포는 `wrangler deploy`, 선택적 비운영 배포는 `wrangler preview`입니다. `wrangler versions upload`, `--env test`, `--env stage`, `env.preview`는 이 배포 모델이 아닙니다. 로컬 수동 배포를 평상시 작업 흐름으로 사용하거나 같은 앱을 배포하는 GitHub Actions를 추가하지 않습니다. 기존 B-BOT 배포는 별도 운영 범위입니다.

| Worker                  | Root directory          | 검증·빌드 명령                 | 운영 배포 명령 | 선택적 `preview` 배포 명령           |
| ----------------------- | ----------------------- | ------------------------------ | -------------- | ------------------------------------ |
| `koin-web`              | `apps/web`              | `pnpm typecheck && pnpm build` | `pnpm deploy`  | `pnpm deploy:preview`                |
| `koin-api`              | `apps/api`              | `pnpm typecheck && pnpm test`  | `pnpm deploy`  | `pnpm deploy:preview --name preview` |
| `bcsd-error-automation` | `apps/error-automation` | `pnpm typecheck && pnpm test`  | `pnpm deploy`  | 검사만 실행, 배포 없음               |

웹·API·오류 자동화 Workers Builds의 production branch를 모두 `develop`으로 맞춥니다. `develop`의 검사 성공 후 운영 배포를 실행하며, 비운영 브랜치에서는 검사를 실행하되 배포 명령을 웹·API의 `preview`에만 `if [ "$WORKERS_CI_BRANCH" = "preview" ]; then <위 표의 preview 배포 명령>; else printf "Checks only: no deployment for %s\n" "$WORKERS_CI_BRANCH"; fi`로 제한합니다. 따라서 기능 브랜치가 고정 `preview` 환경을 덮어쓰지 않습니다. 웹의 비운영 빌드 명령은 `pnpm typecheck && if [ "$WORKERS_CI_BRANCH" = "preview" ]; then pnpm build; fi`입니다. 웹 번들 생성 자체도 `develop`/`preview`만 허용합니다. 오류 자동화는 기존과 같이 비운영 브랜치에서 검사만 합니다. 기존 develop Preview의 자동 빌드는 꺼서 같은 커밋을 중복 처리하지 않습니다.

웹의 `preview` Git 브랜치는 `pnpm deploy:preview`(`wrangler preview --name stage`)로 이름이 `stage`인 native Preview를 갱신합니다. `koreatech.in` 맞춤 도메인의 Preview를 활성화해 `stage.koreatech.in`으로 제공하며, workers.dev 주소는 `stage-koin-web.bcsdlab.workers.dev`입니다. 기존 nginx/Next.js의 stage DNS 레코드는 새 Preview의 실제 응답과 인증서를 확인한 뒤 전환합니다. `api.stage.koreatech.in`은 기존 Java API로 유지합니다. 브랜치 이름 `preview`와 Preview 배포 이름 `stage`를 혼동하지 않습니다.

운영 브랜치 변수는 `KOIN_PRODUCTION_BRANCH`(기본 `develop`)이며 기존 `KOIN_MAIN_BRANCH`를 대체합니다. 선택적 staging 브랜치는 `KOIN_PREVIEW_BRANCH`(기본 `preview`)입니다. 런타임의 `KOIN_ENVIRONMENT='main'`은 논리적 운영 환경을 가리키는 기존 값으로 브랜치 이름과 무관하게 유지합니다. 브랜치명을 바꾸면 브랜치 변수와 Workers Builds의 조건을 함께 바꿔야 합니다. 브랜치별 Preview를 추가하려면 이름·빌드 분기 정책과 대응 API Preview 주소·허용 Origin을 먼저 정해야 합니다. 저장소 Quality workflow와 앱별 검증 명령을 유지하며, GitHub 연결·푸시·빌드 시작을 배포 성공으로 취급하지 않습니다.

Cloudflare GitHub App의 저장소 접근 승인, Worker별 저장소 연결, production branch와 비운영 배포 조건, Preview 전용 시크릿 및 API/웹 Origin 설정은 실제 계정에 적용하고 확인해야 합니다. `develop` 병합 전에 필요한 운영 전제조건을 확인하고, 배포 뒤에는 실제 URL의 HTTP 응답을 확인합니다. 저장소 정책 변경만으로 원격 설정 변경이나 운영 배포가 완료된 것은 아닙니다.

### Preview 리소스와 검증 범위

| 리소스          | Production       | Native Preview                          |
| --------------- | ---------------- | --------------------------------------- |
| D1              | `koin-api`       | `koin-api-test`                         |
| R2              | `koin-api-files` | `koin-api-files-test`                   |
| Queue producer  | `koin-api-jobs`  | `koin-api-jobs-test`                    |
| Durable Objects | 운영 namespace   | 각 Preview에 자동 생성되는 새 namespace |

Preview 설정은 각 Wrangler 파일의 `previews` 블록에 명시하며 운영 변수·시크릿을 자동 상속하지 않습니다. D1/R2/Queue는 같은 이름을 바인딩한 Preview끼리 데이터를 공유합니다. 기존 `-test` DO namespace를 재사용하지 않으며, Preview마다 자동 격리된 DO 저장소가 생성됩니다. 같은 Preview를 재배포하면 상태가 유지되고 Preview 삭제 시 해당 DO 상태도 삭제됩니다.

**Preview는 HTTP-only입니다. Queue producer만 테스트 큐에 연결하고 Queue consumer와 Cron Trigger를 두지 않습니다.** 따라서 HTTP 요청이나 작업 enqueue 성공은 알림 발송·예약 실행·정기 복구 성공을 뜻하지 않습니다. 이 동작은 Preview에서 검증하지 않습니다. 기존 `koin-api-test` Worker와 해당 테스트 큐 consumer 연결은 제거했으며, Preview가 사용하는 `-test` D1·R2·Queue는 유지합니다.

**웹은 KOIN_API_V2(Java) 서버를 사용합니다.** 브라우저는 웹 Worker의 same-origin `/api` gateway를 호출하며, gateway와 SSR 모두 런타임 `KOIN_API_ORIGIN`으로 HTTP 전달합니다. 운영은 `https://api.koreatech.in`, Preview와 로컬 개발 서버(`pnpm dev`)는 stage 서버 `https://api.stage.koreatech.in`입니다. Java 서버는 로그인 요청의 `Origin`을 `CORS_ALLOWED_ORIGINS`와 정확히 비교하므로, 운영에는 `https://koreatech.in`·`https://koin-web.bcsdlab.workers.dev`, stage에는 `https://stage.koreatech.in`·`https://stage-koin-web.bcsdlab.workers.dev`가 등록돼 있어야 합니다. gateway는 Cloudflare가 확인한 사용자 IP(`CF-Connecting-IP`)를 `X-Forwarded-For`로 전달합니다. 빌드 시 공개 API 경로는 `/api`이고, Preview는 운영 API로 폴백하지 않습니다. `koin-api` service binding은 오류 자동화의 오프라인 검증 빌드에서만 로컬 API에 연결하는 데 사용합니다.

`workers.dev` Preview 주소는 `preview_urls: true`로 활성화합니다. 웹 Worker는 `global_fetch_strictly_public`을 사용해 API를 공개 경로로 호출합니다. 근거: [Preview URL 활성화](https://developers.cloudflare.com/workers/previews/custom-domains/#enable-workersdev-preview-urls), [공개 경로 fetch](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).

Production R2는 비공개이며 실제 공개 파일 도메인 또는 비공개 전달 정책을 정하기 전 임의 `R2_PUBLIC_URL`을 넣지 않습니다. 테스트 버킷의 공개 URL을 운영에 재사용하지 않습니다. 운영 도메인 전환, 실제 데이터 반입, 기존 시스템의 쓰기 중단은 별도 절차입니다. Worker 코드 롤백은 DB·객체 데이터 복구가 아닙니다.

Cloudflare 근거: [Preview 설정](https://developers.cloudflare.com/workers/previews/configuration/), [리소스 격리와 제한](https://developers.cloudflare.com/workers/previews/resources/). 자동화 Preview의 외부 쓰기 차단과 별도 자격 증명은 [자동화 운영 안내](apps/error-automation/README.md)를 따릅니다.

### 레거시 Worker API 비활성화와 복원

업무 API는 기존 Java 서버를 유지합니다. `koin-api` Worker는 삭제·정리하지 않고 저장소 설정에서 **비활성(disabled) 상태로 보존**합니다. 코드, `apps/api/drizzle` 마이그레이션, D1(`koin-api-import-20261029`, `koin-api-test-import-20261029`), R2, Queue(`koin-api-jobs`, DLQ, `-test`), DO 클래스와 consumer 정의, 테스트 fixture는 모두 그대로 둡니다. 비활성 전환의 근거는 설정값 하나이며 되돌릴 수 있습니다. 원격 적용 상태는 별도로 확인합니다.

| 게이트                     | 현재 저장소 값                                      | 비활성 동작                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_ENABLED`              | 운영 `vars`·`previews.vars` 모두 `"false"`          | 정확히 `"true"`가 아니면 첫 미들웨어에서 `/health`·`/docs`·`/openapi.json`·`/internal/source-sync`를 포함한 모든 HTTP가 `503` JSON `API_DISABLED` + `Cache-Control: no-store` + `Retry-After: 3600`. scheduled는 업무 I/O 없이 즉시 종료. Queue 배치는 ack/drop 없이 `retryAll({ delaySeconds: 43200 })`(Queues 최대 지연 12시간). `Coordinator` DO fetch는 `503`, `CommunityChatDurableObject`는 신규 WebSocket 수락·dispatch를 막고 동면 소켓 메시지에는 STOMP `ERROR`(`API_DISABLED`) 후 `1013`으로 닫습니다. 두 DO에 alarm·RPC 메서드는 원래 없습니다. |
| `SOURCE_SYNC_ENABLED`      | 운영·프리뷰 `"false"`(이전부터 유지)                | 원본 동기화 엔드포인트가 D1 접근 전 `503 SOURCE_SYNC_DISABLED`. `API_ENABLED`와 별개의 기존 게이트이며 중복 게이트를 추가하지 않습니다.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `triggers.crons`           | `[]`(이전부터 유지)                                 | Cloudflare Cron 호출 없음.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 원본 호스트 `sync-enabled` | 없음, `sync-paused` 있음(2026-11-04 읽기 전용 확인) | `source-sync-cron.sh`가 자식 동기화를 실행하지 않음. `sync-paused`가 있으면 항상 우선. 같은 날 crontab 등록 0건, 실행 중인 동기화 프로세스 없음을 확인했으며 추가 삭제·cron 수정은 불필요. 재승인 전 `sync-enabled`를 만들지 않습니다.                                                                                                                                                                                                                                                                                                                     |

**저장소 설정과 원격 적용 상태를 구분합니다.** 2026-11-04의 읽기 전용 확인 당시 `koin-api` production·preview의 `/health`는 `status: ok`였고, production의 `SOURCE_SYNC_ENABLED: false`와 Cron 없음, 당시 운영 웹의 레거시 API Worker 연결이 확인됐습니다. 그때 원격 Worker·Queue 설정을 변경하지 않았습니다. 이후 웹의 Java API 전환 PR #9는 병합됐고, 2026-11-05T09:49Z 운영 웹 배포에서 Wrangler 버전 `72c3b223`과 메시지 `Web-only release 3b364286: Java API; orders disabled; DNS and legacy API unchanged`가 확인됐습니다. 이는 웹 배포의 증거이지 현재 원격 `koin-api`의 `API_ENABLED` 값이나 Queue 전달 상태의 증거가 아닙니다. DNS·레거시 API가 그 웹 전용 배포에서 변경됐다고 주장하지 않습니다.

**배포 전 장애 위험.** API Worker를 비활성화하기 전 운영 웹이 실제로 Java API만 호출하고 Java 서버의 CORS·허용 Origin이 맞는지 확인해야 합니다. PR #9 병합과 웹 배포 기록만으로 모든 업무 경로의 전환을 추정하지 않습니다. 웹이 레거시 Worker를 호출하는 동안 `API_ENABLED: "false"`를 원격에 반영하면 해당 요청이 `503`이 됩니다. 아래 조건과 Queue 일시 중지를 확인한 뒤에만 비활성 설정을 `develop`에 병합합니다.

**Queue는 `retryAll()`만으로 멈추지 않습니다.** 비활성 상태의 consumer는 메시지를 버리지 않도록 최대 지연으로 재시도만 하므로, 배포 후 메시지가 남아 있으면 재전달마다 시도 횟수가 쌓여 `max_retries`(5) 이후 `koin-api-jobs-dlq`로 이동합니다. 원격 비활성 배포 전후에 운영 담당자가 `wrangler queues pause-delivery koin-api-jobs`로 전달을 실제로 중지해야 하며, 복원 시 `wrangler queues resume-delivery koin-api-jobs`로 재개합니다. 일시 중지 중에도 producer의 메시지는 보관되며 보존 기간 만료에는 그대로 적용됩니다. 근거: [Queues Pause and Purge](https://developers.cloudflare.com/queues/configuration/pause-purge/), [Queues Limits](https://developers.cloudflare.com/queues/platform/limits/). `purge`는 메시지를 영구 삭제하므로 사용하지 않습니다.

비활성 반영 절차(운영 담당자, 각 단계는 실제 확인 후 다음 단계로):

1. 운영 웹이 Java API만 호출하는지 실제 경로와 Java CORS로 확인합니다(#9 병합·웹 배포 기록만으로 대체하지 않음). 미완료면 중단합니다.
2. `wrangler queues pause-delivery koin-api-jobs`로 전달을 중지하고 `wrangler queues list`로 상태를 확인합니다. 병합 전후 중지 상태를 유지합니다.
3. 선택적으로 비활성 커밋을 `preview`에서 검증해 Preview URL의 `/health`를 포함한 모든 경로가 `503 API_DISABLED`(`Cache-Control: no-store`)로 응답하는지 확인합니다. 이 단계는 운영 병합의 필수 경유지가 아닙니다.
4. 전제조건을 모두 충족한 커밋을 PR로 `develop`에 병합해 Workers Builds 운영 배포를 시작하고, 운영 URL에서 같은 응답과 Cloudflare Observability의 오류율 및 Queue 중지 상태를 확인합니다. `wrangler deploy`는 저장소 `vars`를 그대로 올리므로 대시보드에서 따로 값을 바꾸지 않습니다. 병합 또는 빌드 시작만으로 원격 비활성을 완료했다고 보고하지 않습니다.
5. D1·R2·Queue·DO namespace는 삭제하지 않습니다. 과금 축소가 필요하면 데이터 보존을 전제로 별도 승인합니다.

복원 절차(레거시 Worker를 다시 써야 할 때):

1. `apps/api/wrangler.jsonc`의 운영 `vars.API_ENABLED`와 필요 시 `previews.vars.API_ENABLED`를 `"true"`로 바꾸고, 필요한 검증 후 PR을 `develop`에 병합해 배포합니다. `preview` 검증은 선택적이며 운영과 Preview 중 하나만 복원할 수도 있습니다.
2. 복원 후 `/health`와 실제 업무 경로의 2xx를 확인한 다음 `wrangler queues resume-delivery koin-api-jobs`로 전달을 재개합니다. 재개 전 DLQ에 쌓인 메시지는 수동으로 검토합니다.
3. 원본 동기화(`SOURCE_SYNC_ENABLED`, `triggers.crons`, 원본 호스트 `sync-enabled`)는 이 절차와 무관하며 비용 검토와 사용자 재승인 전에는 비활성 상태를 유지합니다.

## 오류 추적과 자동 수정

관측 역할은 다음과 같이 나눕니다.

- Worker/API/SSR 오류: Cloudflare Issues.
- 브라우저 React/JavaScript 오류와 세션 리플레이: Sentry.
- 플랫폼 요청·CPU·바인딩 상태: Cloudflare Observability.

브라우저 Sentry 프로젝트는 운영 `koin-united-prod`, Preview `koin-united-preview`로 분리합니다. SDK 11은 기본 데이터 수집 범위가 넓으므로 요청 본문·쿠키·헤더·쿼리·사용자 정보 수집을 끄고, 오류·로그·트레이스의 JWT를 전송 전에 가립니다. Replay는 모든 텍스트·입력을 마스킹하고 미디어를 차단합니다. 실제 DSN과 소스맵 업로드 토큰은 환경별 시크릿으로만 설정하며, 이 정책은 Worker/API/SSR 오류를 Sentry로 보내지 않습니다.

자동 수정은 인증된 Cloudflare/Sentry 오류 식별자를 SQLite Durable Object 큐에서 중복 방지하고, 격리된 모델 실행과 독립 검증을 통과한 수정만 **GitHub 이슈 없이 바로 PR**로 발행합니다. 수정안이 없으면 사유와 함께 내부 `wont-fix`로 종료하며 원본 제공자 이슈는 그대로 둡니다. 실행·검증 실패는 `failed`로 구분하고 GitHub 이슈나 실패 댓글을 생성하지 않습니다. 처리 결과·사유·PR 링크는 인증된 진단 응답으로 조회합니다.

- 진단 메시지·스택은 명령이 아닌 비신뢰 데이터입니다.
- 모델에는 GitHub 쓰기 토큰을 제공하지 않습니다.
- Anthropic 키는 `ANTHROPIC_API_KEY` 시크릿으로만 전달합니다.
- 수정 파일 범위·크기·심볼릭 링크를 검증하고, 회귀 테스트와 앱별 실행 검증을 수행합니다.
- 별도 reviewer 자동화, 자동 머지, 모델의 운영 배포는 없습니다.
- 공급자 전송 후 응답이 유실되는 경우까지 exactly-once를 보장하지 않습니다. D1 상태·중복 방지·재처리 정책으로 관리합니다.

자동화의 실제 활성화에는 GitHub 권한, Cloudflare/Sentry 웹훅 설정, 프로젝트와 앱의 명시적 매핑이 필요합니다. API 키를 코드·이슈·PR 본문에 기록하지 않습니다.

기여 방법은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.
