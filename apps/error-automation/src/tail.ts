import type { App } from './types';

export interface TailEvidence {
  version: 1;
  workerName: string;
  rayId: string;
  scriptVersion: string;
  eventTimestamp: number;
  route: string;
  frames: { path: string; line: number; column: number }[];
}

/** Exact production hostnames per Worker: workers.dev plus the koin-web custom domain only. */
export const SOURCE_HOSTS: Record<string, readonly string[]> = {
  'koin-web': ['koin-web.bcsdlab.workers.dev', 'koreatech.in'],
  'koin-api': ['koin-api.bcsdlab.workers.dev'],
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const FRAME =
  /(?:^|[\s(])((?:(?:apps\/(?:web|api)\/)?src\/|assets\/)[A-Za-z0-9_.$/-]+\.(?:ts|tsx|js|jsx)|index\.js):(\d+):(\d+)(?=[\s)]|$)/gm;

export function sourcePath(path: string, app: App): string | null {
  if (path.length > 180 || path.includes('..')) return null;
  const match = /^(?:apps\/(web|api)\/)?src\/([A-Za-z0-9_.$/-]+\.(?:ts|tsx|js|jsx))$/.exec(path);
  if (!match || (match[1] && match[1] !== app)) return null;
  return `apps/${app}/src/${match[2]}`;
}

export function isBundlePath(path: string): boolean {
  return path.length <= 180 && !path.includes('..') && /^(?:assets\/[A-Za-z0-9_.$/-]+\.js|index\.js)$/.test(path);
}

export function extractStackFrames(stacks: string[], app: App): TailEvidence['frames'] {
  const frames: TailEvidence['frames'] = [];
  const seen = new Set<string>();
  for (const stack of stacks) {
    if (stack.length > 16_384) continue;
    for (const match of stack.matchAll(FRAME)) {
      const path = sourcePath(match[1], app) ?? (isBundlePath(match[1]) ? match[1] : null);
      if (!path) continue;
      const line = Number(match[2]),
        column = Number(match[3]);
      if (
        !Number.isSafeInteger(line) ||
        line < 1 ||
        line > 1_000_000 ||
        !Number.isSafeInteger(column) ||
        column < 1 ||
        column > 10_000
      )
        continue;
      const key = `${path}:${line}:${column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({ path, line, column });
      if (frames.length >= 12) break;
    }
    if (frames.length >= 12) break;
  }
  return frames;
}

/** 원문 로그 없이 위치만 보존한다. 번들 위치는 접수 시 같은 배포 버전의 소스맵으로 검증한다. */
export function extractTailEvidence(item: TraceItem, workerName: string, app: App): TailEvidence | null {
  if (
    item.scriptName !== workerName ||
    !SOURCE_HOSTS[workerName] ||
    item.truncated ||
    !item.event ||
    !('request' in item.event) ||
    item.event.request.method !== 'GET' ||
    !Number.isSafeInteger(item.eventTimestamp) ||
    item.eventTimestamp === null ||
    item.eventTimestamp < Date.now() - 7 * 24 * 60 * 60 * 1000 ||
    !item.scriptVersion?.id ||
    !UUID.test(item.scriptVersion.id)
  )
    return null;

  const rawRay = item.event.request.headers['cf-ray'];
  if (!rawRay || !/^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(rawRay)) return null;
  let route: string;
  try {
    const url = new URL(item.event.request.url);
    if (
      url.protocol !== 'https:' ||
      !SOURCE_HOSTS[workerName].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname.length > 200 ||
      !/^\/[A-Za-z0-9_/-]*$/.test(url.pathname) ||
      url.pathname.startsWith('//') ||
      url.pathname.includes('..') ||
      url.pathname.includes('REDACTED')
    )
      return null;
    route = url.pathname;
  } catch {
    return null;
  }

  const stacks: string[] = [];
  for (let index = 0; index < item.exceptions.length && index < 5; index += 1) {
    const stack = item.exceptions[index].stack;
    if (typeof stack === 'string') stacks.push(stack);
  }
  for (let index = 0; index < item.logs.length && index < 20; index += 1) {
    const log = item.logs[index];
    if (log.level !== 'error' || !log.errorInfo) continue;
    for (let errorIndex = 0; errorIndex < log.errorInfo.length && errorIndex < 5; errorIndex += 1) {
      const stack = log.errorInfo[errorIndex]?.stack;
      if (typeof stack === 'string') stacks.push(stack);
    }
  }
  const frames = extractStackFrames(stacks, app);
  if (!frames.length) return null;
  return {
    version: 1,
    workerName,
    rayId: rawRay.slice(0, 16),
    scriptVersion: item.scriptVersion.id,
    eventTimestamp: item.eventTimestamp,
    route,
    frames,
  };
}

export function tailKey(workerName: string, rayId: string): string {
  return `tail/${workerName}/${rayId}`;
}
