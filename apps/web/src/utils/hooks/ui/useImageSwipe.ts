import { useRef } from 'react';
import type { MouseEvent, PointerEvent, TouchEvent } from 'react';
import { useSwipeable } from 'react-swipeable';

interface UseImageSwipeOptions {
  enabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export default function useImageSwipe({ enabled, onPrevious, onNext }: UseImageSwipeOptions) {
  const hasMultipleTouches = useRef(false);
  const ignorePointerClick = useRef(false);
  const swipeHandlers = useSwipeable({
    trackTouch: enabled,
    trackMouse: enabled,
    onSwiped: () => {
      ignorePointerClick.current = true;
    },
    onSwipedLeft: () => {
      if (enabled && !hasMultipleTouches.current) onNext();
    },
    onSwipedRight: () => {
      if (enabled && !hasMultipleTouches.current) onPrevious();
    },
  });

  // 새 포인터 입력에서만 초기화해 터치 뒤의 호환 마우스 이벤트에는 영향을 받지 않는다.
  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary) return;
    hasMultipleTouches.current = false;
    ignorePointerClick.current = false;
  };

  const onTouchStartCapture = (event: TouchEvent<HTMLElement>) => {
    if (event.touches.length > 1) {
      hasMultipleTouches.current = true;
      ignorePointerClick.current = true;
    }
  };

  const onButtonClick = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0 || !ignorePointerClick.current) action();
  };

  return {
    handlers: {
      ...swipeHandlers,
      onPointerDownCapture,
      onTouchStartCapture,
    },
    onButtonClick,
  };
}
