import { ApiError } from '@api/errors';
import type { Database } from '@api/db/client';
import type { Bindings } from '@api/runtime';
import { kst } from '@api/domains/transport/algorithms';
import { cacheRead, cacheWrite } from '@api/domains/transport/store';

const skyConditions: Record<string, number> = { '1': 1, '3': 2, '4': 3 };
const precipitationConditions: Record<string, number> = { '1': 4, '2': 5, '3': 6, '4': 7 };
const names = ['맑음', '구름많음', '흐림', '비', '비/눈', '눈', '소나기'];
const icons = [
  'sun-03',
  'sun-cloud-02',
  'cloud',
  'cloud-angled-rain',
  'cloud-hail',
  'cloud-mid-snow',
  'cloud-rain-wind',
];
export interface Weather {
  temperature: number;
  weather: string;
  weather_id: number;
  weather_icon_url: string;
}
export function forecastRequest(now: number) {
  const forecast = kst(now);
  forecast.setUTCMinutes(0, 0, 0);
  const available = kst(now - 600000);
  let hour = [2, 5, 8, 11, 14, 17, 20, 23].filter((h) => h <= available.getUTCHours()).pop();
  if (hour === undefined) {
    available.setUTCDate(available.getUTCDate() - 1);
    hour = 23;
  }
  available.setUTCHours(hour, 0, 0, 0);
  return { base: available, forecast };
}
export function forecastKey(value: Date) {
  return value.toISOString().replace(/[-:T]/g, '').slice(0, 12);
}
export function weatherCondition(temperature: number, sky: string, precipitation: string): Weather {
  const id = precipitation !== '0' ? (precipitationConditions[precipitation] ?? 4) : (skyConditions[sky] ?? 3);
  return {
    temperature,
    weather: names[id - 1]!,
    weather_id: id,
    weather_icon_url: `https://static.koreatech.in/upload/WEATHER/${icons[id - 1]}.webp`,
  };
}
class WeatherFailure extends ApiError {
  constructor(
    readonly detail: string,
    readonly rateLimit = false,
  ) {
    super(500, 'EXTERNAL_API_ERROR', '기상청 단기예보 API 응답이 정상적이지 않습니다.');
  }
}
interface ForecastItem {
  fcstDate: string;
  fcstTime: string;
  category: string;
  fcstValue: string;
}
export function mapForecast(items: ForecastItem[], start: Date): Record<string, Weather> {
  const startKey = forecastKey(start);
  const endKey = forecastKey(new Date(start.getTime() + 86400000));
  const groups = new Map<string, Record<string, string>>();
  for (const item of items) {
    const key = item.fcstDate + item.fcstTime;
    if (key < startKey || key >= endKey) continue;
    const group = groups.get(key) ?? {};
    group[item.category] = item.fcstValue;
    groups.set(key, group);
  }
  if (!groups.has(startKey)) throw new WeatherFailure(`forecastDateTime: ${startKey}`);
  const result: Record<string, Weather> = {};
  for (const [key, g] of groups) {
    for (const category of ['TMP', 'SKY', 'PTY'])
      if (!g[category]?.trim()) throw new WeatherFailure(`missing category: ${category}`);
    if (!/^[+-]?\d+$/.test(g.TMP!)) throw new WeatherFailure('invalid category: TMP');
    result[key] = weatherCondition(Number(g.TMP), g.SKY!, g.PTY!);
  }
  return result;
}
async function fetchForecast(env: Bindings, base: Date, forecast: Date) {
  if (!env.OPEN_API_KEY_PUBLIC) throw new ApiError(503, 'CONFIGURATION_ERROR', 'OPEN_API_KEY_PUBLIC is required.');
  const key = forecastKey(base);
  const url = new URL('https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst');
  url.search = new URLSearchParams({
    serviceKey: env.OPEN_API_KEY_PUBLIC,
    numOfRows: '1000',
    pageNo: '1',
    dataType: 'JSON',
    base_date: key.slice(0, 8),
    base_time: key.slice(8),
    nx: '66',
    ny: '109',
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: '*/*' } });
  } catch {
    throw new WeatherFailure('network error');
  }
  const text = await response.text();
  if (
    response.status === 429 ||
    /API RATE LIMIT EXCEEDED|LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR/i.test(text)
  )
    throw new WeatherFailure('rate limit', true);
  if (!text.trim()) throw new WeatherFailure('response body is empty');
  if (!text.trim().startsWith('{')) throw new WeatherFailure(text);
  let data: {
    response?: { header?: { resultCode: string; resultMsg: string }; body?: { items?: { item?: ForecastItem[] } } };
  };
  try {
    data = JSON.parse(text);
  } catch {
    throw new WeatherFailure('invalid JSON response');
  }
  const result = data.response;
  if (!result?.header || !result.body?.items?.item) throw new WeatherFailure('response body is empty');
  if (!['00', '0'].includes(result.header.resultCode)) throw new WeatherFailure(result.header.resultMsg);
  return mapForecast(result.body.items.item, forecast);
}
/**
 * 기상청이 아직 해당 발표 시각 자료를 내지 않았으면(NO_DATA 등) 세 시간 전 발표분으로 한 번 물러난다.
 * 호출 제한에 걸리면 5초 간격으로 최대 여섯 번 시도한다.
 */
export async function refreshWeather(db: Database, env: Bindings, now: number) {
  const request = forecastRequest(now);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      let map;
      try {
        map = await fetchForecast(env, request.base, request.forecast);
      } catch (error) {
        if (
          !(error instanceof WeatherFailure) ||
          error.rateLimit ||
          !/NO_DATA|response body is empty|forecastDateTime/.test(error.detail)
        )
          throw error;
        map = await fetchForecast(env, new Date(request.base.getTime() - 10800000), request.forecast);
      }
      await cacheWrite(db, 'Weather:byeongcheon', map, 86400000, now);
      return;
    } catch (error) {
      if (!(error instanceof WeatherFailure) || !error.rateLimit || attempt === 5) throw error;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 5000);
      await promise;
    }
  }
}
export async function getWeather(db: Database, now = Date.now()) {
  const hourly = await cacheRead<Record<string, Weather>>(db, 'Weather:byeongcheon', now);
  const hour = kst(now);
  hour.setUTCMinutes(0, 0, 0);
  const result = hourly?.[forecastKey(hour)];
  if (!result) throw new WeatherFailure('weather cache is empty');
  return result;
}
