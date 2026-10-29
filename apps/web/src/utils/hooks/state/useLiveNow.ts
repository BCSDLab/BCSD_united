import { useSyncExternalStore } from 'react';

import { useServerNow } from 'utils/ssr/useServerNow';

interface ClockStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => Date | null;
}

const stores = new Map<number, ClockStore>();

// 같은 주기를 쓰는 소비자들이 하나의 타이머와 하나의 Date 인스턴스를 공유하도록 주기별로 저장한다.
function getClockStore(intervalMs: number): ClockStore {
  const existing = stores.get(intervalMs);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  let now: Date | null = null;
  let timer: number | null = null;

  const tick = () => {
    now = new Date();
    listeners.forEach((listener) => listener());
  };
  // 백그라운드 탭은 타이머가 느려지므로 돌아오는 순간 바로 맞춘다.
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') tick();
  };

  const store: ClockStore = {
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) {
        now = new Date();
        timer = window.setInterval(tick, intervalMs);
        document.addEventListener('visibilitychange', onVisibilityChange);
      }

      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer !== null) {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          timer = null;
          now = null;
        }
      };
    },
    getSnapshot: () => now,
  };
  stores.set(intervalMs, store);

  return store;
}

const getServerSnapshot = () => null;

/**
 * 서버 렌더 시각으로 시작해 마운트 뒤에는 기기 시계를 따라가는 현재 시각.
 *
 * 서버 렌더와 하이드레이션 렌더는 `useServerNow()`와 같은 값을 돌려주므로 DOM이 일치한다.
 * 구독이 시작되면 실제 시각으로 한 번 바뀌고, 그 뒤 `intervalMs`마다(그리고 탭이 다시 보일 때)
 * 새 `Date` 인스턴스로 바뀐다. 매 갱신마다 재렌더되므로 주기는 화면이 실제로 보여주는
 * 단위(분 단위 상대시각이면 1분)에 맞춘다.
 */
export default function useLiveNow(intervalMs = 60_000): Date {
  const serverNow = useServerNow();
  const store = getClockStore(intervalMs);
  const liveNow = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);

  return liveNow ?? serverNow;
}
