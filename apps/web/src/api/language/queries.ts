import { queryOptions } from '@tanstack/react-query';

import type { PolicyType } from './entity';
import { getLanguages, getPolicy } from './index';

export const languageQueryKeys = {
  all: ['language'] as const,
  list: () => [...languageQueryKeys.all, 'list'] as const,
  policy: (type: PolicyType, language: string) => [...languageQueryKeys.all, 'policy', type, language] as const,
};

// 지원 언어와 약관은 한 화면을 보는 동안 바뀌지 않으므로, 한 번 받으면 새로고침 전까지 다시 받지 않는다
export const languageQueries = {
  list: () =>
    queryOptions({
      queryKey: languageQueryKeys.list(),
      queryFn: getLanguages,
      staleTime: Infinity,
    }),

  policy: (type: PolicyType, language: string) =>
    queryOptions({
      queryKey: languageQueryKeys.policy(type, language),
      queryFn: () => getPolicy(type, language),
      staleTime: Infinity,
    }),
};
