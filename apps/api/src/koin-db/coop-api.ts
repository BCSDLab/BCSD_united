import { z } from 'zod';
import { fail, kstDate, menuItems } from '@api/domains/dining/protocol';
import { ApiError } from '@api/errors';
import { fetchBridge, invalidBridgeResponse } from '@api/koin-db/bridge';
import { CAFETERIA_PLACES, coopWorkbook, imageEntries, imageZip, zipHeaders } from '@api/koin-db/coop-export';
import { cafeteriaOpened, javaWall } from '@api/koin-db/coop-notify';
import {
  kstWallToMs,
  type Actor,
  type ChangeRow,
  type DiningMeta,
  type ImportedDining,
  type ImportedReport,
  type Opened,
  type Outcome,
} from '@api/koin-db/coop-store';
import { coopOwner, diningObject, localTimestamp } from '@api/koin-db/dining';
import { requireBridgeToken, respond } from '@api/koin-db/dining-api';
import { diningRows, type DiningRow, type OwnedEntry } from '@api/koin-db/dining-store';
import { constantTimeEqual, requireUser } from '@api/koin-db/identity';
import {
  boolParam,
  constraintMessage,
  dateParam,
  hasText,
  intParam,
  invalidBody,
  jacksonBoolean,
  jacksonInteger,
  jacksonString,
  javaInteger,
  jsonBody,
  jsonObject,
  stringParam,
} from '@api/koin-db/spring';
import type { Bindings } from '@api/runtime';

/** Java s3.custom_domain(S3_CUSTOM_DOMAIN). 업로드 file_url·제보 사진·식단 사진 압축의 기준이다. */
export function staticPrefix(env: Bindings): string {
  return env.ENVIRONMENT === 'production' ? 'https://static.koreatech.in/' : 'https://stage-static.koreatech.in/';
}

function unwrap<T>(outcome: Outcome<T>): T {
  if ('error' in outcome) throw new ApiError(outcome.error.status, outcome.error.code, outcome.error.message);
  return outcome.value;
}

const coop = (env: Bindings) => diningObject(env, 'coop');

/**
 * 식단 고정 정보. 날짜 DO 색인에 있으면 DO에서, 없으면 bridge(id 단건)에서 찾는다. MySQL에서 지워진 식단은 null이다.
 */
async function findDining(env: Bindings, id: number): Promise<DiningMeta | null> {
  const date = await diningObject(env, 'index').locate(id);
  if (date !== null) {
    const meta = await diningObject(env, date).diningMeta(id);
    if (meta) return meta;
  }
  if (id < 1) return null;
  const body = await fetchBridge(env, 'dining-menu', { id: String(id) }, true);
  if (body === null) return null;
  const parsed = diningRows.element.safeParse(body);
  if (!parsed.success || parsed.data.id !== id) throw invalidBridgeResponse();
  return { id, date: parsed.data.date, type: parsed.data.type, place: parsed.data.place };
}

