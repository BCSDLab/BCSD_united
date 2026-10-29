import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import type { Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import type { ApiEnv, Bindings } from '@api/runtime';
import {
  addMinutes,
  calendar,
  cityOffset,
  clockSeconds,
  expressRouteTimes,
  invalid,
  kst,
  localSeconds,
  regions,
  routeTypes,
  shuttleSchedule,
  station,
  stations,
  type Schedule,
  type Shuttle,
  type Station,
} from '@api/domains/transport/algorithms';
import { stationNodes, type CityArrival, type ExpressArrival } from '@api/domains/transport/clients';
import { parseCommutingWorkbook, parseShuttleWorkbook } from '@api/domains/transport/excel';
import { cacheRead, cityTables, shuttleTables, updateTimetables, version } from '@api/domains/transport/store';
import { getWeather } from '@api/domains/transport/weather';

export { runTransportCron } from '@api/domains/transport/clients';

interface Arrival {
  bus_number: number | null;
  arrival_seconds: number;
}

const DEFAULT_CITY_BUS_NUMBERS = [400, 402, 405];
const CITY_BUS_ORIGINS = [
  [400, '병천3리'],
  [402, '황사동'],
  [405, '유관순열사사적지'],
] as const;
const CITY_DIRECTIONS = ['종합터미널', '병천3리', '황사동', '유관순열사사적지'];
const TERMINAL_NODE = '종합터미널';

function required(c: Context<ApiEnv>, name: string): string {
  const value = c.req.query(name);
  if (value === undefined) invalid(`필수 요청 파라미터가 없습니다: ${name}`);
  return value;
}

function busType(value: string, route = false): string {
  const type = value.toLowerCase();
  const supported = route ? ['city', 'express', 'shuttle', 'all'] : ['city', 'express', 'shuttle', 'commuting'];
  if (!supported.includes(type)) throw new ApiError(404, 'NOT_FOUND', '버스 타입이 존재하지 않습니다.');
  return type;
}

function queryDateTime(c: Context<ApiEnv>) {
  const date = required(c, 'date');
  const raw = required(c, 'time');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    invalid();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/.test(raw)) invalid();
  const parts = raw.split(':');
  const seconds = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2] ?? 0);
  return { date, time: raw, seconds };
}

function rejectDuplicate(depart: Station, arrival: Station): void {
  if (depart === arrival) throw new ApiError(400, 'INVALID_REQUEST_BODY', '버스 정류장이 잘못되었습니다.');
}

/** 정류장 노드들에 정차하는 노선 번호 캐시. 캐시가 비어 있으면 기본 세 노선으로 본다. */
async function availableNumbers(db: Database, nodes: string[], now: number): Promise<Set<number>> {
  const records = await Promise.all(nodes.map((node) => cacheRead<number[]>(db, `CityBusRoute:${node}`, now)));
  const values = new Set(records.flatMap((record) => record ?? []));
  return values.size ? values : new Set(DEFAULT_CITY_BUS_NUMBERS);
}

async function cityArrivals(db: Database, depart: Station, arrival: Station, now: number): Promise<Arrival[]> {
  const direction = stations.indexOf(depart) < stations.indexOf(arrival) ? 'SOUTH' : 'NORTH';
  const departureNodes = stationNodes[depart][direction];
  const [departureNumbers, arrivalNumbers, arrivals] = await Promise.all([
    availableNumbers(db, departureNodes, now),
    availableNumbers(db, stationNodes[arrival][direction], now),
    Promise.all(departureNodes.map((node) => cacheRead<CityArrival[]>(db, `CityBus:${node}`, now))),
  ]);
  return arrivals
    .flatMap((value) => value ?? [])
    .filter((value) => departureNumbers.has(value.bus_number) && arrivalNumbers.has(value.bus_number));
}

