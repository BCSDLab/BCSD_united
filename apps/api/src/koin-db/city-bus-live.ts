import { cityBusKey, DIRECTIONS, snapshot } from '@api/koin-db/city-bus';
import { tago, type TagoArrival, type TagoLocation } from '@api/koin-db/city-bus-tago';

/** Java BusStation 선언 순서. 출발 순번 < 도착 순번이면 SOUTH(하교), 아니면 NORTH(등교)다. */
export const STATIONS = ['KOREATECH', 'STATION', 'TERMINAL'] as const;
export type Station = (typeof STATIONS)[number];
export type Direction = 'NORTH' | 'SOUTH';
/** Java BusStationNode(국토교통부 정류소 ID). */
export const STATION_NODES: Readonly<Record<Station, Readonly<Record<Direction, readonly string[]>>>> = {
  KOREATECH: { NORTH: ['CAB285000406'], SOUTH: ['CAB285000405'] },
  STATION: { NORTH: ['CAB285000655'], SOUTH: ['CAB285000656'] },
  TERMINAL: { NORTH: ['CAB285000686'], SOUTH: ['CAB285000685', 'CAB285010125'] },
};
export const NODE_IDS = STATIONS.flatMap((station) => [
  ...STATION_NODES[station].NORTH,
  ...STATION_NODES[station].SOUTH,
]);
/** Java CityBusRouteClient.AVAILABLE_CITY_BUS: 경유 노선 정보가 없을 때의 기본값이자 위치 추적 대상. */
export const TRACKED_BUS_NUMBERS: readonly number[] = [400, 402, 405];

/**
 * 도착 이력 수집 방식(CITY_BUS_TRACKING, 기본 location). 모두 운행 시간에만 TAGO를 1분마다 조회한다.
 * - off: 실시간은 도착 API 요청 시 조회(캐시)만, 이력 없음.
 * - arrival: 7개 정류소 도착 API로 캐시를 채우고, 추적 번호의 가장 가까운 버스가 사라지면 도착으로 기록(추정값).
 * - location: 추적 노선 위치 API로 차량이 정류소에 도달한 시각을 기록하고 도착 예정도 추정한다.
 *   위치·노선 API가 실패(미승인 403 등)하면 30분간 arrival 방식으로 대신 수집한다.
 */
export type TrackingMode = 'off' | 'arrival' | 'location';
export const trackingMode = (value: string | undefined): TrackingMode =>
  value === 'off' || value === 'arrival' ? value : 'location';

export interface LiveArrival {
  busNumber: number;
  /** 도착 예정 시각(epoch ms). */
  arrivalAt: number;
}
export interface HistoryQuery {
  nodes: string[];
  busNumber: number | null;
  weeks: number;
  now: number;
}
export interface HistoryDay {
  date: string;
  arrivals: { bus_number: number; arrival_time: string; estimated: boolean }[];
}

type Sql = Pick<SqlStorage, 'exec'>;
type Transaction = <T>(operation: () => T) => T;
type CachedArrivals = { at: number; entries: (LiveArrival & { routeId: string; remaining: number | null })[] | null };

interface Routes {
  /** 경유 노선을 마지막으로 모두 받은 KST 날짜. 다르면 하루 한 번 다시 받는다. */
  date: string | null;
  /** 정류소 → 경유 버스 번호(Java CityBusRouteCache). */
  nodeRoutes: Record<string, number[]>;
  /** 추적 번호(400·402·405)의 TAGO 노선 ID → 버스 번호. */
  tracked: Record<string, number>;
  /** 추적 노선 ID → 정류소 → 노선 내 순번(location 방식만 사용). */
  stops: Record<string, Record<string, number[]>>;
  /** 운행 시간(KST 자정 기준 분). end는 1440을 넘을 수 있다. */
  window: { start: number; end: number };
}
interface Vehicle {
  ord: number;
  at: number;
  /** [순번, 그 순번에서 처음 관측한 시각]. */
  trail: [number, number][];
}
type Vehicles = Record<string, { polledAt: number; vehicles: Record<string, Vehicle> }>;
/** 정류소 → 노선 ID → 직전 조회의 가장 가까운 버스. */
type Approaching = Record<
  string,
  { at: number; routes: Record<string, { number: number; arrtime: number; remaining: number }> }
