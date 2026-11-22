export interface RoomMarkerGroup {
  ids: number[];
  marker: naver.maps.Marker;
  onHide?: () => void;
}

const CLUSTER_ANIMATION_DURATION_MS = 300;

export default function createRoomMarkerAnimator(map: naver.maps.Map) {
  let currentGroups: RoomMarkerGroup[] = [];
  const animations = new Map<Animation, () => void>();

  const finishAnimations = () => {
    animations.forEach((finish) => finish());
  };

  const animateMarker = (
    marker: naver.maps.Marker,
    from: naver.maps.Coord,
    to: naver.maps.Coord,
    onFinish?: () => void,
  ) => {
    const projection = map.getProjection();
    const position = projection.fromCoordToOffset(marker.getPosition());
    const start = projection.fromCoordToOffset(from);
    const end = projection.fromCoordToOffset(to);
    const element = marker.getElement();
    if (!element || typeof element.animate !== 'function' || (start.x === end.x && start.y === end.y)) {
      onFinish?.();

      return;
    }

    // SDK가 관리하는 실제 좌표와 transform은 유지하고, 표시 위치만 이동한다.
    const animation = element.animate(
      [
        { translate: `${start.x - position.x}px ${start.y - position.y}px` },
        { translate: `${end.x - position.x}px ${end.y - position.y}px` },
      ],
      { duration: CLUSTER_ANIMATION_DURATION_MS, easing: 'ease-out', fill: 'both' },
    );
    const finish = () => {
      animations.delete(animation);
      animation.onfinish = null;
      animation.cancel();
      onFinish?.();
    };
    animations.set(animation, finish);
    animation.onfinish = finish;
  };

  const update = (nextGroups: RoomMarkerGroup[], shouldAnimate: boolean) => {
    finishAnimations();
    const animate = shouldAnimate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const previousMarkers = new Set(currentGroups.map(({ marker }) => marker));
    const nextMarkers = new Set(nextGroups.map(({ marker }) => marker));
    const previousById = new Map<number, naver.maps.Marker>();
    const nextById = new Map<number, naver.maps.Marker>();
    currentGroups.forEach(({ ids, marker }) => ids.forEach((id) => previousById.set(id, marker)));
    nextGroups.forEach(({ ids, marker }) => ids.forEach((id) => nextById.set(id, marker)));

    currentGroups.forEach((group) => {
      if (nextMarkers.has(group.marker)) return;
      const destination = nextById.get(group.ids[0]);
      const hide = () => {
        group.marker.setVisible(false);
        group.onHide?.();
      };
      if (animate && destination) {
        animateMarker(group.marker, group.marker.getPosition(), destination.getPosition(), hide);
      } else {
        hide();
      }
    });
    nextGroups.forEach(({ ids, marker }) => {
      if (!marker.getVisible()) marker.setVisible(true);
      if (!animate || previousMarkers.has(marker)) return;
      const source = previousById.get(ids[0]);
      if (source) animateMarker(marker, source.getPosition(), marker.getPosition());
    });
    currentGroups = nextGroups;
  };

  const clear = () => {
    finishAnimations();
    currentGroups = [];
  };

  return { update, clear };
}
