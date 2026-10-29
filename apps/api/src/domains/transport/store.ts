import { sql } from 'drizzle-orm';
import { type Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import {
  type Shuttle,
  type CityTimetable,
  regions,
  routeTypes,
  weekdays,
  days,
  invalid,
  mergePartial,
} from '@api/domains/transport/algorithms';

export async function cacheRead<T>(db: Database, id: string, now = Date.now()): Promise<T | null> {
  const rows = await db.all<{ payload: string }>(
    sql`SELECT payload FROM native_transport_cache WHERE id = ${id} AND (expires_at IS NULL OR expires_at > ${now})`,
  );
  return rows[0] ? (JSON.parse(rows[0].payload) as T) : null;
}
export async function cacheWrite(db: Database, id: string, payload: unknown, ttl: number | null, now: number) {
  await db.run(
    sql`INSERT INTO native_transport_cache(id,payload,expires_at,updated_at) VALUES(${id},${JSON.stringify(payload)},${ttl === null ? null : now + ttl},${now}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at, updated_at=excluded.updated_at WHERE excluded.updated_at >= native_transport_cache.updated_at`,
  );
}
export async function version(db: Database, type: string) {
  const rows = await db.all<{ title: string | null; content: string | null; updated_at: string }>(
    sql`SELECT title,content,updated_at FROM versions WHERE type=${type} AND is_previous=0 LIMIT 1`,
  );
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', '버전이 존재하지 않습니다.');
  return rows[0];
}
export async function shuttleTables(db: Database, semester?: string): Promise<Shuttle[]> {
  const active = semester ?? (await version(db, 'shuttle_bus_timetable')).title;
  const rows = await db.all<Omit<Shuttle, 'node_info' | 'route_info'> & { node_info: string; route_info: string }>(
    sql`SELECT * FROM shuttlebus_timetables WHERE semester_type=${active} ORDER BY rowid`,
  );
  return rows.map((r) => ({ ...r, node_info: JSON.parse(r.node_info), route_info: JSON.parse(r.route_info) }));
}
export async function cityTables(db: Database): Promise<CityTimetable[]> {
  const rows = await db.all<{ id: string; updated_at: string; bus_info: string; bus_timetables: string }>(
    sql`SELECT * FROM citybus_timetables ORDER BY rowid`,
  );
  return rows.map((r) => ({ ...r, bus_info: JSON.parse(r.bus_info), bus_timetables: JSON.parse(r.bus_timetables) }));
}
export async function updateTimetables(
  db: Database,
  body: unknown,
  semester: string,
  commuting: boolean,
  replace: boolean,
) {
  const semesters: Record<string, string> = { REGULAR: '정규학기', SEASONAL: '계절학기', VACATION: '방학기간' };
  if (!(semester in semesters)) invalid();
  const semesterName = semesters[semester]!;
  const keyName = commuting ? 'commuting_bus_timetables' : 'shuttle_bus_timetables';
  const list = body && typeof body === 'object' ? (body as Record<string, unknown>)[keyName] : null;
  if (!Array.isArray(list) || !list.length) invalid('버스 시간표 정보 목록은 비어 있을 수 없습니다.');
  const existing = await shuttleTables(db, semesterName);
  const key = (t: Pick<Shuttle, 'region' | 'route_type' | 'route_name' | 'sub_name'>) =>
    JSON.stringify([t.region, t.route_type, t.route_name, t.sub_name]);
  const prepared = new Map<string, Shuttle>();
  const original = new Map(existing.map((t) => [key(t), t]));
  for (const input of list) {
    if (!input || typeof input !== 'object') invalid();
    const t = input as Omit<Shuttle, 'region' | 'route_type'> & { region: string; route_type: string };
    if (
      ![t.region, t.route_type, t.route_name].every((v) => typeof v === 'string' && v.trim()) ||
      !Array.isArray(t.node_info) ||
      !t.node_info.length ||
      !Array.isArray(t.route_info) ||
      !t.route_info.length
    )
      invalid('노선과 정류장, 회차 정보는 필수입니다.');
    if (t.sub_name != null && typeof t.sub_name !== 'string') invalid();
    const region = (Object.keys(regions) as (keyof typeof regions)[]).find((r) => regions[r].includes(t.region));
    const route_type = (Object.keys(routeTypes) as (keyof typeof routeTypes)[]).find(
      (r) => routeTypes[r] === t.route_type,
    );
    if (!region) invalid('버스 지역 구분이 잘못되었습니다.');
    if (!route_type) invalid('버스 노선 구분이 잘못되었습니다.');
    if (commuting && route_type !== 'WEEKDAYS')
      throw new ApiError(400, 'INVALID_SHUTTLE_ROUTE_TYPE', '등하교 버스 타입이 아닙니다.');
    const normalized = { ...t, region, route_type, sub_name: t.sub_name ?? null };
    const identity = key(normalized);
    if (replace && prepared.has(identity)) invalid('전체 교체 요청에는 같은 노선 키를 여러 번 포함할 수 없습니다.');
    const old = prepared.get(identity) ?? original.get(identity);
    const nodes = t.node_info.map((n) => {
      if (!n || typeof n.name !== 'string' || !n.name.trim()) invalid('정류장 이름은 비어 있을 수 없습니다.');
      if (n.detail != null && typeof n.detail !== 'string') invalid();
      return { name: n.name, detail: n.detail ?? null };
    });
    const routes = t.route_info.map((r) => {
      if (!r || typeof r.name !== 'string' || !r.name.trim()) invalid('회차 이름은 비어 있을 수 없습니다.');
      if (r.detail != null && typeof r.detail !== 'string') invalid();
      if (
        !Array.isArray(r.arrival_time) ||
        r.arrival_time.length !== nodes.length ||
        r.arrival_time.some((a) => a !== null && typeof a !== 'string')
      )
        invalid('회차별 도착 시간 개수는 정류장 개수와 같아야 합니다.');
      let running = r.running_days ?? null;
      if (running !== null && (!Array.isArray(running) || running.some((d) => !days.includes(d))))
        invalid('운행 요일 코드가 올바르지 않습니다.');
      if (commuting && !old && !running?.length) running = [...weekdays];
      if (!commuting && (replace || !old) && !running?.length)
        throw new ApiError(400, 'REQUIRED_SHUTTLE_RUNNING_DAYS', '신규 셔틀버스 시간표에는 운행 요일이 필요합니다.');
      return { name: r.name, detail: r.detail ?? null, arrival_time: r.arrival_time, running_days: running };
    });
    const digest = old
      ? ''
      : Array.from(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${semesterName}:${identity}`)),
          ),
          (b) => b.toString(16).padStart(2, '0'),
        )
          .join('')
          .slice(0, 24);
    const next: Shuttle =
      old && !replace
        ? mergePartial(old, nodes, routes)
        : { ...normalized, id: old?.id ?? digest, semester_type: semesterName, node_info: nodes, route_info: routes };
    prepared.set(identity, next);
  }
  const payload = [...prepared.entries()].map(([identity, t]) => ({
    ...t,
    node_info: JSON.stringify(t.node_info),
    route_info: JSON.stringify(t.route_info),
    expected: original.has(identity) ? JSON.stringify(original.get(identity)!.route_info) : null,
    expected_nodes: original.has(identity) ? JSON.stringify(original.get(identity)!.node_info) : null,
  }));
  const encoded = JSON.stringify(payload);
  const result =
    await db.run(sql`INSERT INTO shuttlebus_timetables(id,semester_type,region,route_type,route_name,sub_name,node_info,route_info)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.semester_type'),json_extract(value,'$.region'),json_extract(value,'$.route_type'),json_extract(value,'$.route_name'),json_extract(value,'$.sub_name'),json_extract(value,'$.node_info'),json_extract(value,'$.route_info') FROM json_each(${encoded})
    WHERE NOT EXISTS (SELECT 1 FROM json_each(${encoded}) candidate LEFT JOIN shuttlebus_timetables old ON old.id=json_extract(candidate.value,'$.id') WHERE COALESCE(json(old.route_info),'null') != COALESCE(json(json_extract(candidate.value,'$.expected')),'null') OR COALESCE(json(old.node_info),'null') != COALESCE(json(json_extract(candidate.value,'$.expected_nodes')),'null'))
    ON CONFLICT(id) DO UPDATE SET node_info=excluded.node_info,route_info=excluded.route_info`);
  if (result.meta.changes !== payload.length)
    throw new ApiError(409, 'CONFLICT', '시간표가 변경되었습니다. 다시 조회한 후 수정해 주세요.');
}
