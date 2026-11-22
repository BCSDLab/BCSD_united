import type { LandList } from 'api/room/entity';

export default function filterRoomsByName(rooms: LandList[] | undefined, keyword: string) {
  if (!keyword) return rooms;

  return rooms?.filter((room) => room.name?.includes(keyword));
}
