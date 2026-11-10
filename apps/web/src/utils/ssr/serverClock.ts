let offset: number | undefined;
let fallbackOffset: number | undefined;
let pending: Promise<void> | undefined;

/** Date 헤더는 초 단위로 잘리므로 구간의 중간값을 사용한다. */
export function sampleServerClock(response: Response) {
  const date = response.headers.get('Date');
  const time = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(time)) return;
  const sampled = time + 500 - Date.now();
  // 초 단위 Date 표본의 오차로 기존 오프셋을 조금 뒤로 돌리지 않는다.
  if (offset !== undefined && sampled < offset && offset - sampled < 1000) return;
  offset = sampled;
}

export function initializeServerClock(now: string, mayBeSharedCached: boolean) {
  if (fallbackOffset !== undefined) return;
  const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  fallbackOffset = Date.parse(now) - (performance.timeOrigin + (navigation?.responseStart ?? 0));
  if (offset === undefined && !mayBeSharedCached) {
    offset = fallbackOffset;
  }
}

export async function getFreshServerNow(fetchSession: () => Promise<unknown>, skipSample = false): Promise<string> {
  if (offset === undefined && !skipSample) {
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
