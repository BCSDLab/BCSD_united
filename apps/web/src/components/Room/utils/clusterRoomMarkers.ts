interface MarkerPoint {
  id: number;
  x: number;
  y: number;
}

const CLUSTER_DISTANCE_PX = 44;

export default function clusterRoomMarkers(points: MarkerPoint[]) {
  const groups: MarkerPoint[][] = [];
  const sortedPoints = [...points].sort((a, b) => a.id - b.id);

  for (const point of sortedPoints) {
    let nearestGroup: MarkerPoint[] | undefined;
    let nearestDistanceSquared = Infinity;

    for (const group of groups) {
      // 기준점을 고정해 추가된 마커를 따라 묶음이 연쇄적으로 커지지 않게 한다.
      const center = group[0];
      const distanceSquared = (center.x - point.x) ** 2 + (center.y - point.y) ** 2;
      if (distanceSquared <= CLUSTER_DISTANCE_PX ** 2 && distanceSquared < nearestDistanceSquared) {
        nearestGroup = group;
        nearestDistanceSquared = distanceSquared;
      }
    }

    if (nearestGroup) nearestGroup.push(point);
    else groups.push([point]);
  }

  return groups;
}