/** 오늘(KST) 식단일 때만 Java가 운영 시간을 본다. 그때 날 오류는 실제로 판정에 쓰일 때 던지도록 넘긴다. */
async function soldOutOpened(env: Bindings, meta: DiningMeta, nowMs: number): Promise<Opened> {
  if (meta.date !== kstDate(new Date(nowMs))) return null;
  try {
    return await cafeteriaOpened(env, javaWall.kst(nowMs), meta.type, false);
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
}

const menuNotFound = (id: number) => new ApiError(404, '', `존재하지 않는 메뉴입니다. menuId: ${id}`);

/** PATCH /coop/dining/soldout (@Auth COOP, SoldOutRequest). */
async function changeSoldOut(request: Request, env: Bindings): Promise<Response> {
  await requireUser(request, env, ['COOP']);
  const body = await jsonObject(request);
  const menuId = jacksonInteger(body.menu_id);
  const soldOut = jacksonBoolean(body.sold_out);
  invalidBody([
    ...(menuId === null ? [{ field: 'menu_id', message: '메뉴 ID는 필수입니다.', constraint: 'NotNull' }] : []),
    ...(soldOut === null ? [{ field: 'sold_out', message: '품절 여부는 필수입니다.', constraint: 'NotNull' }] : []),
  ]);
  const now = Date.now();
  const meta = await findDining(env, menuId!);
  if (!meta) throw menuNotFound(menuId!);
  unwrap(await coop(env).changeSoldOut(meta, soldOut!, now, await soldOutOpened(env, meta, now)));
  return new Response(null, { status: 200 });
}

/** PATCH /coop/dining/image (@Auth COOP, DiningImageRequest). 운영 시간은 JVM 시계(LocalDateTime.now(clock)) 기준이다. */
async function saveImage(request: Request, env: Bindings): Promise<Response> {
  await requireUser(request, env, ['COOP']);
  const body = await jsonObject(request);
  const menuId = jacksonInteger(body.menu_id);
  const imageUrl = jacksonString(body.image_url);
  invalidBody([
    ...(menuId === null ? [{ field: 'menu_id', message: '메뉴 ID는 필수입니다.', constraint: 'NotNull' }] : []),
    ...(!imageUrl ? [{ field: 'image_url', message: '메뉴 이미지는 필수입니다.', constraint: 'NotEmpty' }] : []),
  ]);
  const now = Date.now();
  const meta = await findDining(env, menuId!);
  if (!meta) throw menuNotFound(menuId!);
  const opened = await cafeteriaOpened(env, javaWall.jvm(now), meta.type, true);
  unwrap(await coop(env).saveImage(meta, imageUrl!, now, opened));
  return new Response(null, { status: 200 });
}

/** MySQL 식단에 coop 소유 값을 덮는다(가져오기 전이면 그대로). */
function withOwned<T extends Pick<DiningRow, 'id' | 'sold_out' | 'image_url'>>(
  rows: T[],
  owned: OwnedEntry[] | null,
): T[] {
  if (owned === null) return rows;
  const byId = new Map(owned.map((entry) => [entry.id, entry]));
  return rows.map((row) => {
    const entry = byId.get(row.id);
    return entry ? { ...row, sold_out: entry.sold_out, image_url: entry.image_url } : row;
  });
}

async function rangeRows(env: Bindings, from: string, to: string): Promise<DiningRow[]> {
  const parsed = diningRows.safeParse(await fetchBridge(env, 'dining-range', { from, to }));
  if (!parsed.success) throw invalidBridgeResponse();
  return withOwned(parsed.data, coopOwner(env) ? await coop(env).ownedRange(from, to) : null);
}

/** CoopService.validateDates. 오늘은 JVM 기본 시간대(운영 Asia/Seoul)이고 예외 detail이 없어 " null"이 붙는다. */
function validateExportDates(start: string, end: string, nowMs: number): void {
  const today = new Date(javaWall.jvm(nowMs)).toISOString().slice(0, 10);
  const invalid = (message: string) => new ApiError(400, '', `${message} null`);
  if (start < '2022-11-29' || end < '2022-11-29') throw invalid('2022/11/29 식단부터 다운받을 수 있어요.');
  if (start > today || end > today) throw invalid('오늘 날짜 이후 기간은 설정할 수 없어요.');
  if (start > end) throw invalid('시작일은 종료일 이전으로 설정해주세요.');
}

/** GET /coop/dining/excel. 같은 기간 요청은 검증 전에 30초 제한을 먼저 건다(Java 순서). */
async function excel(request: Request, env: Bindings, url: URL): Promise<Response> {
  await requireUser(request, env, ['COOP']);
  const start = dateParam(url, 'startDate');
  const end = dateParam(url, 'endDate');
  const cafeteria = boolParam(url, 'isCafeteria', false);
  const now = Date.now();
  unwrap(await coop(env).excelGuard(start, end, now));
  validateExportDates(start, end, now);
  const rows = (await rangeRows(env, start, end)).filter((row) => !cafeteria || CAFETERIA_PLACES.includes(row.place));
  return new Response(coopWorkbook(rows, cafeteria), {
    headers: {
      'Content-Disposition': `attachment; filename=${start} ~ ${end} menu.xlsx`,
      'Content-Type': 'application/octet-stream',
    },
  });
}

/** GET /coop/dining/image: 기간 내 사진을 dining_images.zip으로 스트리밍한다. */
async function imageArchive(request: Request, env: Bindings, url: URL): Promise<Response> {
  await requireUser(request, env, ['COOP']);
  const start = dateParam(url, 'startDate');
  const end = dateParam(url, 'endDate');
  const cafeteria = boolParam(url, 'isCafeteria', false);
  const now = Date.now();
  validateExportDates(start, end, now);
  const rows = (await rangeRows(env, start, end)).filter(
    (row) => row.image_url !== null && (!cafeteria || CAFETERIA_PLACES.includes(row.place)),
  );
  return new Response(imageZip(imageEntries(rows, staticPrefix(env))), { headers: zipHeaders(now) });
}

const searchResult = z
  .object({ page: z.number().int().positive(), total: z.number().int().nonnegative(), rows: diningRows })
  .strict();
// DiningPlace enum 상수명 → place 값.
const diningPlaces: Record<string, string> = {
  A코너: 'A코너',
  B코너: 'B코너',
  C코너: 'C코너',
  능수관: '능수관',
  캠퍼스2: '2캠퍼스',
};

/** `@RequestParam(required = false) List<DiningPlace> filter`: 쉼표 분리, 빈 값 무시, 없으면 전체. */
function placeFilter(url: URL): string[] {
  const names = url.searchParams
    .getAll('filter')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const places = names.map((name) => diningPlaces[name] ?? fail('ILLEGAL_ARGUMENT'));
  return places.length ? [...new Set(places)] : Object.values(diningPlaces);
}

/**
 * GET /dinings/search (@Auth COOP). 페이지 보정은 전체 식단 수 기준(Criteria), 결과는 메뉴 LIKE·코너 필터·ID 내림차순.
 * 응답의 soldout_at·changed_at은 Java처럼 created_at이다. 사진은 coop 소유 값, 좋아요는 DO 값을 쓴다.
 */
async function search(request: Request, env: Bindings, url: URL): Promise<Response> {
  await requireUser(request, env, ['COOP']);
  const keyword = stringParam(url, 'keyword');
  const page = Math.max(intParam(url, 'page', 1), 1);
  const limit = Math.min(Math.max(intParam(url, 'limit', 10), 1), 50);
  const places = placeFilter(url);
  const parsed = searchResult.safeParse(
    await fetchBridge(env, 'dining-search', {
      keyword,
      places: places.join(','),
      page: String(page),
      limit: String(limit),
    }),
  );
  if (!parsed.success) throw invalidBridgeResponse();
  const ids = parsed.data.rows.map((row) => row.id);
  const rows = withOwned(parsed.data.rows, coopOwner(env) && ids.length ? await coop(env).ownedByIds(ids) : null);
  const likes = new Map<number, number>();
  const located: Record<number, string> = ids.length ? await diningObject(env, 'index').locateMany(ids) : {};
  for (const date of new Set(Object.values(located))) {
    const view = await diningObject(env, date).view(null);
    if (view.syncedAt === null || !view.imported) continue;
    for (const row of view.rows) likes.set(row.id, row.likes ?? 0);
  }
  const { total } = parsed.data;
  return Response.json({
    total_count: total,
    current_count: rows.length,
    total_page: Math.ceil(total / limit),
    current_page: parsed.data.page,
    dinings: rows.map((row) => ({
      id: row.id,
      date: row.date,
      type: row.type,
      place: row.place,
      kcal: row.kcal,
      menu: menuItems(row.menu),
      image_url: row.image_url,
      created_at: localTimestamp(row.created_at),
      soldout_at: localTimestamp(row.created_at),
      changed_at: localTimestamp(row.created_at),
      likes: likes.get(row.id) ?? row.likes,
    })),
  });
}

/**
 * DiningReportService.validateImage: 정적 도메인의 upload/COOP/ 파일(쿼리·프래그먼트·폴더 불가)이고 실제로 있어야 한다.
 * 존재 확인은 S3 대신 같은 버킷을 내보내는 CloudFront에 HEAD로 한다(403·404 = 없음).
 */
async function validateReportImage(env: Bindings, imageUrl: string): Promise<void> {
  const prefix = staticPrefix(env);
  if (!imageUrl.startsWith(prefix)) fail('INVALID_REPORT_IMAGE');
  const key = imageUrl.slice(prefix.length);
  const escaped = key.replace(/%/g, '%25').replace(/ /g, '%20');
  // java.net.URI 경로에 쓸 수 있는 문자(비 ASCII는 제어·공백 문자가 아니면 허용). '?'·'#'은 쿼리·프래그먼트다.
  const uriPath = /^(?:[A-Za-z0-9\-_.!~*'(),;:$&+=/@]|%[0-9A-Fa-f]{2}|[^\p{ASCII}\p{Cc}\p{Zs}\p{Zl}\p{Zp}])*$/u;
  if (!uriPath.test(escaped) || !key.startsWith('upload/COOP/') || key.endsWith('/')) fail('INVALID_REPORT_IMAGE');
  let response: Response;
  try {
    response = await fetch(prefix + escaped, { method: 'HEAD', redirect: 'manual' });
  } catch {
    fail('IMAGE_STORAGE_UNAVAILABLE');
  }
  if (response.status === 403 || response.status === 404) fail('INVALID_REPORT_IMAGE');
  if (!response.ok) fail('IMAGE_STORAGE_UNAVAILABLE');
}

/** POST /dinings/{diningId}/soldout-reports (@Auth STUDENT, DiningReportCreateRequest). */
async function createReport(request: Request, env: Bindings, diningPath: string): Promise<Response> {
  const userId = await requireUser(request, env, ['STUDENT']);
  const diningId = javaInteger(diningPath);
  const body = await jsonObject(request);
  const imageUrl = jacksonString(body.image_url);
  invalidBody([
    ...(imageUrl === null || imageUrl.trim() === ''
      ? [{ field: 'image_url', message: '제보 사진 URL은 필수입니다.', constraint: 'NotBlank' }]
      : []),
    ...(imageUrl !== null && imageUrl.length > 2048
      ? [{ field: 'image_url', message: '제보 사진 URL은 2048자 이하여야 합니다.', constraint: 'Size' }]
      : []),
  ]);
  await validateReportImage(env, imageUrl!);
  const meta = await findDining(env, diningId);
  if (!meta) fail('NOT_FOUND_DINING');
  return Response.json(unwrap(await coop(env).createReport(meta, userId, imageUrl!, Date.now())), { status: 201 });
}

/** DiningReportBotInterceptor: 설정 토큰과 X-Koin-Service-Token을 상수 시간 비교한다(Bearer 없음). */
function botAuthorized(request: Request, env: Bindings): boolean {
  const expected = env.DINING_REPORT_BOT_TOKEN;
  const actual = request.headers.get('X-Koin-Service-Token');
  return hasText(expected) && hasText(actual) && constantTimeEqual(actual, expected);
}

/** DiningReportDecisionRequest: actor(@Valid @NotNull) — workspace_id·user_id(64자)·display_name(80자) @NotBlank. */
function decisionActor(request: Request, body: Record<string, unknown>): Actor {
  const value = body.actor;
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    fail('NOT_READABLE_HTTP_MESSAGE');
  }
  if (value === undefined || value === null) {
    invalidBody([{ field: 'actor', message: '처리자 정보는 필수입니다.', constraint: 'NotNull' }]);
  }
  const fields = value as Record<string, unknown>;
  const actor = {
    workspace_id: jacksonString(fields.workspace_id),
    user_id: jacksonString(fields.user_id),
    display_name: jacksonString(fields.display_name),
  };
  const violations = (
    [
      ['workspace_id', 'workspace_id', 64],
      ['user_id', 'user_id', 64],
      ['display_name', 'display_name', 80],
    ] as const
  ).flatMap(([key, field, max]) => {
    const text = actor[key];
    return [
      ...(!hasText(text)
        ? [{ field: `actor.${field}`, message: constraintMessage(request, 'NotBlank'), constraint: 'NotBlank' }]
        : []),
      ...(text !== null && text.length > max
        ? [{ field: `actor.${field}`, message: constraintMessage(request, 'Size', max), constraint: 'Size' }]
        : []),
    ];
  });
  invalidBody(violations);
  return actor as Actor;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** DiningReportDeliveryResultRequest.fromJson: 두 필드만, 순서대로 attempt_token → outcome을 검사한다. */
async function deliveryResult(request: Request): Promise<{ token: string; outcome: 'SUCCEEDED' | 'FAILED' }> {
  const body = await jsonBody(request);
  if (body === null) fail('INVALID_REQUEST_BODY');
  if (typeof body !== 'object' || Array.isArray(body)) fail('NOT_READABLE_HTTP_MESSAGE');
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'attempt_token' && key !== 'outcome')) fail('INVALID_REQUEST_BODY');
  const text = (key: string): string => {
    const value = fields[key];
    if (value === undefined || value === null) fail('INVALID_REQUEST_BODY');
    if (typeof value !== 'string') fail('NOT_READABLE_HTTP_MESSAGE');
    if (value === '') fail('INVALID_REQUEST_BODY');
    return value;
  };
  const token = text('attempt_token');
  if (!UUID_PATTERN.test(token)) fail('NOT_READABLE_HTTP_MESSAGE');
  const outcome = text('outcome');
  if (outcome !== 'SUCCEEDED' && outcome !== 'FAILED') fail('NOT_READABLE_HTTP_MESSAGE');
  return { token: token.toLowerCase(), outcome };
}

const REPORTS = '/internal/dining/soldout-reports';

/** Spring 경로 변수 디코딩. 잘못된 %XX는 그대로 두어 변환 단계에서 ILLEGAL_ARGUMENT가 되게 한다. */
function pathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** DiningReportBotController 경로. 알 수 없는 경로는 null(인증 뒤 Java로 전달). */
function botHandler(request: Request, env: Bindings, url: URL): (() => Promise<Response>) | null {
  const path = url.pathname.slice(REPORTS.length);
  const store = coop(env);
  if (request.method === 'POST' && path === '/deliveries/claim') {
    return async () => {
      const claim = unwrap(await store.claim(Date.now()));
      return claim ? Response.json(claim) : new Response(null, { status: 204, headers: { 'Retry-After': '5' } });
    };
  }
  const result = /^\/deliveries\/([^/]+)\/result$/.exec(path);
  if (request.method === 'POST' && result) {
    return async () => {
      const body = await deliveryResult(request);
      const deliveryId = pathSegment(result[1]!);
      if (!UUID_PATTERN.test(deliveryId)) fail('ILLEGAL_ARGUMENT');
      const recorded = await store.recordResult(deliveryId.toLowerCase(), body.token, body.outcome, Date.now());
      return Response.json(unwrap(recorded));
    };
  }
  const decision = /^\/([^/]+)\/(approve|reject)$/.exec(path);
  if (request.method === 'POST' && decision) {
    return async () => {
      const reportId = javaInteger(pathSegment(decision[1]!));
      const actor = decisionActor(request, await jsonObject(request));
      const now = Date.now();
      const meta = unwrap(await store.reportDining(reportId));
      const approve = decision[2] === 'approve';
      const opened = approve ? await soldOutOpened(env, meta, now) : null;
      return Response.json(unwrap(await store.decide(reportId, actor, approve ? 'APPROVED' : 'REJECTED', now, opened)));
    };
  }
  const detail = /^\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && detail) {
    return async () => Response.json(unwrap(await store.botReport(javaInteger(pathSegment(detail[1]!)))));
  }
  return null;
}

