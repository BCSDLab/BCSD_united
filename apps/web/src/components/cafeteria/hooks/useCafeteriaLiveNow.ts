import { useCafeteriaServerValue } from 'components/cafeteria/context/CafeteriaServerContext';
import { DiningTime, kstDateKey } from 'components/cafeteria/utils/time';
import useLiveNow from 'utils/hooks/state/useLiveNow';
import { useServerNow } from 'utils/ssr/useServerNow';

const POLL_MS = 60_000;

function bucketOf(date: Date): string {
  return `${kstDateKey(date)}|${new DiningTime(date).getType()}`;
}

/**
 * 하이드레이션 시점엔 서버 스냅샷과 같은 값을 쓰고, 날짜/식사시간대 경계를 넘으면(1분 폴링
 * 또는 탭 포커스 복귀 시) 실제 현재 시각으로 갈아탄다. 경계를 넘기 전까지는 같은 `Date`
 * 인스턴스를 돌려주므로, 이 값을 키나 의존성으로 쓰는 하위 트리가 1분마다 다시 만들어지지 않는다.
 *
 * 기준 시각은 식단 라우트 로더가 내려준 값을 우선한다. 요청 전체의 서버 시각(`useServerNow`)보다
 * 날짜 쿼리 탐색마다 새로 받아 더 신선하다.
 */
export function useCafeteriaLiveNow(): Date {
  const { serverNow } = useCafeteriaServerValue();
  const requestNow = useServerNow();
  const baseNow = serverNow ?? requestNow;
  const liveNow = useLiveNow(POLL_MS);

  return bucketOf(liveNow) === bucketOf(baseNow) ? baseNow : liveNow;
}
