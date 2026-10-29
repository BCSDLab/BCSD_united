import { useMemo, useState } from 'react';

import { useServerRequest } from 'utils/ssr/useServerRequest';
import { toKoreanCalendarDate } from 'utils/ts/calendar';

/**
 * 서버가 요청을 렌더한 절대 시각이다. 경과 시간 계산에는 이 값을 그대로 쓴다.
 * 로컬 날짜 getter를 사용하는 달력은 KST 날짜를 보장하는 `useServerCalendarDate`를 쓴다.
 *
 * 렌더 중 `new Date()`를 부르면 서버와 클라이언트가 서로 다른 시각을 보고, 하이드레이션 렌더가
 * 서버가 그린 DOM과 어긋나 통째로 교체된다. 공유 캐시 때문에 최대 60초 낡을 수 있지만 그쪽이
 * 매 로드마다 DOM을 갈아치우는 것보다 낫다. 실제 현재 시각이 필요하면 이벤트 핸들러에서 읽거나
 * `useLiveNow`로 마운트 뒤 타이머에서 갱신한다.
 *
 * 같은 요청 안에서는 같은 `Date` 인스턴스를 돌려주므로 의존성 배열에 그대로 써도 된다.
 * 루트 로더가 실행되지 않은 화면(`notFound`·오류 화면)은 서버 시각이 없어 마운트 시점에 한 번 샘플한다.
 * 이때는 서버와 클라이언트가 각자 샘플하므로 하이드레이션 일치를 보장하지 못한다.
 */
export function useServerNow(): Date {
  const serverRequest = useServerRequest();
  const serverNowISO = serverRequest?.now ?? null;
  const [mountNow] = useState(() => new Date());

  return useMemo(() => (serverNowISO === null ? mountNow : new Date(serverNowISO)), [serverNowISO, mountNow]);
}

/** 같은 서버 스냅샷의 KST 날짜를 달력용 로컬 자정으로 반환한다. 실제 시각 비교에는 쓰지 않는다. */
export function useServerCalendarDate(): Date {
  const now = useServerNow();

  return useMemo(() => toKoreanCalendarDate(now), [now]);
}
