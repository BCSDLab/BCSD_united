import { parseErrorMonitorSnapshot, type ErrorMonitorSnapshot } from '@koin/telemetry/monitor';

export type AutomationEnv = Partial<Pick<Cloudflare.Env, 'ERROR_AUTOMATION'>> & {
  ERROR_MONITOR_TOKEN?: string;
};

export interface AutomationResult {
  state: 'ok' | 'unknown';
  checkedAt: number | null;
  data: ErrorMonitorSnapshot | null;
  reason?: 'not_configured' | 'unavailable' | 'stale';
}

const MAX_BYTES = 16 * 1024;
const DEADLINE_MS = 5_000;
const FRESH_MS = 120_000;
const HEALTH_URL = 'https://error-automation.internal/healthz';
const UNKNOWN_HEADERS = { 'cache-control': 'no-store' };

function unknown(reason: NonNullable<AutomationResult['reason']>): AutomationResult {
  return { state: 'unknown', checkedAt: null, data: null, reason };
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('oversized response');
  }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => {});
    throw new Error('non-JSON response');
  }
  if (!response.body) throw new Error('missing response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = '';
  let complete = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
    throw new Error('monitor deadline exceeded');
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('oversized response');
      text += decoder.decode(value, { stream: true });
    }
    complete = true;
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** The deadline covers both the binding fetch and consumption of the complete response. */
export async function getAutomationResult(env: AutomationEnv, now: () => number = Date.now): Promise<AutomationResult> {
  const binding = env.ERROR_AUTOMATION;
  const token = env.ERROR_MONITOR_TOKEN;
  if (!binding || !token || token.length < 32) return unknown('not_configured');

  const controller = new AbortController();
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    reject(new Error('monitor deadline exceeded'));
  }, DEADLINE_MS);
  try {
    const task = async (): Promise<AutomationResult> => {
      const response = await binding.fetch(HEALTH_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status !== 200 || response.redirected) return unknown('unavailable');
      const payload = await readBoundedJson(response, controller.signal);
      const checkedAt =
        payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'checkedAt' in payload
          ? payload.checkedAt
          : null;
      const currentTime = now();
      const snapshot = parseErrorMonitorSnapshot(payload, currentTime);
      if (!snapshot)
        return unknown(
          typeof checkedAt === 'number' && Number.isFinite(checkedAt) && currentTime - checkedAt > FRESH_MS
            ? 'stale'
            : 'unavailable',
        );
      return { state: 'ok', checkedAt: snapshot.checkedAt, data: snapshot };
    };
    return await Promise.race([task(), deadline]);
  } catch {
    return unknown('unavailable');
  } finally {
    clearTimeout(timer);
  }
}

export async function handleAutomation(env: AutomationEnv): Promise<Response> {
  return Response.json(await getAutomationResult(env), { headers: UNKNOWN_HEADERS });
}
