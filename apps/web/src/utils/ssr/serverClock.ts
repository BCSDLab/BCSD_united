let offset: number | undefined;
let pending: Promise<void> | undefined;

/** 세션 응답은 no-store이며 Date 헤더는 서버에서 발급된다. */
export function sampleServerClock(response: Response) {
  const date = response.headers.get('Date');
  const time = date ? Date.parse(date) : NaN;
  if (Number.isFinite(time)) offset = time - Date.now();
}

export function initializeServerClock(now: string, mayBeSharedCached: boolean) {
  if (offset !== undefined || mayBeSharedCached) return;
  const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  offset = Date.parse(now) - (performance.timeOrigin + (navigation?.responseStart ?? 0));
}

export async function getFreshServerNow(): Promise<string> {
  if (offset === undefined) {
    pending ??= fetch('/api/v2/web/auth/session', { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => sampleServerClock(response))
      .finally(() => {
        pending = undefined;
      });
    await pending;
  }
  if (offset === undefined || !Number.isFinite(offset)) throw new Error('Server time unavailable');

  return new Date(Date.now() + offset).toISOString();
}