export async function getBusRemainTime(
  db: Database,
  _env: Bindings,
  typeValue: string,
  departValue: string,
  arrivalValue: string,
  now = Date.now(),
) {
  const type = busType(typeValue);
  const depart = station(departValue);
  const arrival = station(arrivalValue);
  rejectDuplicate(depart, arrival);
  const current = clockSeconds(now);
  let values: Arrival[];
  if (type === 'city') {
    values = await cityArrivals(db, depart, arrival, now);
  } else if (type === 'express') {
    const cached = await cacheRead<ExpressArrival[]>(
      db,
      `expressBus:${depart.toLowerCase()}:${arrival.toLowerCase()}`,
      now,
    );
    values = (cached ?? []).map((value) => ({ bus_number: null, arrival_seconds: localSeconds(value.depart) }));
  } else {
    const schedules = shuttleSchedule(await shuttleTables(db), calendar(now), depart, arrival, type);
    values = [...new Set(schedules.map((schedule) => schedule.depart_time))].map((time) => ({
      bus_number: null,
      arrival_seconds: localSeconds(time),
    }));
  }
  const remaining = values
    .filter((value) => value.arrival_seconds > current)
    .sort((a, b) => a.arrival_seconds - b.arrival_seconds)
    .slice(0, 2)
    .map((value) => ({ bus_number: value.bus_number, remain_time: Math.floor(value.arrival_seconds - current) }));
  return { bus_type: type, now_bus: remaining[0] ?? null, next_bus: remaining[1] ?? null };
}

async function routeSchedule(
  db: Database,
  type: string,
  depart: Station,
  arrival: Station,
  date: string,
): Promise<Schedule[]> {
  if (depart === arrival) return [];
  const result: Schedule[] = [];
  if (type === 'shuttle' || type === 'all')
    result.push(...shuttleSchedule(await shuttleTables(db), date, depart, arrival));
  if ((type === 'express' || type === 'all') && depart !== 'STATION' && arrival !== 'STATION') {
    result.push(
      ...expressRouteTimes[depart].map((depart_time) => ({ bus_type: 'express', bus_name: '대성티엔이', depart_time })),
    );
  }
  if ((type === 'city' || type === 'all') && !(depart === 'STATION' && arrival === 'TERMINAL')) {
    const tables = await cityTables(db);
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    const dayOfWeek = weekend ? '주말' : '평일';
    for (const [number, origin] of CITY_BUS_ORIGINS) {
      const departNode = depart === 'KOREATECH' ? origin : TERMINAL_NODE;
      const table = tables.find(
        (candidate) => Number(candidate.bus_info.number) === number && candidate.bus_info.depart_node === departNode,
      );
      if (!table) throw new ApiError(404, 'NOT_FOUND', '버스 캐시가 존재하지 않습니다.');
      for (const group of table.bus_timetables) {
        if (group.day_of_week !== dayOfWeek) continue;
        for (const value of group.depart_info)
          result.push({
            bus_type: 'city',
            bus_name: String(number),
            depart_time: addMinutes(value, cityOffset(number, depart)),
          });
      }
    }
  }
  return result;
}

function publicShuttle(table: Shuttle) {
  return {
    id: table.id,
    region: regions[table.region],
    route_type: routeTypes[table.route_type],
    route_name: table.route_name,
    sub_name: table.sub_name,
    node_info: table.node_info,
    route_info: table.route_info.map((route) => ({
      name: route.name,
      detail: route.detail,
      arrival_time: route.arrival_time,
    })),
  };
}

/** 노선표가 등·하교 중 어느 방향인지. 노선 유형마다 방향이 적힌 위치가 다르다. */
function routeDirection(table: Shuttle, route: Shuttle['route_info'][number]): 'to' | 'from' {
  if (table.route_type === 'WEEKDAYS') return route.name === '하교' ? 'from' : 'to';
  if (table.route_type === 'WEEKEND') return route.detail === '하교' ? 'from' : 'to';
  return route.arrival_time[0] == null ? 'to' : 'from';
}

async function shuttleTimetablesV2(db: Database, type: string, direction: string, region: string): Promise<unknown[]> {
  const regionKey = (Object.keys(regions) as (keyof typeof regions)[]).find((key) => regions[key].includes(region));
  if (!regionKey) invalid('버스 지역 구분이 잘못되었습니다.');
  const tables = await shuttleTables(db);
  const typeOrder = Object.keys(routeTypes);
  tables.sort((a, b) => typeOrder.indexOf(a.route_type) - typeOrder.indexOf(b.route_type));
  return tables
    .filter(
      (table) =>
        table.region === regionKey &&
        (type === 'commuting' ? table.route_type === 'WEEKDAYS' : table.route_type !== 'WEEKDAYS'),
    )
    .flatMap((table) =>
      table.route_info.flatMap((route) => {
        if (routeDirection(table, route) !== direction) return [];
        const nodes = table.node_info.map((node, index) => ({
          node_name: node.name,
          arrival_time: route.arrival_time[index] ?? null,
        }));
        if (direction === 'from' && table.route_type !== 'SHUTTLE') nodes.reverse();
        return [{ route_name: table.route_name, arrival_nodes: nodes }];
      }),
    );
}

