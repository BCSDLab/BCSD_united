import { queryOptions } from '@tanstack/react-query';

import { getLanguages } from './index';

export const languageQueryKeys = {
  all: ['language'] as const,
  list: () => [...languageQueryKeys.all, 'list'] as const,
};

export const languageQueries = {
  // 지원 언어는 배포 단위로만 바뀌므로 한 번 받으면 다시 받지 않는다
  list: () =>
    queryOptions({
      queryKey: languageQueryKeys.list(),
      queryFn: getLanguages,
      staleTime: Infinity,
    }),
};
