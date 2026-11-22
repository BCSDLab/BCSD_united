import { useQuery } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';

import { roomQueries } from 'api/room/queries';
import { isNotFoundKoinError } from 'utils/ts/isr';

const useRoomDetail = (id: string) => {
  const { data: roomDetail, error } = useQuery(roomQueries.detail(id));

  if (error) {
    if (isNotFoundKoinError(error)) throw notFound();
    if (!roomDetail) throw error;
  }

  const roomOptions = Object.entries(roomDetail || {}).reduce((acc, [key, val]) => {
    if (key.startsWith('opt')) {
      return {
        ...acc,
        [key]: val,
      };
    }

    return acc;
  }, {});

  return { roomDetail, roomOptions };
};

export default useRoomDetail;
