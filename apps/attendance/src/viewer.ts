import { handleAutomation, type AutomationEnv } from './automation.ts';

export type Env = AutomationEnv &
  Partial<Pick<Cloudflare.Env, 'VIEW_STATE'>> & {
    CF_ACCESS_AUD?: string;
  };

const SNAPSHOT_KEY = 'clubroom:view:v1';
const MAX_AGE_MS = 300_000;
const MAX_SNAPSHOT_BYTES = 2_097_152;
const MAX_PNG_BYTES = 262_144;
const STREAM_MS = 60_000;
const STREAM_POLL_MS = 10_000;
const JSON_PATHS = [
  '/api/state',
  '/api/monitor',
  '/api/koin-health',
  '/api/worker-health',
  '/api/spotify',
  '/api/jam',
] as const;
const ASSET_PATHS: Record<string, true> = {
  '/api/wifi-qr/2.4': true,
  '/api/wifi-qr/5': true,
  '/api/jam-qr': true,
};
const READ_PATHS: Record<string, true> = {
  '/': true,
  '/health': true,
  '/api/events': true,
  '/api/view-status': true,
  '/api/automation': true,
  '/api/state': true,
  '/api/monitor': true,
  '/api/koin-health': true,
  '/api/worker-health': true,
  '/api/spotify': true,
  '/api/jam': true,
  '/api/wifi-qr/2.4': true,
  '/api/wifi-qr/5': true,
  '/api/jam-qr': true,
};
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https://i.scdn.co https://mosaic.scdn.co; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

type JsonObject = Record<string, unknown>;
interface Payload {
  status: number;
  body: JsonObject;
}
interface Snapshot {
  version: 1;
  observedAt: number;
  publishedAt: number;
  payloads: Record<string, Payload>;
  assets: Record<string, string>;
}
type SnapshotResult =
  | { snapshot: Snapshot; error?: undefined }
  | {
      snapshot?: Snapshot;
      error: 'snapshot_missing' | 'snapshot_malformed' | 'snapshot_unavailable' | 'snapshot_stale';
    };

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPng(png: unknown): png is string {
  if (
    typeof png !== 'string' ||
    png.length < 76 ||
    png.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 ||
    !png.startsWith('iVBORw0KGgo') ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(png)
  )
    return false;
  const size = (png.length / 4) * 3 - (png.endsWith('==') ? 2 : png.endsWith('=') ? 1 : 0);
  if (size > MAX_PNG_BYTES) return false;
  // 전체 이미지를 복사하지 않고 제한된 PNG 헤더·트레일러만 검사한다.
  const head = atob(png.slice(0, 44));
  const tail = atob(png.slice(-20));
  if (
    head.slice(8, 16) !== '\x00\x00\x00\x0dIHDR' ||
    head.charCodeAt(16) !== 0 ||
    head.charCodeAt(17) !== 0 ||
    head.charCodeAt(20) !== 0 ||
    head.charCodeAt(21) !== 0 ||
    head.charCodeAt(26) !== 0 ||
    head.charCodeAt(27) !== 0 ||
    head.charCodeAt(28) > 1 ||
    !tail.endsWith('\x00\x00\x00\x00IEND\xae\x42\x60\x82')
  )
    return false;
  const width = head.charCodeAt(18) * 256 + head.charCodeAt(19);
  const height = head.charCodeAt(22) * 256 + head.charCodeAt(23);
  return width > 0 && width <= 2048 && height > 0 && height <= 2048;
}

