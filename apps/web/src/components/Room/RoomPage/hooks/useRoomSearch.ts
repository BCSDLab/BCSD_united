import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { roomQueries } from 'api/room/queries';
import filterRoomsByName from 'components/Room/utils/filterRoomsByName';
import useParamsHandler from 'utils/hooks/routing/useParamsHandler';

export default function useRoomSearch() {
  const { data, error, isFetching } = useQuery({
    ...roomQueries.list(),
    refetchOnMount: (query) => (query.state.error ? 'always' : true),
  });
  const { searchParams, setParams } = useParamsHandler();
  const keyword = searchParams.get('keyword') ?? '';
  const rooms = data?.lands;
  const results = useMemo(() => filterRoomsByName(rooms, keyword), [rooms, keyword]);

  if (error && !isFetching) throw error;

  const searchRooms = (value: string) => setParams({ keyword: value || undefined });

  return { rooms, results, keyword, searchRooms };
}
