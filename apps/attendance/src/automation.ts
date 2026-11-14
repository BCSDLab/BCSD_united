import {
  parseErrorMonitorSnapshot,
  parseRockyMonitorSnapshot,
  readMonitorJson,
  type ErrorMonitorSnapshot,
  type RockyMonitorSnapshot,
} from '@koin/telemetry/monitor';

export type AutomationEnv = Partial<Pick<Cloudflare.Env, 'ERROR_AUTOMATION'>> & {
  ERROR_MONITOR_TOKEN?: string;
};

interface MonitorResult<TSnapshot> {
  state: 'ok' | 'unknown';
  checkedAt: number | null;
  data: TSnapshot | null;
  reason?: 'not_configured' | 'unavailable' | 'stale';
}

export type AutomationResult = MonitorResult<ErrorMonitorSnapshot>;
export interface AutomationDashboardResult extends AutomationResult {
  rocky: MonitorResult<RockyMonitorSnapshot>;
}

const DEADLINE_MS = 5_000;
const FRESH_MS = 120_000;
const HEALTH_URL = 'https://error-automation.internal/healthz';
const ROCKY_HEALTH_URL = 'https://error-automation.internal/healthz/rocky';
const UNKNOWN_HEADERS = { 'cache-control': 'no-store' };

function unknown<TSnapshot>(reason: NonNullable<AutomationResult['reason']>): MonitorResult<TSnapshot> {
  return { state: 'unknown', checkedAt: null, data: null, reason };
}

/** The deadline covers both the binding fetch and consumption of the complete response. */
async function getMonitorResult<TSnapshot extends { checkedAt: number }>(
  env: AutomationEnv,
  url: string,
  parse: (value: unknown, now: number) => TSnapshot | null,
  now: () => number,
): Promise<MonitorResult<TSnapshot>> {
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
    const task = async (): Promise<MonitorResult<TSnapshot>> => {
      const response = await binding.fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {});
        return unknown('unavailable');
      }
      const payload = await readMonitorJson(response, controller.signal);
      const checkedAt =
        payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'checkedAt' in payload
          ? payload.checkedAt
          : null;
      const currentTime = now();
      const snapshot = parse(payload, currentTime);
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

export function getAutomationResult(env: AutomationEnv, now: () => number = Date.now): Promise<AutomationResult> {
  return getMonitorResult(env, HEALTH_URL, parseErrorMonitorSnapshot, now);
}

export async function handleAutomation(env: AutomationEnv): Promise<Response> {
  const [ingress, rocky] = await Promise.all([
    getAutomationResult(env),
    getMonitorResult(env, ROCKY_HEALTH_URL, parseRockyMonitorSnapshot, Date.now),
  ]);
  const result: AutomationDashboardResult = { ...ingress, rocky };
  return Response.json(result, { headers: UNKNOWN_HEADERS });
}
