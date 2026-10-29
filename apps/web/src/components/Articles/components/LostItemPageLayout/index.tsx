import { useState } from 'react';
import { Link, useLocation, useRouter, useSearch } from '@tanstack/react-router';

import SearchIcon from 'assets/svg/Articles/search.svg';
import HotArticles from 'components/Articles/components/HotArticle';
import LostItemRouteButton from 'components/Articles/components/LostItemRouteButton';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';

import styles from './LostItemPageLayout.module.scss';

export default function LostItemPageLayout({ children }: { children: React.ReactNode }) {
  useScrollToTop();

  const router = useRouter();
  const routeLocation = useLocation();
  const routeSearch = useSearch({ strict: false });
  const isMobile = useMediaQuery();

  const keywordFromQuery = (Array.isArray(routeSearch.keyword) ? routeSearch.keyword[0] : routeSearch.keyword) ?? '';
  const [keyword, setKeyword] = useState(String(keywordFromQuery));

  const applySearch = () => {
    const next = keyword.trim();

    router.navigate({
      to: routeLocation.pathname,
      search: {
        ...routeSearch,
        keyword: next || undefined,
        page: '1',
      },
    });
  };

  return (
    <div className={styles['lost-item-template']}>
      <div className={styles['lost-item-content']}>
        <div className={styles.header}>
          <Link to={ROUTES.LostItems()}>
            <h1 className={styles.header__title}>분실물</h1>
          </Link>
        </div>

        <div className={styles.index}>
          <div className={styles['search-container']}>
            {!isMobile && <SearchIcon />}
            <input
              className={styles['search-container__input']}
              value={keyword}
              maxLength={100}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="검색어를 입력해주세요."
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySearch();
              }}
            />
            {isMobile && <SearchIcon />}
          </div>

          <div className={styles.index__rightButton}>
            <LostItemRouteButton />
          </div>
        </div>

        <div className={styles['list-scroll']}>{children}</div>
      </div>

      <div className={styles.aside}>
        <HotArticles />
      </div>
    </div>
  );
}