const reporterName = z
  .object({ id: z.number().int(), name: z.string().nullable(), nickname: z.string().nullable() })
  .strict();

/** AdminDiningReportController. */
async function admin(request: Request, env: Bindings, url: URL, reportPath: string | undefined): Promise<Response> {
  await requireUser(request, env, ['ADMIN']);
  if (reportPath === undefined) {
    const onlyPending = boolParam(url, 'only_pending', false);
    const page = intParam(url, 'page', 1);
    const limit = intParam(url, 'limit', 10);
    return Response.json(unwrap(await coop(env).adminReports(onlyPending, page, limit)));
  }
  const reportId = javaInteger(pathSegment(reportPath));
  const { report, reporter_id: reporterId } = unwrap(await coop(env).adminReport(reportId));
  let reporter: { id: number; name: string } | null = null;
  if (reporterId !== null && reporterId > 0) {
    const body = await fetchBridge(env, 'user-names', { id: String(reporterId) }, true);
    if (body !== null) {
      const parsed = reporterName.safeParse(body);
      if (!parsed.success || parsed.data.id !== reporterId) throw invalidBridgeResponse();
      const { name, nickname } = parsed.data;
      reporter = { id: reporterId, name: hasText(name) ? name : hasText(nickname) ? nickname : '회원' };
    }
  }
  return Response.json({ ...report, reporter });
}

