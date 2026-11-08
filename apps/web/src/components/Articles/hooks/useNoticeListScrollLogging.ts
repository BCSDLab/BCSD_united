import { useEffect, useRef } from 'react';

import useLogger from 'utils/hooks/analytics/useLogger';

// 스크롤이 이 시간 동안 멈추면 한 번의 스크롤이 끝난 것으로 본다
const SCROLL_END_DELAY_MS = 300;
// 이보다 적게 움직인 스크롤은 보내지 않는다
const MIN_SCROLL_DISTANCE_PX = 50;

/**
 * 게시판 4-2 공지사항 목록 상하 스크롤.
 * 스크롤 한 번이 끝날 때마다 직전에 멈췄던 위치와 비교한 방향(위로·아래로)을 한 번 보낸다.
 */
export default function useNoticeListScrollLogging() {
  const logger = useLogger();
  // 직전 스크롤이 끝난 위치. 첫 스크롤 이벤트 시점의 위치는 이미 움직인 뒤라 기준으로 쓰지 않는다
  const lastYRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (lastYRef.current === null) lastYRef.current = window.scrollY;

    const onScroll = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);

      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const distance = window.scrollY - (lastYRef.current ?? 0);
        if (Math.abs(distance) < MIN_SCROLL_DISTANCE_PX) return;
        lastYRef.current = window.scrollY;

        logger.actionEventClick({
          event_name: 'DA2',
          event_label: 'board__main_notice__notice_list__scroll',
          value: distance > 0 ? '아래로' : '위로',
          event_category: 'scroll',
        });
      }, SCROLL_END_DELAY_MS);
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [logger]);
}
