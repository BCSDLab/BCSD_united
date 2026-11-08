import { useEffect, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';

import useLogger from 'utils/hooks/analytics/useLogger';

// 스크롤 위치가 이 시간 동안 바뀌지 않으면 정지로 본다
const SCROLL_STOP_DELAY_MS = 200;
// 직전 정지 위치와의 순변위가 이보다 작으면 보내지 않는다 (CSS px)
const MIN_SCROLL_DISTANCE_PX = 50;

// 바운스(오버스크롤)로 범위를 벗어난 위치를 문서의 유효 스크롤 범위로 보정한다
const getClampedScrollY = () => {
  const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  return Math.min(Math.max(window.scrollY, 0), maxY);
};

/**
 * 게시판 4-2 공지사항 목록 상하 스크롤.
 * - 사용자 입력(휠·터치·키보드)으로 시작한 스크롤만 센다. 최초 표시·복원·자동 스크롤·레이아웃 변화는 보내지 않는다.
 * - 200ms 동안 위치가 바뀌지 않으면 정지로 보고, 직전 정지 위치와의 순변위가 50px 이상이면 방향(위로·아래로)을 한 번 보낸다.
 * - 전송 여부와 관계없이 정지할 때마다 기준점을 이번 위치로 갱신한다 (50px 미만 이동은 다음 구간으로 누적하지 않는다).
 * - 화면을 떠나면 예약된 전송을 취소한다.
 */
export default function useNoticeListScrollLogging() {
  // useLogger는 렌더마다 새 객체라 ref로 고정해 기준점이 리렌더로 초기화되지 않게 한다
  const loggerRef = useRef(useLogger());
  const router = useRouter();

  useEffect(() => {
    let baseY = getClampedScrollY();
    let isUserScrolling = false;
    let timer: number | null = null;

    const markUserInput = () => {
      isUserScrolling = true;
    };

    // 스크롤바를 직접 끄는 경우 (스크롤바 클릭의 target은 문서 루트다)
    const onMouseDown = (e: MouseEvent) => {
      if (e.target === document.documentElement) markUserInput();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) markUserInput();
    };

    const onStop = () => {
      timer = null;
      const currentY = getClampedScrollY();
      const distance = currentY - baseY;
      const shouldSend = isUserScrolling && Math.abs(distance) >= MIN_SCROLL_DISTANCE_PX;

      baseY = currentY;
      isUserScrolling = false;

      if (!shouldSend) return;

      loggerRef.current.actionEventClick({
        event_name: 'DA2',
        event_label: 'board__main_notice__notice_list__scroll',
        value: distance > 0 ? '아래로' : '위로',
        event_category: 'scroll',
      });
    };

    // 화면을 떠나면(라우트 이동 시작·페이지 숨김) 예약된 전송을 취소한다. 라우트 이동은 로더를 기다리는 동안 아직 언마운트 전이다
    const cancelPending = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      isUserScrolling = false;
    };
    const unsubscribeNavigate = router.subscribe('onBeforeNavigate', cancelPending);

    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(onStop, SCROLL_STOP_DELAY_MS);
    };

    window.addEventListener('wheel', markUserInput, { passive: true });
    window.addEventListener('touchmove', markUserInput, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', cancelPending);

    return () => {
      window.removeEventListener('wheel', markUserInput);
      window.removeEventListener('touchmove', markUserInput);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', cancelPending);
      unsubscribeNavigate();
      cancelPending();
    };
  }, [router]);
}