>;

const MINUTE = 60_000;
const DAY = 86_400_000;
const KST_OFFSET = 9 * 3_600_000;
const ARRIVAL_CACHE_MS = 60_000;
const FAILURE_CACHE_MS = 30_000;
const RETRY_MS = 30 * MINUTE;
const MIN_POLL_GAP_MS = 40_000;
const POLL_FRESH_MS = 150_000;
const VEHICLE_EXPIRE_MS = 10 * MINUTE;
const HISTORY_RETENTION_MS = 56 * DAY;
const SAMPLE_RETENTION_MS = 14 * DAY;
const MAX_STOPS_AHEAD = 40;
const MAX_ESTIMATE_MS = 2 * 3_600_000;
const MIN_SAMPLES = 3;
/** 시간표가 없을 때 운행 시간: 05:00 ~ 익일 00:30. */
const DEFAULT_WINDOW = { start: 300, end: 1470 };
/** 첫 기점 출발 15분 전부터 마지막 기점 출발 2시간 뒤(종점 도착 여유)까지 수집한다. */
const WINDOW_BEFORE = 15;
const WINDOW_AFTER = 120;
/** 도착 API의 가장 가까운 버스가 이 이내(남은 정류소·초)였다가 사라지면 정류소에 도착한 것으로 본다. */
const PASS_MAX_REMAINING = 2;
const PASS_MAX_SECONDS = 300;
const PASS_DEDUPE_MS = 3 * MINUTE;

