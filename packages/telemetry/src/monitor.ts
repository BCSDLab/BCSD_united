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

export interface RockyUnitSnapshot {
  configured: boolean | null;
  state: 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'unknown';
  process: 'running' | 'stopped' | 'unknown';
  checkedAt: number | null;
}

export interface RockyMonitorSnapshot {
  version: 1;
  scope: 'rocky-read-only';
  checkedAt: number;
  gateway: 'responding';
  cpu: { usagePercent: number; sampleStart: number; sampleEnd: number } | null;
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; checkedAt: number } | null;
  executor: RockyUnitSnapshot;
  broker: RockyUnitSnapshot;
  brokerResponse: 'not_probed';
  model: 'not_probed';
}

function freshTimestamp(value: unknown, now: number): value is number {
  return timestamp(value) && value >= now - 120_000 && value <= now + 60_000;
}

function unitSnapshot(value: unknown, now: number): value is RockyUnitSnapshot {
  if (!record(value, ['configured', 'state', 'process', 'checkedAt'])) return false;
  if (
    (value.configured !== null && typeof value.configured !== 'boolean') ||
    typeof value.state !== 'string' ||
    !['active', 'inactive', 'failed', 'activating', 'deactivating', 'unknown'].includes(value.state) ||
    typeof value.process !== 'string' ||
    !['running', 'stopped', 'unknown'].includes(value.process)
  )
    return false;
  if (value.configured === false && (value.state === 'active' || value.process === 'running')) return false;
  if (value.checkedAt === null)
    return value.configured === null && value.state === 'unknown' && value.process === 'unknown';
  return freshTimestamp(value.checkedAt, now);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRockyMonitorSnapshot(value: unknown, now: number): value is RockyMonitorSnapshot {
  if (
    !timestamp(now) ||
    !record(value, [
      'version',
      'scope',
      'checkedAt',
      'gateway',
      'cpu',
      'memory',
      'executor',
      'broker',
      'brokerResponse',
      'model',
    ]) ||
    value.version !== 1 ||
    value.scope !== 'rocky-read-only' ||
    value.gateway !== 'responding' ||
    value.brokerResponse !== 'not_probed' ||
    value.model !== 'not_probed' ||
    !freshTimestamp(value.checkedAt, now) ||
    !unitSnapshot(value.executor, now) ||
    !unitSnapshot(value.broker, now)
  )
    return false;
  if (
    (value.executor.checkedAt !== null && value.executor.checkedAt > value.checkedAt) ||
    (value.broker.checkedAt !== null && value.broker.checkedAt > value.checkedAt)
  )
    return false;
  const { cpu, memory, checkedAt } = value;
  if (
    cpu !== null &&
    (!record(cpu, ['usagePercent', 'sampleStart', 'sampleEnd']) ||
      typeof cpu.usagePercent !== 'number' ||
      !Number.isFinite(cpu.usagePercent) ||
      cpu.usagePercent < 0 ||
      cpu.usagePercent > 100 ||
      !freshTimestamp(cpu.sampleStart, now) ||
      !freshTimestamp(cpu.sampleEnd, now) ||
      cpu.sampleEnd <= cpu.sampleStart ||
      cpu.sampleEnd - cpu.sampleStart > 10_000 ||
      cpu.sampleEnd > checkedAt)
  )
    return false;
  if (
    memory !== null &&
    (!record(memory, ['totalBytes', 'availableBytes', 'usedBytes', 'checkedAt']) ||
      !nonnegativeInteger(memory.totalBytes) ||
      memory.totalBytes === 0 ||
      !nonnegativeInteger(memory.availableBytes) ||
      !nonnegativeInteger(memory.usedBytes) ||
      memory.availableBytes > memory.totalBytes ||
      memory.usedBytes !== memory.totalBytes - memory.availableBytes ||
      !freshTimestamp(memory.checkedAt, now) ||
      memory.checkedAt > checkedAt)
  )
    return false;
  return true;
}

/** 서비스 활성 상태를 브로커 응답이나 모델 실행 가능 상태로 승격하지 않습니다. */
export function parseRockyMonitorSnapshot(value: unknown, now: number): RockyMonitorSnapshot | null {
  return isRockyMonitorSnapshot(value, now) ? value : null;
}

/** 바인딩 응답도 헤더·스트림·UTF-8·전체 본문 크기를 검증합니다. */
export async function readMonitorJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maxBytes = 16 * 1024;
  const length = response.headers.get('content-length');
  if (
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) ||
    !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Invalid monitoring response');
  }
  if (!response.body) throw new Error('Missing monitoring response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = '';
  let complete = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new Error('Monitoring deadline exceeded');
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Oversized monitoring response');
      text += decoder.decode(chunk.value, { stream: true });
    }
    complete = true;
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
