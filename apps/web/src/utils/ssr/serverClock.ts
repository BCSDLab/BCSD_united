let offset: number | undefined;
let fallbackOffset: number | undefined;
let precise = false;
let pending: Promise<void> | undefined;

/** Date 헤더는 초 단위로 잘리므로 구간의 중간값을 사용한다. */
export function sampleServerClock(response: Response) {
  const date = response.headers.get('Date');
  const time = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(time)) return;
  const sampled = time + 500 - Date.now();
  // 정확한 SSR 오프셋을 거친 Date 표본으로 뒤로 돌리지 않는다.
  if (precise && offset !== undefined && sampled <= offset + 500) return;
  offset = sampled;
  precise = false;
}

export function initializeServerClock(now: string, mayBeSharedCached: boolean) {
  if (fallbackOffset !== undefined) return;
  const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  fallbackOffset = Date.parse(now) - (performance.timeOrigin + (navigation?.responseStart ?? 0));
  if (offset === undefined && !mayBeSharedCached) {
    offset = fallbackOffset;
    precise = true;
  }
}

export async function getFreshServerNow(fetchSession: () => Promise<unknown>): Promise<string> {
  if (offset === undefined) {
    pending ??= fetchSession()
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        pending = undefined;
      });
    await pending;
  }

  return new Date(Date.now() + (offset ?? fallbackOffset ?? 0)).toISOString();
}
