import { useState } from 'react';
import { useRouter, useLocation, useSearch } from '@tanstack/react-router';

import { useDebounce } from 'utils/hooks/debounce/useDebounce';

const SEARCH_DEBOUNCE_MS = 300;

const getKeyword = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

// 검색어는 URL(`?keyword=`)이 단일 출처이고, 입력창 값만 따로 둔다
export default function useKeywordSearch() {
  const router = useRouter();
  const routeLocation = useLocation();
  const routeSearch = useSearch({ strict: false });
  const keyword = getKeyword(routeSearch.keyword);
  const [searchValue, setSearchValue] = useState(keyword);

  const replaceKeyword = useDebounce((value: string) => {
    const nextQuery = { ...routeSearch };
    if (value) {
      nextQuery.keyword = value;
    } else {
      delete nextQuery.keyword;
    }

    router.navigate({ to: routeLocation.pathname, search: nextQuery, replace: true, resetScroll: false });
  }, SEARCH_DEBOUNCE_MS);

  const changeSearchValue = (value: string) => {
    setSearchValue(value);
    replaceKeyword(value.trim());
  };

  return { searchValue, keyword, changeSearchValue };
}