const schema = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // 정류소 도착 이력(8주 보관). estimated=1은 조회 사이 보간·예정 시각 추정값이다.
  `CREATE TABLE IF NOT EXISTS arrivals (node_id TEXT NOT NULL, arrived_at INTEGER NOT NULL, route_id TEXT NOT NULL,
    bus_number INTEGER NOT NULL, vehicle_no TEXT NOT NULL, estimated INTEGER NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (node_id, arrived_at, route_id)) WITHOUT ROWID`,
  // location 방식 도착 예정 학습값: from_ord에서 처음 관측된 뒤 node 도착까지 걸린 초.
  `CREATE TABLE IF NOT EXISTS samples (route_id TEXT NOT NULL, node_id TEXT NOT NULL, from_ord INTEGER NOT NULL,
    observed_at INTEGER NOT NULL, seconds INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS samples_lookup ON samples (route_id, node_id, from_ord, observed_at)',
];

function kst(ms: number) {
  const date = new Date(ms + KST_OFFSET);
  return {
    date: date.toISOString().slice(0, 10),
    time: date.toISOString().slice(11, 19),
    minute: date.getUTCHours() * 60 + date.getUTCMinutes(),
  };
}

export function inWindow(window: Routes['window'], now: number): boolean {
  const { minute } = kst(now);
  return (minute >= window.start && minute <= window.end) || minute + 1440 <= window.end;
}

const busNumber = (value: string): number | null => (/^\d{1,9}$/.test(value) ? Number(value) : null);

/**
 * 천안 시내버스 실시간·도착 이력 원본(CityBusDurableObject 하나). DO SQLite와 메모리 캐시만 쓴다.
 * TAGO 키가 없거나 응답이 실패하면 remain은 null을 돌려 Java가 응답하게 한다.
 */
export class CityBusLive {
  private readonly cache = new Map<string, CachedArrivals>();
  private readonly pending = new Map<string, Promise<CachedArrivals>>();

  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction,
    private readonly options: { key?: string; kv?: KVNamespace; mode: TrackingMode },
  ) {
    for (const statement of schema) sql.exec(statement);
  }

  private meta<T>(key: string): T | null {
    const [row] = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray();
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private setMeta(key: string, value: unknown): void {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }

  routes(): Routes | null {
    return this.meta<Routes>('routes');
  }

  /** cron 1분마다. 경유 노선은 하루 한 번, 수집은 운행 시간에만 한다. */
  async tick(now: number): Promise<void> {
    await this.refreshRoutes(now);
    const routes = this.routes();
    const mode = this.options.mode;
    if (!routes || mode === 'off' || !this.options.key) return;
    if (!inWindow(routes.window, now)) {
      // 운행 시간 밖: 다음 운행의 첫 관측을 이전 운행과 잇지 않는다.
      this.transaction(() => {
        this.setMeta('vehicles', {});
        this.setMeta('approaching', {});
      });
      return;
    }
    const last = this.meta<number>('polled_at');
    if (last !== null && now - last < MIN_POLL_GAP_MS && now >= last) return;
    this.setMeta('polled_at', now);
    const locationRetry = this.meta<number>('location_retry_at');
    if (mode === 'location' && (locationRetry === null || now >= locationRetry)) {
      if (await this.pollLocations(routes, now)) return;
      this.setMeta('location_retry_at', now + RETRY_MS);
    }
    await this.pollArrivals(now);
  }

  private async refreshRoutes(now: number): Promise<void> {
    const today = kst(now).date;
    const current = this.routes();
    const attempted = this.meta<number>('routes_attempt_at');
    if (current?.date === today || !this.options.key) return;
    if (attempted !== null && now - attempted < RETRY_MS && now >= attempted) return;
    this.setMeta('routes_attempt_at', now);
    const key = this.options.key;
    const results = await Promise.allSettled(NODE_IDS.map((node) => tago.throughRoutes(key, node)));
    const nodeRoutes: Record<string, number[]> = { ...current?.nodeRoutes };
    const found: Record<string, number> = {};
    let complete = true;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        complete = false;
        return;
      }
      const numbers = new Set<number>();
      for (const route of result.value) {
        const number = busNumber(route.routeno);
        if (number === null) continue;
        numbers.add(number);
        if (TRACKED_BUS_NUMBERS.includes(number)) found[route.routeid] = number;
      }
      nodeRoutes[NODE_IDS[index]!] = [...numbers].sort((a, b) => a - b);
    });
    // 하루치를 모두 받았으면 노선 ID를 새로 정하고, 일부 실패면 어제 것과 합친다.
    const tracked = complete ? found : { ...current?.tracked, ...found };
    const stops: Routes['stops'] = {};
    for (const routeId of Object.keys(tracked)) {
      const known = current?.stops[routeId];
      if (known) stops[routeId] = known;
    }
    if (this.options.mode === 'location') {
      const routeIds = Object.keys(tracked);
      const lists = await Promise.allSettled(routeIds.map((routeId) => tago.routeStops(key, routeId)));
      lists.forEach((list, index) => {
        if (list.status === 'rejected') return;
        const ords: Record<string, number[]> = {};
        for (const stop of list.value)
          if (NODE_IDS.includes(stop.nodeid)) (ords[stop.nodeid] ??= []).push(stop.nodeord);
        stops[routeIds[index]!] = ords;
      });
    }
    const window = await this.serviceWindow();
    this.transaction(() => {
      this.setMeta('routes', {
        date: complete ? today : (current?.date ?? null),
        nodeRoutes,
        tracked,
        stops,
        window,
      } satisfies Routes);
      this.sql.exec('DELETE FROM arrivals WHERE arrived_at < ?', now - HISTORY_RETENTION_MS);
      this.sql.exec('DELETE FROM samples WHERE observed_at < ?', now - SAMPLE_RETENTION_MS);
    });
  }

  /** BATCH_KV 시내버스 시간표(기점 출발 시각) 전체에서 운행 시간을 구한다. 공휴일 판단이 없으므로 모든 요일을 합친다. */
  private async serviceWindow(): Promise<Routes['window']> {
    const kv = this.options.kv;
    if (!kv) return DEFAULT_WINDOW;
    const keys = TRACKED_BUS_NUMBERS.flatMap((number) => Object.keys(DIRECTIONS).map((d) => cityBusKey(number, d)));
    const values = await Promise.allSettled(keys.map((key) => kv.get(key, 'json')));
    const minutes = values.flatMap((value) => {
      const parsed = value.status === 'fulfilled' ? snapshot.safeParse(value.value) : null;
      if (!parsed?.success) return [];
      return parsed.data.records.flatMap((record) =>
        record.departInfo.map((time) => {
          const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
          // 03시 전 출발은 전날 운행의 심야 차편이다.
          return minute < 180 ? minute + 1440 : minute;
        }),
      );
    });
    if (!minutes.length) return DEFAULT_WINDOW;
    return { start: Math.max(0, Math.min(...minutes) - WINDOW_BEFORE), end: Math.max(...minutes) + WINDOW_AFTER };
  }

  /** 정류소 도착 API(조회 시각 기준 예정 시각). 성공은 60초, 실패는 30초 캐시한다. 동시 요청은 한 번만 호출한다. */
  private arrivals(node: string, now: number): Promise<CachedArrivals> {
    const cached = this.cache.get(node);
    if (cached && now >= cached.at && now - cached.at < (cached.entries ? ARRIVAL_CACHE_MS : FAILURE_CACHE_MS)) {
      return Promise.resolve(cached);
    }
    let request = this.pending.get(node);
    if (!request) {
      request = this.fetchArrivals(node, now).finally(() => this.pending.delete(node));
      this.pending.set(node, request);
    }
    return request;
  }

  private async fetchArrivals(node: string, now: number): Promise<CachedArrivals> {
    let items: TagoArrival[] | null = null;
    if (this.options.key) {
      try {
        items = await tago.arrivals(this.options.key, node);
      } catch {
        items = null;
      }
    }
    const value: CachedArrivals = {
      at: now,
      entries:
        items?.flatMap((item) => {
          const number = busNumber(item.routeno);
          if (number === null || item.nodeid !== node) return [];
          return [
            {
              busNumber: number,
              routeId: item.routeid,
              arrivalAt: now + item.arrtime * 1000,
              remaining: item.arrprevstationcnt ?? null,
            },
          ];
        }) ?? null,
    };
    this.cache.set(node, value);
    return value;
  }

  private record(
    node: string,
    routeId: string,
    number: number,
    vehicle: string,
    at: number,
    estimated: boolean,
    source: string,
  ) {
    this.sql.exec(
      'INSERT OR IGNORE INTO arrivals (node_id, arrived_at, route_id, bus_number, vehicle_no, estimated, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      node,
      Math.round(at),
      routeId,
      number,
      vehicle,
      estimated ? 1 : 0,
      source,
    );
  }

  /**
   * 7개 정류소 도착 API. 노선별 가장 가까운 버스(남은 정류소 ≤2, ≤300초)가 다음 조회에서 사라지거나
   * 더 먼 버스(남은 정류소 증가)로 바뀌면 그 버스가 직전 예정 시각에 도착한 것으로 기록한다(차량 번호 없음, 추정값).
   */
  private async pollArrivals(now: number): Promise<void> {
    const results = await Promise.all(NODE_IDS.map((node) => this.fetchArrivals(node, now)));
    this.transaction(() => {
      const state = this.meta<Approaching>('approaching') ?? {};
      results.forEach((result, index) => {
        const node = NODE_IDS[index]!;
        if (!result.entries) return;
        const nearest: Approaching[string]['routes'] = {};
        for (const entry of result.entries) {
          if (!TRACKED_BUS_NUMBERS.includes(entry.busNumber)) continue;
          const seconds = Math.round((entry.arrivalAt - now) / 1000);
          const previous = nearest[entry.routeId];
          if (entry.remaining !== null && (!previous || seconds < previous.arrtime)) {
            nearest[entry.routeId] = { number: entry.busNumber, arrtime: seconds, remaining: entry.remaining };
          }
        }
        const before = state[node];
        if (before && now - before.at <= 3 * MINUTE) {
          for (const [routeId, bus] of Object.entries(before.routes)) {
            if (bus.remaining > PASS_MAX_REMAINING || bus.arrtime > PASS_MAX_SECONDS) continue;
            const next = nearest[routeId];
            if (next && next.remaining <= bus.remaining) continue;
            const at = Math.min(Math.max(before.at + bus.arrtime * 1000, before.at), now);
            const recent = this.sql
              .exec(
                'SELECT 1 FROM arrivals WHERE node_id = ? AND route_id = ? AND arrived_at > ?',
                node,
                routeId,
                at - PASS_DEDUPE_MS,
              )
              .toArray();
            if (!recent.length) this.record(node, routeId, bus.number, '', at, true, 'arrival');
          }
        }
        state[node] = { at: now, routes: nearest };
      });
      this.setMeta('approaching', state);
    });
  }

  /**
   * 추적 노선 위치 API. 차량 순번이 대상 정류소 순번에 닿거나 지나치면 도착으로 기록한다(지나친 경우 조회 사이 보간).
   * 모든 노선이 실패하면 false(위치 API 사용 불가).
   */
  private async pollLocations(routes: Routes, now: number): Promise<boolean> {
    const key = this.options.key!;
    const routeIds = Object.keys(routes.tracked);
    if (!routeIds.length) return false;
    const results = await Promise.allSettled(routeIds.map((routeId) => tago.busLocations(key, routeId)));
    if (results.every((result) => result.status === 'rejected')) return false;
    this.transaction(() => {
      const state = this.meta<Vehicles>('vehicles') ?? {};
      // 노선정보 API를 못 받았어도 차량이 대상 정류소에 있을 때 보고한 순번으로 정류소 순번을 익힌다.
      const latest = this.routes() ?? routes;
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const routeId = routeIds[index]!;
        const stops = (latest.stops[routeId] ??= {});
        for (const item of result.value) {
          if (!NODE_IDS.includes(item.nodeid)) continue;
          const ords = (stops[item.nodeid] ??= []);
          if (!ords.includes(item.nodeord)) ords.push(item.nodeord);
        }
        state[routeId] = this.track(routeId, latest, state[routeId]?.vehicles ?? {}, result.value, now);
      });
      this.setMeta('routes', latest);
      this.setMeta('vehicles', state);
    });
    return true;
  }

  private track(
    routeId: string,
    routes: Routes,
    vehicles: Record<string, Vehicle>,
    items: TagoLocation[],
    now: number,
  ): Vehicles[string] {
    const number = routes.tracked[routeId]!;
    const targets = Object.entries(routes.stops[routeId] ?? {}).flatMap(([node, ords]) =>
      ords.map((ord) => ({ node, ord })),
    );
    const next: Record<string, Vehicle> = {};
    for (const item of items) {
      const previous = vehicles[item.vehicleno];
      if (!previous || item.nodeord < previous.ord || now - previous.at > VEHICLE_EXPIRE_MS) {
        // 새 차량이거나 새 운행(순번 감소)이다. 이전 궤적과 잇지 않는다.
        next[item.vehicleno] = { ord: item.nodeord, at: now, trail: [[item.nodeord, now]] };
        continue;
      }
      if (item.nodeord > previous.ord) {
        for (const target of targets) {
          if (target.ord <= previous.ord || target.ord > item.nodeord) continue;
          const exact = target.ord === item.nodeord;
          const at = exact
            ? now
            : previous.at + ((now - previous.at) * (target.ord - previous.ord)) / (item.nodeord - previous.ord);
          this.record(target.node, routeId, number, item.vehicleno, at, !exact, 'location');
          for (const [ord, seen] of previous.trail) {
            const seconds = Math.round((at - seen) / 1000);
            if (ord >= target.ord || target.ord - ord > MAX_STOPS_AHEAD || seconds <= 0) continue;
            if (seconds * 1000 > MAX_ESTIMATE_MS) continue;
            this.sql.exec(
              'INSERT INTO samples (route_id, node_id, from_ord, observed_at, seconds) VALUES (?, ?, ?, ?, ?)',
              routeId,
              target.node,
              ord,
              now,
              seconds,
            );
          }
        }
        previous.trail.push([item.nodeord, now]);
        if (previous.trail.length > 60) previous.trail.splice(0, previous.trail.length - 60);
        previous.ord = item.nodeord;
      }
      previous.at = now;
      next[item.vehicleno] = previous;
    }
    return { polledAt: now, vehicles: next };
  }

  private median(routeId: string, node: string, ord: number): number | null {
    const rows = this.sql
      .exec<{ seconds: number }>(
        'SELECT seconds FROM samples WHERE route_id = ? AND node_id = ? AND from_ord = ? ORDER BY observed_at DESC LIMIT 15',
        routeId,
        node,
        ord,
      )
      .toArray()
      .map((row) => row.seconds)
      .sort((a, b) => a - b);
    return rows.length < MIN_SAMPLES ? null : rows[Math.floor(rows.length / 2)]!;
  }

  /**
   * location 방식 도착 예정. 정류소를 지나는 추적 노선이 모두 최근 조회됐고 접근 차량마다 학습값이 있을 때만
   * 해당 버스 번호를 책임진다. 아니면 null(도착 API로 대체).
   */
  private estimate(routes: Routes, node: string, now: number): { numbers: Set<number>; entries: LiveArrival[] } | null {
    const vehicles = this.meta<Vehicles>('vehicles') ?? {};
    const serving = Object.entries(routes.stops).filter(([routeId, stops]) => routes.tracked[routeId] && stops[node]);
    if (!serving.length) return null;
    const entries: LiveArrival[] = [];
    for (const [routeId, stops] of serving) {
      const route = vehicles[routeId];
      if (!route || now - route.polledAt > POLL_FRESH_MS || now < route.polledAt) return null;
      for (const target of stops[node]!) {
        for (const vehicle of Object.values(route.vehicles)) {
          if (vehicle.ord >= target || target - vehicle.ord > MAX_STOPS_AHEAD) continue;
          const seconds = this.median(routeId, node, vehicle.ord);
          if (seconds === null) return null;
          const seen = vehicle.trail[vehicle.trail.length - 1]![1];
          // 예정보다 늦은 차량은 곧 도착(30초)으로 둔다.
          const arrivalAt = Math.max(seen + seconds * 1000, now + 30_000);
          if (arrivalAt - now <= MAX_ESTIMATE_MS) entries.push({ busNumber: routes.tracked[routeId]!, arrivalAt });
        }
      }
    }
    return { numbers: new Set(serving.map(([routeId]) => routes.tracked[routeId]!)), entries };
  }

  /**
   * GET /bus 시내버스: 출발 정류소들의 도착 예정 중 출발·도착 정류소를 모두 지나는 번호만(Java CityBusService).
   * 운행 시간 밖에는 TAGO를 부르지 않고 빈 목록이다. 필요한 도착 API가 실패하면 null.
   */
  async remain(departNodes: string[], arrivalNodes: string[], now: number): Promise<LiveArrival[] | null> {
    const routes = this.routes();
    const numbersOf = (nodes: string[]) => {
      const numbers = new Set(nodes.flatMap((node) => routes?.nodeRoutes[node] ?? []));
      return numbers.size ? numbers : new Set(TRACKED_BUS_NUMBERS);
    };
    const arrival = numbersOf(arrivalNodes);
    const allowed = new Set([...numbersOf(departNodes)].filter((number) => arrival.has(number)));
    if (!inWindow(routes?.window ?? DEFAULT_WINDOW, now)) return [];
    const result: LiveArrival[] = [];
    for (const node of departNodes) {
      const located = this.options.mode === 'location' && routes ? this.estimate(routes, node, now) : null;
      const covered = located?.numbers ?? new Set<number>();
      if (located) result.push(...located.entries.filter((entry) => allowed.has(entry.busNumber)));
      if ([...allowed].every((number) => covered.has(number))) continue;
      const { entries } = await this.arrivals(node, now);
      if (!entries) return null;
      for (const entry of entries) {
        if (allowed.has(entry.busNumber) && !covered.has(entry.busNumber)) {
          result.push({ busNumber: entry.busNumber, arrivalAt: entry.arrivalAt });
        }
      }
    }
    return result;
  }

  /** 지난 `weeks`주 같은 요일, 현재 KST 시각 ±30분의 실제 도착 기록(최근 주부터). */
  history({ nodes, busNumber: number, weeks, now }: HistoryQuery): HistoryDay[] {
    const placeholders = nodes.map(() => '?').join(', ');
    const days: HistoryDay[] = [];
    for (let week = 1; week <= weeks; week += 1) {
      const center = now - week * 7 * DAY;
      const bindings: (string | number)[] = [...nodes, center - 30 * MINUTE, center + 30 * MINUTE];
      if (number !== null) bindings.push(number);
      const rows = this.sql
        .exec<{ bus_number: number; arrived_at: number; estimated: number }>(
          `SELECT bus_number, arrived_at, estimated FROM arrivals WHERE node_id IN (${placeholders})
            AND arrived_at BETWEEN ? AND ?${number === null ? '' : ' AND bus_number = ?'} ORDER BY arrived_at, bus_number`,
          ...bindings,
        )
        .toArray();
      days.push({
        date: kst(center).date,
        arrivals: rows.map((row) => ({
          bus_number: row.bus_number,
          arrival_time: kst(row.arrived_at).time,
          estimated: row.estimated === 1,
        })),
      });
    }
    return days;
  }
}