/**
 * 소유권 전환 뒤 Workers가 처리하는 학식 쓰기·조회. 해당하지 않으면 null(Java로 전달).
 * nginx 전환 경로와 같아야 한다(bcsdpdevops-ops/host/koin-edge/nginx-dinings-location.conf).
 */
export async function handleCoopRoute(request: Request, env: Bindings, url: URL): Promise<Response | null> {
  if (!coopOwner(env)) return null;
  const { method } = request;
  const path = url.pathname;
  if (method === 'PATCH' && path === '/coop/dining/soldout') return respond(() => changeSoldOut(request, env));
  if (method === 'PATCH' && path === '/coop/dining/image') return respond(() => saveImage(request, env));
  if (method === 'GET' && path === '/coop/dining/image') return respond(() => imageArchive(request, env, url));
  if (method === 'GET' && path === '/coop/dining/excel') return respond(() => excel(request, env, url));
  if (method === 'GET' && path === '/dinings/search') return respond(() => search(request, env, url));
  const report = /^\/dinings\/([^/]+)\/soldout-reports$/.exec(path);
  if (method === 'POST' && report) return respond(() => createReport(request, env, pathSegment(report[1]!)));
  if (path === REPORTS || path.startsWith(`${REPORTS}/`)) {
    // 인터셉터처럼 경로와 무관하게 삐봇 인증을 먼저 본다.
    if (!botAuthorized(request, env)) return respond(async () => fail('BOT_AUTHENTICATION_FAILED'));
    const handler = botHandler(request, env, url);
    return handler ? respond(handler) : null;
  }
  const adminReports = /^\/admin\/dining\/soldout-reports(?:\/([^/]+))?$/.exec(path);
  if (method === 'GET' && adminReports) return respond(() => admin(request, env, url, adminReports[1]));
  if (method === 'POST' && path === '/internal/workers/dining-coop/import') {
    return respond(() => importCoopState(request, env, url));
  }
  return null;
}

