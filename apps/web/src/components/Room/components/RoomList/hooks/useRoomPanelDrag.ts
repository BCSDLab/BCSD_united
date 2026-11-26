import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, RefObject } from 'react';

import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

const PANEL_BASE_HEIGHT = 414;
const MAP_CONTROLS_GAP = 12;

interface HeightRange {
  min: number;
  max: number;
}

interface PanelDrag {
  pointerId: number;
  target: HTMLButtonElement;
  startY: number;
  startHeight: number;
  height: number;
  range: HeightRange;
  wasExpanded: boolean;
  hasMoved: boolean;
}

function getHeightRange(container: HTMLElement): HeightRange {
  const max = container.getBoundingClientRect().height;

  return { min: Math.min(PANEL_BASE_HEIGHT, max / 2), max };
}

function updateHeight(panel: HTMLElement, controls: HTMLDivElement | null, range: HeightRange, height: number) {
  const nextHeight = Math.max(range.min, Math.min(range.max, height));
  panel.style.height = `${nextHeight}px`;
  if (controls) {
    controls.style.bottom = `${nextHeight + MAP_CONTROLS_GAP}px`;
    controls.style.visibility = nextHeight === range.max ? 'hidden' : '';
  }

  return nextHeight;
}

function releasePointer(drag: PanelDrag) {
  if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
}

export default function useRoomPanelDrag(mapControlsRef: RefObject<HTMLDivElement | null>) {
  const isMobile = useMediaQuery();
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<PanelDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement;
    const controls = mapControlsRef.current;
    if (!isMobile || !panel || !container) return;

    const syncHeight = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag) {
        suppressClickRef.current = drag.hasMoved;
        releasePointer(drag);
      }

      const range = getHeightRange(container);
      updateHeight(panel, controls, range, isExpanded ? range.max : range.min);
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(container);

    return () => {
      observer.disconnect();
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag) releasePointer(drag);
      panel.style.removeProperty('height');
      controls?.style.removeProperty('bottom');
      controls?.style.removeProperty('visibility');
    };
  }, [isMobile, isExpanded, mapControlsRef]);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!isMobile || !event.isPrimary || event.button !== 0 || dragRef.current) return;
    const panel = panelRef.current;
    const container = panel?.parentElement;
    const range = container ? getHeightRange(container) : null;
    if (!panel || !range || range.min === range.max) return;

    const height = panel.getBoundingClientRect().height;
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      startY: event.clientY,
      startHeight: height,
      height,
      range,
      wasExpanded: isExpanded,
      hasMoved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    suppressClickRef.current = drag.hasMoved;
    if (panel)
      updateHeight(panel, mapControlsRef.current, drag.range, drag.wasExpanded ? drag.range.max : drag.range.min);
    releasePointer(drag);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons !== 1) {
      handlePointerCancel(event);

      return;
    }

    const distance = drag.startY - event.clientY;
    if (!drag.hasMoved && Math.abs(distance) < 5) return;

    drag.hasMoved = true;
    event.preventDefault();
    // 패널 높이와 지도 버튼 위치만 갱신해 드래그 중 지도를 다시 렌더하지 않는다.
    drag.height = updateHeight(panel, mapControlsRef.current, drag.range, drag.startHeight + distance);
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    suppressClickRef.current = drag.hasMoved;
    if (drag.hasMoved && panel) {
      const expanded = drag.height >= (drag.range.min + drag.range.max) / 2;
      updateHeight(panel, mapControlsRef.current, drag.range, expanded ? drag.range.max : drag.range.min);
      setIsExpanded(expanded);
    }
    releasePointer(drag);
  };

  const handleToggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current && event.detail !== 0) {
      suppressClickRef.current = false;

      return;
    }

    suppressClickRef.current = false;
    const panel = panelRef.current;
    const container = panel?.parentElement;
    const range = container ? getHeightRange(container) : null;
    if (!isMobile || !panel || !range || range.min === range.max) return;

    updateHeight(panel, mapControlsRef.current, range, isExpanded ? range.min : range.max);
    setIsExpanded(!isExpanded);
  };

  return {
    panelRef,
    isMobile,
    isExpanded,
    handleToggle,
    dragHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onLostPointerCapture: handlePointerCancel,
    },
  };
}
