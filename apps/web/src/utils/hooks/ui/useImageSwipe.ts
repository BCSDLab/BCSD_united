import { useRef } from 'react';
import type { MouseEvent, TouchEvent } from 'react';
import { useSwipeable } from 'react-swipeable';

interface UseImageSwipeOptions {
  enabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onCenterTap?: () => void;
}

export default function useImageSwipe({ enabled, onPrevious, onNext, onCenterTap }: UseImageSwipeOptions) {
  const containerRef = useRef<HTMLElement | null>(null);
  const hasMultipleTouches = useRef(false);
  const swipeHandlers = useSwipeable({
    trackTouch: enabled,
    trackMouse: enabled,
    onTouchStartOrOnMouseDown: ({ event }) => {
      if (!('touches' in event)) hasMultipleTouches.current = false;
    },
    onSwipedLeft: () => {
      if (enabled && !hasMultipleTouches.current) onNext();
    },
    onSwipedRight: () => {
      if (enabled && !hasMultipleTouches.current) onPrevious();
    },
    onTap: ({ event }) => {
      const container = containerRef.current;
      if (!enabled || !container || hasMultipleTouches.current) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const { left, width } = container.getBoundingClientRect();
      const position = (point.clientX - left) / width;
      if (position < 0.25) onPrevious();
      else if (position > 0.75) onNext();
      else onCenterTap?.();
    },
  });

  const onTouchStartCapture = (event: TouchEvent<HTMLElement>) => {
    hasMultipleTouches.current = event.touches.length > 1;
  };

  // 포인터 탭은 useSwipeable의 onTap에서 처리하므로 키보드 클릭만 별도로 받는다.
  const onKeyboardClick = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) action();
  };

  return {
    handlers: {
      ...swipeHandlers,
      ref: (element: HTMLElement | null) => {
        containerRef.current = element;
        swipeHandlers.ref(element);
      },
      onTouchStartCapture,
    },
    onKeyboardClick,
  };
}
