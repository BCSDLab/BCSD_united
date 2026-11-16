import { captureError } from '@koin/telemetry/runtime';
import { Hono } from 'hono';
import { ApiError, errorResponse } from '@api/errors';
import { readCityBusTimetable } from '@api/koin-db/city-bus';
import { handleCityBusArrivalHistory, readCityBusRemainTime } from '@api/koin-db/city-bus-realtime';
import { handleCoopRoute } from '@api/koin-db/coop-api';
import { coopOwner } from '@api/koin-db/dining';
import { handleDiningImport, handleDiningLike, handleDinings } from '@api/koin-db/dining-api';
import { fetchOrigin } from '@api/koin-db/origin';
import type { Bindings } from '@api/runtime';

function withBackend(response: Response, backend: 'workers' | 'aws'): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Koin-Backend', backend);
  // 101 응답도 원본 WebSocket 연결과 헤더를 유지한다.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
}

// 허용 출처 목록(JSON 배열 또는 쉼표 구분)을 읽는다. 형식이 틀리면 설정 오류로 본다.
function parseOrigins(value: string | undefined): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = value.trim().startsWith('[') ? JSON.parse(value) : value.split(',');
  } catch {
    throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '허용 출처 설정이 올바르지 않습니다.');
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '허용 출처 설정이 올바르지 않습니다.');
  }
  return parsed.map((entry: string) => entry.trim());
}

// GATEWAY_CORS_ORIGINS는 보조 목록이라, 형식이 틀려도 식단 API 전체를 503으로 막지 않고 무시한다(해당 출처만 차단).
function parseExtraOrigins(value: string | undefined): string[] {
  try {
    return parseOrigins(value);
  } catch (error) {
    captureError(error);
    return [];
  }
}

// CORS 정책:
// - AUTH_ALLOWED_ORIGINS(웹 쿠키 세션 출처): Allow-Credentials: true. 쿠키 인증 경로는 Java가 Origin·CSRF를 다시 검증한다.
// - GATEWAY_CORS_ORIGINS(Bearer 토큰으로만 호출하는 자체 웹, 예: 영양사 웹): Allow-Credentials 없이 출처만 허용한다.
//   쿠키를 실어 보내는 요청의 응답은 이 출처의 스크립트가 읽지 못한다. 웹 쿠키 세션·CSRF 신뢰 출처에도 영향이 없다.
// Vary: Origin은 Origin이 없는 요청에도 붙인다. 공개 캐시 헤더가 있는 응답(예: 엑셀 내보내기)이 출처별로 섞이지 않게 한다.
function batchCors(response: Response, request: Request, env: Bindings): Response {
  response.headers.append('Vary', 'Origin');
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  const credentialed = parseOrigins(env.AUTH_ALLOWED_ORIGINS).includes(origin);
  if (credentialed || parseExtraOrigins(env.GATEWAY_CORS_ORIGINS).includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    if (credentialed) response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Access-Control-Expose-Headers', 'X-Koin-Backend');
  }
  return response;
}

// Workers가 만든 배치 응답에 CORS·no-store(응답이 캐시 정책을 정하지 않았을 때)·backend 표시를 붙인다.
function fromBatch(response: Response, request: Request, env: Bindings): Response {
  try {
    response = batchCors(response, request, env);
  } catch (error) {
    response = errorResponse(
      error instanceof ApiError
        ? error
        : new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '허용 출처 설정이 올바르지 않습니다.'),
    );
  }
  if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');
  return withBackend(response, 'workers');
}

// 식단(좋아요·품절·사진·품절 제보)과 시내버스(시간표·실시간·도착 이력)만 Workers가 처리한다. 나머지는 Java가 소유한다.
const gateway = new Hono<{ Bindings: Bindings }>();
gateway.all('*', async (c) => {
  const request = c.req.raw;
  const url = new URL(request.url);
  // 시내버스 시간표는 Java도 인증을 보지 않는 공개 API다. KV에 없거나 비정규 파라미터면 Java로 보낸다.
  if (request.method === 'GET' && url.pathname === '/bus/timetable/city') {
    const response = await readCityBusTimetable(c.env, url);
    if (response) return fromBatch(response, request, c.env);
  }
  // GET /bus 시내버스 남은 시간은 CITY_BUS DO(TAGO)가 답한다. 셔틀·통학·시외버스와 조회 실패는 Java로 보낸다.
  if (request.method === 'GET' && url.pathname === '/bus') {
    const response = await readCityBusRemainTime(c.env, url);
    if (response) return fromBatch(response, request, c.env);
  }
  if (request.method === 'GET' && url.pathname === '/bus/city/arrival-history') {
    return fromBatch(await handleCityBusArrivalHistory(c.env, url), request, c.env);
  }
  // 식단·좋아요 원본은 Durable Object다. 인증은 Java @UserId/@Auth 규칙을 따르고, 웹 쿠키 세션은 Java에 확인한다.
  // 품절·사진 소유권 전환 뒤에는 Java MySQL 값이 낡으므로 삐봇 서비스 토큰 조회도 Workers가 답한다.
  if (
    request.method === 'GET' &&
    url.pathname === '/dinings' &&
    (!request.headers.has('X-Koin-Service-Token') || coopOwner(c.env))
  ) {
    return fromBatch(await handleDinings(request, c.env, url), request, c.env);
  }
  if (request.method === 'PATCH' && (url.pathname === '/dining/like' || url.pathname === '/dining/like/cancel')) {
    const response = await handleDiningLike(request, c.env, url, url.pathname === '/dining/like');
    return fromBatch(response, request, c.env);
  }
  if (request.method === 'POST' && url.pathname === '/internal/workers/dining-likes/import') {
    return fromBatch(await handleDiningImport(request, c.env, url), request, c.env);
  }
  // 품절·사진·품절 제보(영양사·학생·삐봇·관리자)는 소유권 전환 뒤 coop Durable Object가 원본이다.
  const coopResponse = await handleCoopRoute(request, c.env, url);
  if (coopResponse) return fromBatch(coopResponse, request, c.env);

  try {
    // 원본 연결용 DNS-only 호스트로 보내 와일드카드 웹 Worker를 거치지 않는다.
    return withBackend(await fetchOrigin(request, c.env), 'aws');
  } catch (error) {
    // 응답 유실 시에도 재실행하지 않는다. 쓰기 요청을 중복 전송할 수 있다.
    captureError(error);
    return withBackend(
      errorResponse(new ApiError(502, 'KOIN_UPSTREAM_UNAVAILABLE', 'API 연결에 실패했습니다.')),
      'aws',
    );
  }
});

export default gateway;
