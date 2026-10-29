import { useMemo, useCallback } from 'react';
import { useLocation, useRouter, useParams, useSearch } from '@tanstack/react-router';

import { stringifySearch } from 'utils/routing/search';

const useParamsHandler = () => {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeParams = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const searchParams = useMemo(() => {
    const values = new URLSearchParams();
    Object.entries(search).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => values.append(key, item));
      } else if (value !== undefined) {
        values.set(key, value);
      }
    });

    return values;
  }, [search]);
  const params = useMemo(() => {
    const values: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      if (!(key in values)) values[key] = value;
    });

    return { ...values, ...routeParams } as Record<string, string>;
  }, [routeParams, searchParams]);

  const setParams = useCallback(
    (
      newParams: Record<string, string | undefined>,
      option: { deleteBeforeParam?: boolean; replacePage?: boolean } = {},
    ) => {
      const next = { ...search };
      Object.entries(newParams).forEach(([key, value]) => {
        if (value === undefined) delete next[key];
        else next[key] = value;
      });

      return router.navigate({
        href: pathname + stringifySearch(next),
        replace: option.replacePage ?? false,
        resetScroll: false,
      });
    },
    [router, pathname, search],
  );

  return { params, searchParams, setParams };
};

export default useParamsHandler;