function isSnapshot(value: unknown, now: number): value is Snapshot {
  if (
    !record(value) ||
    value.version !== 1 ||
    Object.keys(value).length !== 5 ||
    typeof value.observedAt !== 'number' ||
    typeof value.publishedAt !== 'number' ||
    !Number.isSafeInteger(value.observedAt) ||
    !Number.isSafeInteger(value.publishedAt) ||
    value.observedAt <= 0 ||
    value.publishedAt < value.observedAt ||
    value.publishedAt > now ||
    !record(value.payloads) ||
    !record(value.assets)
  )
    return false;
  if (Object.keys(value.payloads).length !== JSON_PATHS.length) return false;
  for (const path of JSON_PATHS) {
    const payload = value.payloads[path];
    if (
      !record(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.status !== 'number' ||
      !Number.isInteger(payload.status) ||
      payload.status < 200 ||
      payload.status > 599 ||
      (payload.status >= 300 && payload.status < 400) ||
      payload.status === 204 ||
      payload.status === 205 ||
      !record(payload.body)
    )
      return false;
  }
  if (typeof value.assets['/api/wifi-qr/2.4'] !== 'string' || typeof value.assets['/api/wifi-qr/5'] !== 'string')
    return false;
  for (const path in value.assets) {
    if (!Object.hasOwn(ASSET_PATHS, path) || !validPng(value.assets[path])) return false;
  }
  return true;
}

function parseSnapshot(raw: ArrayBuffer, now: number): Snapshot | undefined {
  if (raw.byteLength > MAX_SNAPSHOT_BYTES) return;
  const value: unknown = JSON.parse(decoder.decode(raw));
  return isSnapshot(value, now) ? value : undefined;
}

async function loadSnapshot(env: Env): Promise<SnapshotResult> {
  let raw: ArrayBuffer | null;
  try {
    raw = await env.VIEW_STATE!.get(SNAPSHOT_KEY, 'arrayBuffer');
  } catch {
    return { error: 'snapshot_unavailable' };
  }
  if (raw === null) return { error: 'snapshot_missing' };
  try {
    const now = Date.now();
    const snapshot = parseSnapshot(raw, now);
    if (!snapshot) return { error: 'snapshot_malformed' };
    if (now - snapshot.observedAt > MAX_AGE_MS) return { snapshot, error: 'snapshot_stale' };
    return { snapshot };
  } catch {
    return { error: 'snapshot_malformed' };
  }
}

function headers(contentType: string, snapshot?: Snapshot): Headers {
  const result = new Headers({
    'content-type': contentType,
    'cache-control': 'private, no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'x-bcsd-view-mode': 'eventually-consistent-snapshot',
  });
  if (snapshot) {
    result.set('x-bcsd-snapshot-observed-at', String(snapshot.observedAt));
    result.set('x-bcsd-snapshot-published-at', String(snapshot.publishedAt));
    result.set('x-bcsd-snapshot-age-ms', String(Date.now() - snapshot.observedAt));
  }
  return result;
}

function failure(status: number, error: string, snapshot?: Snapshot, allow?: string): Response {
  const responseHeaders = headers('application/json; charset=utf-8', snapshot);
  if (allow) responseHeaders.set('allow', allow);
  return new Response(JSON.stringify({ error, mode: 'hosted_snapshot' }), { status, headers: responseHeaders });
}

function events(request: Request, env: Env, initial: Snapshot, deadline: number): Response {
  let ended = false;
  let poll: ReturnType<typeof setTimeout>;
  let lifetime: ReturnType<typeof setTimeout>;
  let output: ReadableStreamDefaultController<Uint8Array>;
  let version = `${initial.observedAt}:${initial.publishedAt}`;
  const cleanup = () => {
    clearTimeout(poll);
    clearTimeout(lifetime);
    request.signal.removeEventListener('abort', clientLeft);
  };
  const stop = (close: boolean) => {
    if (ended) return;
    ended = true;
    cleanup();
    if (close) output.close();
  };
  const clientLeft = () => stop(true);
  const emit = (event: string, body: unknown) =>
    output.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`));
  const check = async () => {
    if (ended) return;
    const result = await loadSnapshot(env);
    if (ended) return;
    if (Date.now() >= deadline) {
      stop(true);
      return;
    }
    if (result.error) {
      emit('unavailable', { error: result.error });
      stop(true);
      return;
    }
    const next = `${result.snapshot.observedAt}:${result.snapshot.publishedAt}`;
    if (next !== version) {
      version = next;
      emit('state', { version });
    } else {
      emit('ping', {});
    }
    poll = setTimeout(() => {
      void check();
    }, STREAM_POLL_MS);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      request.signal.addEventListener('abort', clientLeft, { once: true });
      if (request.signal.aborted) {
        stop(true);
        return;
      }
      emit('state', { version });
      poll = setTimeout(() => {
        void check();
      }, STREAM_POLL_MS);
      lifetime = setTimeout(() => stop(true), Math.max(0, deadline - Date.now()));
    },
    cancel() {
      stop(false);
    },
  });
  const responseHeaders = headers('text/event-stream; charset=utf-8', initial);
  responseHeaders.set('x-accel-buffering', 'no');
  return new Response(body, { headers: responseHeaders });
}

/** 기존 LAN 템플릿으로 빌드한 HTML이며 Worker Static Assets는 사용하지 않는다. */
export function createViewer(html: string) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const deadline = Date.now() + STREAM_MS;
      const url = new URL(request.url);
      // 카메라·관리자·인증·쓰기 경로는 원격으로 중계하지 않는다.
      if (!Object.hasOwn(READ_PATHS, url.pathname)) return failure(404, 'not_found');
      if (request.method !== 'GET' && !(url.pathname === '/' && request.method === 'HEAD')) {
        return failure(405, 'method_not_allowed', undefined, url.pathname === '/' ? 'GET, HEAD' : 'GET');
      }
      if (request.url.includes('?') || url.hash) return failure(400, 'query_not_allowed');
      if (
        typeof env.CF_ACCESS_AUD !== 'string' ||
        !env.CF_ACCESS_AUD ||
        env.CF_ACCESS_AUD.length > 256 ||
        env.CF_ACCESS_AUD.trim() !== env.CF_ACCESS_AUD
      ) {
        return failure(503, 'private_view_unconfigured');
      }
      // 플랫폼 인증만 신뢰하고 클라이언트 헤더·쿠키를 권한으로 해석하지 않는다.
      if (!ctx?.access || ctx.access.aud !== env.CF_ACCESS_AUD) return failure(403, 'access_required');
      if (request.signal.aborted) return failure(499, 'client_closed');
      if (url.pathname === '/api/automation') {
        const response = await handleAutomation(env);
        for (const [name, value] of headers('application/json; charset=utf-8')) response.headers.set(name, value);
        response.headers.set('x-bcsd-view-mode', 'live-automation-read-only');
        return response;
      }
      if (url.pathname === '/') {
        return new Response(request.method === 'HEAD' ? null : html, { headers: headers('text/html; charset=utf-8') });
      }
      const result = await loadSnapshot(env);
      if (url.pathname === '/api/view-status') {
        const snapshot = result.snapshot;
        return new Response(
          JSON.stringify({
            available: !result.error,
            observedAt: snapshot?.observedAt ?? null,
            publishedAt: snapshot?.publishedAt ?? null,
            ageMs: snapshot ? Date.now() - snapshot.observedAt : null,
          }),
          {
            status: result.error ? 503 : 200,
            headers: headers('application/json; charset=utf-8', snapshot),
          },
        );
      }
      if (result.error) return failure(503, result.error, result.snapshot);
      const snapshot = result.snapshot;
      if (url.pathname === '/api/events') {
        if (Date.now() >= deadline) return failure(503, 'snapshot_unavailable');
        return events(request, env, snapshot, deadline);
      }
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({
            mode: 'hosted_snapshot',
            consistency: 'eventual',
            observedAt: snapshot.observedAt,
            publishedAt: snapshot.publishedAt,
            ageMs: Date.now() - snapshot.observedAt,
          }),
          { headers: headers('application/json; charset=utf-8', snapshot) },
        );
      }
      if (Object.hasOwn(ASSET_PATHS, url.pathname)) {
        const png = snapshot.assets[url.pathname];
        if (!png) return failure(404, 'snapshot_asset_missing', snapshot);
        const binary = atob(png);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new Response(bytes, { headers: headers('image/png', snapshot) });
      }
      const payload = snapshot.payloads[url.pathname];
      return new Response(JSON.stringify(payload.body), {
        status: payload.status,
        headers: headers('application/json; charset=utf-8', snapshot),
      });
    },
  } satisfies ExportedHandler<Env>;
}