// ── MySQL 상태 가져오기 ─────────────────────────────────────────────────────

const nullableText = z.string().nullable();
const ownedRows = z
  .object({
    id: z.number().int().positive(),
    date: z.string(),
    type: z.enum(['BREAKFAST', 'LUNCH', 'DINNER']),
    place: z.string(),
    sold_out: nullableText,
    sold_out_source: nullableText,
    image_url: nullableText,
  })
  .strict()
  .array();
const reportRows = z
  .object({
    id: z.number().int().positive(),
    dining_id: z.number().int(),
    reporter_id: z.number().int().nullable(),
    image_url: z.string(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    processing_type: z.enum(['MANUAL', 'SAME_DINING_APPROVED', 'COOP_PREPROCESSED']).nullable(),
    processing_id: nullableText,
    source_report_id: z.number().int().nullable(),
    processor_workspace_id: nullableText,
    processor_user_id: nullableText,
    processor_name: nullableText,
    processed_at: nullableText,
    created_at: z.string(),
    updated_at: z.string(),
    dining_date: z.string(),
    dining_type: z.enum(['BREAKFAST', 'LUNCH', 'DINNER']),
    dining_place: z.string(),
  })
  .strict()
  .array();
const changeRows = z
  .object({
    sequence: z.number().int().positive(),
    report_id: z.number().int(),
    event_type: z.enum(['CREATED', 'PROCESSED']),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    processing_type: z.enum(['MANUAL', 'SAME_DINING_APPROVED', 'COOP_PREPROCESSED']).nullable(),
    processing_id: nullableText,
    occurred_at: z.string(),
    delivery_id: nullableText,
    report_snapshot: nullableText,
    delivery_state: z.enum(['QUEUED', 'IN_PROGRESS', 'DELIVERED']),
    attempt_token: nullableText,
    expires_at: nullableText,
    next_attempt_at: nullableText,
    accepted_outcome: z.enum(['SUCCEEDED', 'FAILED']).nullable(),
  })
  .strict()
  .array();
const sequenceRow = z.object({ last_sequence: z.number().int().nonnegative() }).strict();

/** 커서(after) 기준으로 끝까지 읽는다. bridge는 한 번에 최대 page건을 준다. */
async function readAll<T>(
  env: Bindings,
  resource: 'dining-owned' | 'dining-reports' | 'dining-report-changes',
  schema: z.ZodType<T[]>,
  cursor: (row: T) => number,
  consume: (rows: T[]) => Promise<void>,
): Promise<void> {
  let after = 0;
  for (;;) {
    const parsed = schema.safeParse(await fetchBridge(env, resource, { after: String(after) }));
    if (!parsed.success) throw invalidBridgeResponse();
    if (!parsed.data.length) return;
    await consume(parsed.data);
    after = cursor(parsed.data[parsed.data.length - 1]!);
  }
}

/**
 * POST /internal/workers/dining-coop/import[?force=1] (Bearer KOIN_DB_BRIDGE_TOKEN).
 * nginx가 품절·사진·제보 쓰기를 Workers로 돌린 뒤(MySQL 쓰기가 멈춘 뒤) 한 번 실행해 MySQL 상태를 coop DO로 옮긴다.
 * 끝나기 전에는 coop 쓰기가 503이다. 다시 실행하면 처음부터 다시 가져온다(완료 뒤에는 force만).
 */
async function importCoopState(request: Request, env: Bindings, url: URL): Promise<Response> {
  requireBridgeToken(request, env);
  const store = coop(env);
  unwrap(await store.importBegin(url.searchParams.get('force') === '1'));
  await readAll(
    env,
    'dining-owned',
    ownedRows,
    (row) => row.id,
    async (rows) => store.importDinings(rows as ImportedDining[]),
  );
  await readAll(
    env,
    'dining-reports',
    reportRows,
    (row) => row.id,
    async (rows) => store.importReports(rows as ImportedReport[]),
  );
  await readAll(
    env,
    'dining-report-changes',
    changeRows,
    (row) => row.sequence,
    async (rows) =>
      store.importChanges(
        rows.map((row): ChangeRow => ({
          ...row,
          expires_at: row.expires_at === null ? null : kstWallToMs(row.expires_at),
          next_attempt_at: row.next_attempt_at === null ? null : kstWallToMs(row.next_attempt_at),
        })),
      ),
  );
  const sequence = sequenceRow.safeParse(await fetchBridge(env, 'dining-report-sequence', {}));
  if (!sequence.success) throw invalidBridgeResponse();
  return Response.json(unwrap(await store.importFinish(sequence.data.last_sequence)));
}
