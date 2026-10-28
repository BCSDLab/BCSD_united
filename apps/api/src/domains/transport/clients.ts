import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';
import { calendar, clockSeconds, expressCacheTimes, kst, minutes, time, type Station } from '@api/domains/transport/algorithms';
import { cacheWrite } from '@api/domains/transport/store';
import { refreshWeather } from '@api/domains/transport/weather';

export const stationNodes: Record<Station, {NORTH: string[]; SOUTH: string[]}> = {
  KOREATECH:{NORTH:['CAB285000406'],SOUTH:['CAB285000405']},
  STATION:{NORTH:['CAB285000655'],SOUTH:['CAB285000656']},
  TERMINAL:{NORTH:['CAB285000686'],SOUTH:['CAB285000685','CAB285010125']},
};
export interface CityArrival { bus_number: number; arrival_seconds: number }
export interface ExpressArrival { depart: string; arrival: string; charge: number }
interface PublicResult<T> { response: {header: {resultCode:string};body:{totalCount:number;items:{item:T[] | T}}} }
async function publicItems<T>(env: Bindings, endpoint: string, params: Record<string,string>): Promise<T[]> {
  if (!env.OPEN_API_KEY_PUBLIC) throw new ApiError(503,'CONFIGURATION_ERROR','OPEN_API_KEY_PUBLIC is required.');
  const url = new URL(`https://apis.data.go.kr/1613000/${endpoint}`);
  url.search = new URLSearchParams({serviceKey:env.OPEN_API_KEY_PUBLIC,_type:'json',...params}).toString();
  try {
    const response = await fetch(url,{headers:{Accept:'*/*','Content-Type':'application/json'}});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as PublicResult<T>;
    if (data.response.header.resultCode !== '00' || data.response.body.totalCount === 0) return [];
    const item = data.response.body.items.item; return Array.isArray(item) ? item : [item];
  } catch { throw new ApiError(500,'EXTERNAL_API_ERROR','버스 Open API 응답이 정상적이지 않습니다.'); }
}
async function updateVersion(db: Database, type: string, now: number) {
  const stamp = new Date(now).toISOString().slice(0,19).replace('T',' ');
  await db.run(sql`UPDATE versions SET version=${`${kst(now).getUTCFullYear()}0_${Math.floor(now/1000)}`},updated_at=${stamp} WHERE type=${type}`);
}
export async function refreshCity(db: Database, env: Bindings, now: number) {
  const nodes = Object.values(stationNodes).flatMap(n => [...n.NORTH,...n.SOUTH]);
  const errors: unknown[] = [];
  for (const node of nodes) {
    try {
      const arrivals = await publicItems<{nodeid:string;arrtime:number;routeno:number}>(env,'ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList',{numOfRows:'30',cityCode:'34010',nodeId:node});
      if (arrivals.length) await cacheWrite(db,`CityBus:${arrivals[0]!.nodeid}`,arrivals.map(a => ({bus_number:Number(a.routeno),arrival_seconds:(clockSeconds(now)+Number(a.arrtime))%86400})),300000,now);
    } catch (error) { errors.push(error); }
  }
  await updateVersion(db,'city_bus_timetable',now);
  for (const node of nodes) {
    try {
      const routes = await publicItems<{routeno:number}>(env,'BusSttnInfoInqireService/getSttnThrghRouteList',{numOfRows:'50',cityCode:'34010',nodeid:node});
      await cacheWrite(db,`CityBusRoute:${node}`,[...new Set(routes.map(r => Number(r.routeno)))],300000,now);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors,'City bus cache refresh failed for one or more stops.');
}
async function refreshExpressProvider(db: Database, env: Bindings, now: number, provider: 'static' | 'public' | 'tmoney') {
  const ids = { KOREATECH: '3125301', TERMINAL: '3112001' };
  for (const depart of ['KOREATECH', 'TERMINAL'] as const) {
    const arrival = depart === 'KOREATECH' ? 'TERMINAL' : 'KOREATECH';
    let values: ExpressArrival[];
    if (provider === 'static') {
      values = expressCacheTimes[depart].map((departTime) => ({ depart: departTime, arrival: time(minutes(departTime)! + (depart === 'KOREATECH' ? 20 : 33)), charge: 1900 }));
    } else if (provider === 'public') {
      const items = await publicItems<{ depPlandTime: string; arrPlandTime: string; charge: number }>(env, 'SuburbsBusInfoService/getStrtpntAlocFndSuberbsBusInfo', {
        numOfRows: '30',
        depTerminalId: `NAI${ids[depart]}`,
        arrTerminalId: `NAI${ids[arrival]}`,
        depPlandTime: calendar(now).replaceAll('-', ''),
      });
      // 시각은 `YYYYMMDDHHmm` 형식이다.
      values = items.map((item) => ({
        depart: `${String(item.depPlandTime).slice(8, 10)}:${String(item.depPlandTime).slice(10, 12)}`,
        arrival: `${String(item.arrPlandTime).slice(8, 10)}:${String(item.arrPlandTime).slice(10, 12)}`,
        charge: item.charge,
      }));
    } else {
      if (!env.OPEN_API_KEY_TMONEY) throw new ApiError(503, 'CONFIGURATION_ERROR', 'OPEN_API_KEY_TMONEY is required for express API fallback.');
      const url = `https://apigw.tmoney.co.kr:5556/gateway/xzzIbtListGet/v1/ibt_list/${calendar(now).replaceAll('-', '')}/0000/${ids[depart]}/${ids[arrival]}/9/0`;
      const response = await fetch(url, { headers: { 'x-Gateway-APIKey': env.OPEN_API_KEY_TMONEY, Accept: '*/*', 'Content-Type': 'application/json' } });
      if (!response.ok) throw new ApiError(500, 'EXTERNAL_API_ERROR', '버스 Open API 응답이 정상적이지 않습니다.');
      const data = await response.json() as { code: string; response: { LINE_LIST: { TIM_TIM_O: string; LIN_TIM: number }[] } };
      values = data.code !== '00000' ? [] : data.response.LINE_LIST.map((line) => {
        const departTime = `${line.TIM_TIM_O.slice(0, 2)}:${line.TIM_TIM_O.slice(2)}`;
        return { depart: departTime, arrival: time(minutes(departTime)! + line.LIN_TIM), charge: 1900 };
      });
    }
    if (values.length) await cacheWrite(db, `expressBus:${depart.toLowerCase()}:${arrival.toLowerCase()}`, values, 172800000, now);
  }
  await updateVersion(db, 'express_bus_timetable', now);
}
/** 제공자를 순서대로 시도해 하나라도 성공하면 끝낸다. 모두 실패해야 오류다. */
export async function refreshExpress(db: Database, env: Bindings, now: number) {
  const errors: unknown[] = [];
  for (const provider of ['static', 'public', 'tmoney'] as const) {
    try {
      await refreshExpressProvider(db, env, now, provider);
      return;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, '호출할 수 있는 버스 API가 없습니다.');
}
export async function runTransportCron(env: Bindings, scheduledTime: number) {
  const date = kst(scheduledTime);
  if (date.getUTCMinutes() % 5 !== 0) return;
  const db = createDatabase(env.DB);
  const work: Promise<unknown>[] = [refreshCity(db,env,scheduledTime)];
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 30) work.push(refreshExpress(db,env,scheduledTime));
  if (date.getUTCMinutes() === 0) work.push(refreshWeather(db,env,scheduledTime));
  const results = await Promise.allSettled(work); const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
  if (errors.length) throw new AggregateError(errors,'Transport scheduled refresh failed.');
}
