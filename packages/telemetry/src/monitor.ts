export interface ErrorMonitorSnapshot {
  version: 1;
  scope: 'ingress-only';
  checkedAt: number;
  windowStart: number;
  worker: 'responding';
  sources: {
    sentry: { count: number; latestAt: number | null };
    cloudflare: { count: number; latestAt: number | null };
  };
  recent: {
    id: string;
    source: 'sentry' | 'cloudflare';
    app: 'web' | 'api';
    registeredAt: number;
    status: 'queued' | 'preparing' | 'leased' | 'verifying' | 'reporting' | 'publishing' | 'completed' | 'failed';
  }[];
}

const WINDOW_MS = 24 * 60 * 60_000;

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function status(value: unknown): value is ErrorMonitorSnapshot['recent'][number]['status'] {
  switch (value) {
    case 'queued':
    case 'preparing':
    case 'leased':
    case 'verifying':
    case 'reporting':
    case 'publishing':
    case 'completed':
    case 'failed':
      return true;
    default:
      return false;
  }
}

/** Reject stale, malformed, or unexpectedly detailed snapshots rather than displaying invented health. */
function isErrorMonitorSnapshot(value: unknown, now: number): value is ErrorMonitorSnapshot {
  if (
    !timestamp(now) ||
    !record(value, ['version', 'scope', 'checkedAt', 'windowStart', 'worker', 'sources', 'recent'])
  )
    return false;
  const { checkedAt, windowStart, sources, recent } = value;
  if (
    value.version !== 1 ||
    value.scope !== 'ingress-only' ||
    value.worker !== 'responding' ||
    !timestamp(checkedAt) ||
    !timestamp(windowStart) ||
    checkedAt - windowStart !== WINDOW_MS ||
    checkedAt < now - 120_000 ||
    checkedAt > now + 60_000 ||
    !record(sources, ['sentry', 'cloudflare']) ||
    !Array.isArray(recent) ||
    recent.length > 10
  )
    return false;

  let sentryCount = 0;
  let cloudflareCount = 0;
  for (const name of ['sentry', 'cloudflare'] as const) {
    const source = sources[name];
    if (!record(source, ['count', 'latestAt'])) return false;
    if (
      typeof source.count !== 'number' ||
      !Number.isSafeInteger(source.count) ||
      source.count < 0 ||
      (source.latestAt !== null &&
        (!timestamp(source.latestAt) || source.latestAt < windowStart || source.latestAt > checkedAt)) ||
      (source.count === 0) !== (source.latestAt === null)
    )
      return false;
    if (name === 'sentry') sentryCount = source.count;
    else cloudflareCount = source.count;
  }

  const ids = new Set<string>();
  let previous = checkedAt;
  let sentryRecent = 0;
  let cloudflareRecent = 0;
  for (const entry of recent) {
    if (
      !record(entry, ['id', 'source', 'app', 'registeredAt', 'status']) ||
      typeof entry.id !== 'string' ||
      !/^autofix-[a-f0-9]{64}$/.test(entry.id) ||
      ids.has(entry.id) ||
      (entry.source !== 'sentry' && entry.source !== 'cloudflare') ||
      (entry.app !== 'web' && entry.app !== 'api') ||
      (entry.source === 'sentry' && entry.app !== 'web') ||
      !timestamp(entry.registeredAt) ||
      entry.registeredAt < windowStart ||
      entry.registeredAt > previous ||
      !status(entry.status)
    )
      return false;
    ids.add(entry.id);
    previous = entry.registeredAt;
    if (entry.source === 'sentry') sentryRecent++;
    else cloudflareRecent++;
  }
  if (sentryRecent > sentryCount || cloudflareRecent > cloudflareCount) return false;
  return true;
}

export function parseErrorMonitorSnapshot(value: unknown, now: number): ErrorMonitorSnapshot | null {
  return isErrorMonitorSnapshot(value, now) ? value : null;
}
