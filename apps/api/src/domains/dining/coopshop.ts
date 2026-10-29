import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Database } from '@api/db/client';
import type { ApiEnv } from '@api/runtime';
import { ApiError } from '@api/errors';
import { requirePrincipal } from '@api/auth';
import { atomicDining, nextId } from '@api/domains/dining/store';
import {
  fail,
  integer,
  kstDate,
  kstTimestamp,
  pageWindow,
  parseDate,
  utcSql,
  type DiningType,
} from '@api/domains/dining/protocol';
import { parseCoopWorkbook, type CoopShopInput } from '@api/domains/dining/spreadsheets';

export const dayNames: Record<string, string> = {
  WEEKDAYS: '평일',
  WEEKEND: '주말',
  MONDAY: '월요일',
  TUESDAY: '화요일',
  WEDNESDAY: '수요일',
  THURSDAY: '목요일',
  FRIDAY: '금요일',
  SATURDAY: '토요일',
  SUNDAY: '일요일',
};
export const diningNames: Record<DiningType, string> = { BREAKFAST: '아침', LUNCH: '점심', DINNER: '저녁' };
export interface Semester {
  id: number;
  semester: string;
  from_date: string;
  to_date: string;
  is_applied: number;
  updated_at: string;
}
interface Shop {
  id: number;
  coop_name_id: number;
  name: string;
  icon_url: string | null;
  phone: string | null;
  location: string;
  remarks: string | null;
  updated_at: string;
}
export interface Open {
  day_of_week: string;
  type: string | null;
  open_time: string | null;
  close_time: string | null;
}
function missingSemester(): never {
  throw new ApiError(404, 'NOT_FOUND_DATA', '생협 학기를 찾을 수 없습니다.');
}
export async function appliedSemester(db: Database): Promise<Semester> {
  const semester = await db.get<Semester>(sql`SELECT * FROM coop_semester WHERE is_applied = 1 LIMIT 1`);
  if (!semester) missingSemester();
  return semester;
}
async function shops(db: Database, semester: number): Promise<Shop[]> {
  return db.all<Shop>(
    sql`SELECT s.*, n.name, n.icon_url FROM coop_shop s JOIN coop_names n ON n.id = s.coop_name_id WHERE s.semester_id = ${semester} ORDER BY s.id`,
  );
}
async function opens(db: Database, shop: number): Promise<Open[]> {
  return db.all<Open>(
    sql`SELECT day_of_week, type, open_time, close_time FROM coop_opens WHERE coop_shop_id = ${shop} ORDER BY id`,
  );
}
function openResponse(open: Open) {
  return { ...open, day_of_week: dayNames[open.day_of_week] ?? open.day_of_week };
}
async function shopResponse(db: Database, shop: Shop, icon: boolean) {
  return {
    id: shop.id,
    name: shop.name,
    opens: (await opens(db, shop.id)).map(openResponse),
    phone: shop.phone,
    location: shop.location,
    remarks: shop.remarks,
    ...(icon ? { icon_url: shop.icon_url } : {}),
  };
}
function semesterResponse(semester: Semester) {
  return {
    id: semester.id,
    semester: semester.semester,
    from_date: semester.from_date,
    to_date: semester.to_date,
    updated_at: kstTimestamp(semester.updated_at),
  };
}
export function openedAt(rows: Open[], now: Date, type: DiningType, early: boolean): boolean {
  const local = new Date(now.getTime() + 32_400_000);
  const day = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][local.getUTCDay()]!;
  const specific = rows.filter((open) => open.day_of_week === day);
  const selected = specific.length
    ? specific
    : rows.filter(
        (open) => open.day_of_week === (local.getUTCDay() === 0 || local.getUTCDay() === 6 ? 'WEEKEND' : 'WEEKDAYS'),
      );
  const seconds =
    local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds() + local.getUTCMilliseconds() / 1000;
  return selected.some((open) => {
    if (
      open.type !== diningNames[type] ||
      !open.open_time ||
      !open.close_time ||
      !/^\d{2}:\d{2}$/.test(open.open_time) ||
      !/^\d{2}:\d{2}$/.test(open.close_time)
    )
      return false;
    const [openH, openM] = open.open_time.split(':').map(Number) as [number, number];
    const [closeH, closeM] = open.close_time.split(':').map(Number) as [number, number];
    if (openH > 23 || closeH > 23 || openM > 59 || closeM > 59) return false;
    return seconds >= openH * 3600 + openM * 60 - (early ? 3600 : 0) && seconds <= closeH * 3600 + closeM * 60;
  });
}
export async function cafeteriaOpened(db: Database, now: Date, type: DiningType, early: boolean): Promise<boolean> {
  const semester = await appliedSemester(db);
  const cafeteria = await db.get<{ id: number }>(
    sql`SELECT s.id FROM coop_shop s JOIN coop_names n ON n.id = s.coop_name_id WHERE s.semester_id = ${semester.id} AND n.name = '학생식당' LIMIT 1`,
  );
  if (!cafeteria) throw new ApiError(404, 'NOT_FOUND_DATA', '생협 매장을 찾을 수 없습니다.');
  return openedAt(await opens(db, cafeteria.id), now, type, early);
}
function validatedInput(body: unknown): CoopShopInput[] {
  if (!body || typeof body !== 'object' || !('coop_shops' in body) || !Array.isArray(body.coop_shops))
    fail('INVALID_REQUEST_BODY');
  const values = body.coop_shops as CoopShopInput[];
  for (const shop of values) {
    if (!shop || !shop.coop_shop_info || !Array.isArray(shop.operation_hours)) fail('INVALID_REQUEST_BODY');
    for (const key of ['name', 'phone', 'location'] as const)
      if (typeof shop.coop_shop_info[key] !== 'string' || !shop.coop_shop_info[key]?.trim())
        fail('INVALID_REQUEST_BODY');
    if (
      shop.coop_shop_info.remark !== null &&
      shop.coop_shop_info.remark !== undefined &&
      typeof shop.coop_shop_info.remark !== 'string'
    )
      fail('INVALID_REQUEST_BODY');
    for (const open of shop.operation_hours) {
      if (!open) fail('INVALID_REQUEST_BODY');
      for (const key of ['day_of_week', 'open_time', 'close_time'] as const)
        if (typeof open[key] !== 'string' || !open[key]?.trim()) fail('INVALID_REQUEST_BODY');
      if (!Object.values(dayNames).includes(open.day_of_week!))
        throw new ApiError(400, 'INVALID_COOP_SHOP_DAY_OF_WEEK', '올바르지 않은 요일입니다.');
    }
  }
  return values;
}
export async function updateCoopShops(db: Database, semesterId: number, body: unknown): Promise<void> {
  const input = validatedInput(body);
  await atomicDining(db, async () => {
    const semester = await db.get<Semester>(sql`SELECT * FROM coop_semester WHERE id = ${semesterId}`);
    if (!semester) missingSemester();
    const names = new Map(
      (await db.all<{ id: number; name: string }>(sql`SELECT id, name FROM coop_names`)).map((name) => [
        name.name,
        name.id,
      ]),
    );
    let nameId = await nextId(db, 'coop_names');
    let shopId = await nextId(db, 'coop_shop');
    let openId = await nextId(db, 'coop_opens');
    const now = utcSql(new Date());
    const statements: SQL[] = [
      sql`DELETE FROM coop_opens WHERE coop_shop_id IN (SELECT id FROM coop_shop WHERE semester_id = ${semesterId})`,
      sql`DELETE FROM coop_shop WHERE semester_id = ${semesterId}`,
    ];
    for (const shop of input) {
      const info = shop.coop_shop_info;
      let id = names.get(info.name!);
      if (id === undefined) {
        id = nameId++;
        names.set(info.name!, id);
        statements.push(sql`INSERT INTO coop_names (id, name) VALUES (${id}, ${info.name})`);
      }
      const createdShop = shopId++;
      statements.push(
        sql`INSERT INTO coop_shop (id, coop_name_id, semester_id, phone, location, remarks, created_at, updated_at) VALUES (${createdShop}, ${id}, ${semesterId}, ${info.phone}, ${info.location}, ${info.remark ?? null}, ${now}, ${now})`,
      );
      for (const open of shop.operation_hours)
        statements.push(
          sql`INSERT INTO coop_opens (id, coop_shop_id, type, day_of_week, open_time, close_time, created_at, updated_at) VALUES (${openId++}, ${createdShop}, ${open.type ?? null}, ${Object.keys(dayNames).find((key) => dayNames[key] === open.day_of_week)!}, ${open.open_time}, ${open.close_time}, ${now}, ${now})`,
        );
    }
    statements.push(sql`UPDATE coop_semester SET updated_at = ${now} WHERE id = ${semesterId}`);
    return { statements, value: undefined };
  });
}
export async function rotateCoopSemester(db: Database, now: Date): Promise<void> {
  await atomicDining(db, async () => {
    const current = await appliedSemester(db);
    const date = kstDate(now);
    if (date > current.from_date && date < current.to_date) return { statements: [], value: undefined };
    const next = await db.get<Semester>(sql`SELECT * FROM coop_semester ORDER BY to_date DESC LIMIT 1`);
    if (!next || !(date > next.from_date && date < next.to_date)) missingSemester();
    return {
      statements: [
        sql`UPDATE coop_semester SET is_applied = 0, updated_at = ${utcSql(now)} WHERE id = ${current.id}`,
        sql`UPDATE coop_semester SET is_applied = 1, updated_at = ${utcSql(now)} WHERE id = ${next.id}`,
      ],
      value: undefined,
    };
  });
}
export async function createCoopSemester(db: Database, body: unknown): Promise<void> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_REQUEST_BODY');
  const input = body as Record<string, unknown>;
  if (
    typeof input.semester !== 'string' ||
    !input.semester.trim() ||
    typeof input.from_date !== 'string' ||
    typeof input.to_date !== 'string'
  )
    fail('INVALID_REQUEST_BODY');
  const name = input.semester;
  const from = parseDate(input.from_date);
  const to = parseDate(input.to_date);
  await atomicDining(db, async () => {
    if (await db.get(sql`SELECT 1 FROM coop_semester WHERE semester = ${name}`))
      throw new ApiError(409, 'DUPLICATE_SEMESTER', '이미 존재하는 학기입니다.');
    if (await db.get(sql`SELECT 1 FROM coop_semester WHERE ${from} <= to_date AND ${to} >= from_date`))
      throw new ApiError(409, 'OVERLAPPING_SEMESTER_DATE_RANGE', '학기 기간이 기존 학기와 겹칩니다.');
    if (from > to) throw new ApiError(400, 'INVALID_START_DATE_AFTER_END_DATE', '시작일은 종료일 이전이여야 합니다.');
    if (!/^\d{2}-.+$/.test(name)) throw new ApiError(400, 'INVALID_SEMESTER_FORMAT', '올바르지 않은 학기 형식입니다.');
    const now = utcSql(new Date());
    return {
      statements: [
        sql`INSERT INTO coop_semester (semester, from_date, to_date, is_applied, created_at, updated_at) VALUES (${name}, ${from}, ${to}, 0, ${now}, ${now})`,
      ],
      value: undefined,
    };
  });
}
export function registerCoopShop(app: Hono<ApiEnv>): void {
  app.get('/coopshop', async (c) => {
    const db = c.get('db');
    const semester = await appliedSemester(db);
    return c.json({
      semester: semester.semester,
      from_date: semester.from_date,
      to_date: semester.to_date,
      updated_at: kstTimestamp(semester.updated_at),
      coop_shops: await Promise.all((await shops(db, semester.id)).map((shop) => shopResponse(db, shop, true))),
    });
  });
  app.get('/coopshop/:coopNameId', async (c) => {
    const db = c.get('db');
    const semester = await appliedSemester(db);
    const shop = (await shops(db, semester.id)).find((row) => row.coop_name_id === integer(c.req.param('coopNameId')));
    if (!shop) throw new ApiError(404, 'NOT_FOUND_DATA', '생협 매장을 찾을 수 없습니다.');
    return c.json({
      ...(await shopResponse(db, shop, true)),
      semester: semester.semester,
      updated_at: kstTimestamp(shop.updated_at)?.slice(0, 10),
    });
  });
  app.get('/admin/coopshop', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const total = (await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM coop_semester`))!.total;
    const page = pageWindow(integer(c.req.query('page') ?? 1), integer(c.req.query('limit') ?? 10), total);
    const semesters = await db.all<Semester>(
      sql`SELECT * FROM coop_semester ORDER BY id LIMIT ${page.size} OFFSET ${page.offset}`,
    );
    return c.json({
      total_count: total,
      current_count: semesters.length,
      total_page: Math.ceil(total / page.size),
      current_page: page.currentPage,
      coop_shop_semesters: semesters.map(semesterResponse),
    });
  });
  app.get('/admin/coopshop/semesters', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const semesters = await c.get('db').all<Semester>(sql`SELECT * FROM coop_semester ORDER BY from_date DESC`);
    return c.json(
      semesters.map((semester) => ({
        id: semester.id,
        semester: semester.semester,
        from_date: semester.from_date,
        to_date: semester.to_date,
        is_applied: Boolean(semester.is_applied),
      })),
    );
  });
  app.post('/admin/coopshop/semesters', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    await createCoopSemester(c.get('db'), await c.req.json());
    return c.body(null, 200);
  });
  app.get('/admin/coopshop/:semesterId', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const semester = await db.get<Semester>(
      sql`SELECT * FROM coop_semester WHERE id = ${integer(c.req.param('semesterId'))}`,
    );
    if (!semester) missingSemester();
    return c.json({
      ...semesterResponse(semester),
      coop_shops: await Promise.all((await shops(db, semester.id)).map((shop) => shopResponse(db, shop, false))),
    });
  });
  app.post('/admin/coopshop/timetable/excel', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const form = await c.req.formData();
    const excel = form.get('coop-shop-excel');
    if (!(excel instanceof File)) fail('INVALID_REQUEST_BODY');
    return c.json({ coop_shops: parseCoopWorkbook(new Uint8Array(await excel.arrayBuffer())) });
  });
  app.put('/admin/coopshop/timetable/:semesterId', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    await updateCoopShops(c.get('db'), integer(c.req.param('semesterId')), await c.req.json());
    return c.body(null, 200);
  });
}