function withSeconds(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

export function registerTransport(app: Hono<ApiEnv>): void {
  app.get('/weather', async (c) => c.json(await getWeather(c.get('db'), c.env)));
  app.get('/bus', async (c) =>
    c.json(
      await getBusRemainTime(
        c.get('db'),
        c.env,
        required(c, 'bus_type'),
        required(c, 'depart'),
        required(c, 'arrival'),
      ),
    ),
  );
  app.get('/bus/notice', async (c) => {
    const notice = await cacheRead<{ id: number; title: string }>(c.get('db'), 'busNoticeArticle');
    return notice ? c.json(notice) : c.body(null, 200);
  });
  app.get('/bus/courses', (c) =>
    c.json([
      ...['천안', '청주', '서울', '대전', '세종'].flatMap((region) =>
        ['to', 'from'].map((direction) => ({ bus_type: 'commuting', direction, region })),
      ),
      ...['천안', '청주'].flatMap((region) =>
        ['to', 'from'].map((direction) => ({ bus_type: 'shuttle', direction, region })),
      ),
    ]),
  );
  app.get('/bus/courses/shuttle', async (c) => {
    const db = c.get('db');
    const current = await version(db, 'shuttle_bus_timetable');
    const tables = await shuttleTables(db);
    const regionKeys = Object.keys(regions) as (keyof typeof regions)[];
    const types = Object.keys(routeTypes);
    const terms = current.content?.split('~');
    if (!terms || terms.length < 2)
      throw new ApiError(500, 'INTERNAL_SERVER_ERROR', '셔틀버스 운영 기간이 올바르지 않습니다.');
    const route_regions = regionKeys.flatMap((region) => {
      const routes = tables
        .filter((table) => table.region === region)
        .sort((a, b) => types.indexOf(a.route_type) - types.indexOf(b.route_type));
      if (!routes.length) return [];
      return [
        {
          region: regions[region],
          routes: routes.map((table) => ({
            id: table.id,
            type: routeTypes[table.route_type],
            route_name: table.route_name,
            sub_name: table.sub_name,
          })),
        },
      ];
    });
    return c.json({
      route_regions,
      semester_info: { name: current.title, from: terms[0]!.trim(), to: terms[1]!.trim() },
    });
  });
  app.get('/bus/timetable/shuttle/:id', async (c) => {
    const row = await c
      .get('db')
      .get<Omit<Shuttle, 'node_info' | 'route_info'> & { node_info: string; route_info: string }>(
        sql`SELECT * FROM shuttlebus_timetables WHERE id=${c.req.param('id')}`,
      );
    if (!row) throw new ApiError(404, 'NOT_FOUND', '버스가 존재하지 않습니다.');
    return c.json(
      publicShuttle({ ...row, node_info: JSON.parse(row.node_info), route_info: JSON.parse(row.route_info) }),
    );
  });
  app.get('/bus/timetable/city', async (c) => {
    const number = Number(required(c, 'bus_number'));
    const direction = required(c, 'direction');
    if (!Number.isSafeInteger(number)) invalid();
    if (!CITY_DIRECTIONS.includes(direction)) throw new ApiError(404, 'NOT_FOUND', '버스 타입이 존재하지 않습니다.');
    const table = (await cityTables(c.get('db'))).find(
      (candidate) => Number(candidate.bus_info.number) === number && candidate.bus_info.arrival_node === direction,
    );
    if (!table) throw new ApiError(404, 'NOT_FOUND', '버스 캐시가 존재하지 않습니다.');
    const toTerminal = direction === TERMINAL_NODE;
    return c.json({
      updated_at: table.updated_at,
      bus_info: {
        number,
        depart_node: toTerminal ? '코리아텍' : '천안 터미널',
        arrival_node: toTerminal ? '천안 터미널' : '코리아텍',
      },
      bus_timetables: table.bus_timetables.map((group) => ({
        day_of_week: group.day_of_week,
        depart_info: group.depart_info.map((value) =>
          addMinutes(value, toTerminal ? cityOffset(number, 'KOREATECH') : 0),
        ),
      })),
    });
  });
  app.get('/bus/timetable/v2', async (c) => {
    const type = busType(required(c, 'bus_type'));
    const direction = required(c, 'direction');
    const region = required(c, 'region');
    const db = c.get('db');
    if (type === 'city') throw new ApiError(400, 'INVALID_REQUEST_BODY', '해당 버스타입에는 지원하지 않는 기능입니다.');
    if (!['to', 'from'].includes(direction))
      throw new ApiError(400, 'INVALID_REQUEST_BODY', '정상적인 버스 방향이 아닙니다.');
    let timetables: unknown[];
    if (type === 'express') {
      const key = direction === 'from' ? 'koreatech:terminal' : 'terminal:koreatech';
      const cached = await cacheRead<ExpressArrival[]>(db, `expressBus:${key}`);
      if (!cached) throw new ApiError(404, 'NOT_FOUND', '버스 캐시가 존재하지 않습니다.');
      timetables = cached.map((value) => ({ departure: value.depart, arrival: value.arrival, charge: value.charge }));
    } else {
      timetables = await shuttleTimetablesV2(db, type, direction, region);
    }
    const current = await version(db, `${type === 'commuting' ? 'shuttle' : type}_bus_timetable`);
    return c.json({
      bus_timetables: timetables,
      updated_at: kst(Date.parse(`${current.updated_at.replace(' ', 'T')}Z`))
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),
    });
  });
  app.get('/bus/search', async (c) => {
    const { date, seconds } = queryDateTime(c);
    const depart = station(required(c, 'depart'));
    const arrival = station(required(c, 'arrival'));
    rejectDuplicate(depart, arrival);
    const db = c.get('db');
    const result: { bus_name: string; bus_time: string | null }[] = [];
    const express = await cacheRead<ExpressArrival[]>(
      db,
      `expressBus:${depart.toLowerCase()}:${arrival.toLowerCase()}`,
    );
    if (express?.length) {
      const next = express
        .map((value) => value.depart)
        .filter((time) => localSeconds(time) > seconds)
        .sort()[0];
      result.push({ bus_name: 'express', bus_time: next?.slice(0, 5) ?? null });
    }
    const tables = await shuttleTables(db);
    for (const type of ['shuttle', 'commuting']) {
      const next = shuttleSchedule(tables, date, depart, arrival, type)
        .map((schedule) => schedule.depart_time)
        .filter((time) => localSeconds(time) > seconds)
        .sort()[0];
      result.push({ bus_name: type, bus_time: next ?? null });
    }
    return c.json(result);
  });
  app.get('/bus/route', async (c) => {
    const query = queryDateTime(c);
    const depart = station(required(c, 'depart'));
    const arrival = station(required(c, 'arrival'));
    const type = busType(required(c, 'bus_type'), true);
    const priority = ['shuttle', 'express', 'city'];
    const schedule = (await routeSchedule(c.get('db'), type, depart, arrival, query.date))
      .filter((entry) => localSeconds(entry.depart_time) > query.seconds)
      .sort(
        (a, b) =>
          localSeconds(a.depart_time) - localSeconds(b.depart_time) ||
          priority.indexOf(a.bus_type) - priority.indexOf(b.bus_type),
      );
    return c.json({
      depart,
      arrival,
      depart_date: query.date,
      depart_time: withSeconds(query.time),
      schedule: schedule.map((entry) => ({ ...entry, depart_time: withSeconds(entry.depart_time) })),
    });
  });
  app.post('/admin/bus/shuttle/timetable/excel', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const form = await c.req.formData();
    const file = form.get('shuttle-bus-timetable');
    if (!(file instanceof File)) invalid('엑셀 파일이 비어 있습니다.');
    return c.json(parseShuttleWorkbook(new Uint8Array(await file.arrayBuffer())));
  });
  app.post('/admin/bus/commuting/timetable/excel', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const form = await c.req.formData();
    const file = form.get('commuting-bus-timetable');
    if (!(file instanceof File)) invalid('엑셀 파일이 비어 있습니다.');
    return c.json(parseCommutingWorkbook(new Uint8Array(await file.arrayBuffer())));
  });
  app.put('/admin/bus/shuttle/timetable', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const mode = c.req.query('update_mode') ?? 'PARTIAL';
    if (!['PARTIAL', 'REPLACE'].includes(mode)) invalid();
    await updateTimetables(c.get('db'), await c.req.json(), required(c, 'semester_type'), false, mode === 'REPLACE');
    return c.body(null, 200);
  });
  app.put('/admin/bus/commuting/timetable', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    await updateTimetables(c.get('db'), await c.req.json(), required(c, 'semester_type'), true, false);
    return c.body(null, 200);
  });
}
