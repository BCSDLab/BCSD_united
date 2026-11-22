import { useRef, useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import SearchIcon from 'assets/svg/Articles/search.svg';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { MobileOnlyPage } from 'components/layout/ResponsivePage';
import HeaderIconButton from 'components/ui/PageHeader/HeaderIconButton';
import SearchBar from 'components/ui/SearchBar';
import ROUTES from 'static/routes';
import { isMobileView } from 'utils/hooks/layout/useMobileView';
import useGoBack from 'utils/hooks/routing/useGoBack';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

import styles from 'pages/room/search/RoomSearchPage.module.scss';

function RoomSearchPage() {
  const [searchValue, setSearchValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const goBack = useGoBack();

  return (
    <>
      <MobilePageHeader
        title="복덕방"
        className={styles.header}
        onBack={() => goBack(ROUTES.Room())}
        rightAction={
          <HeaderIconButton
            className={styles['search-action']}
            aria-label="검색창으로 이동"
            onClick={() => inputRef.current?.focus()}
          >
            <SearchIcon aria-hidden />
          </HeaderIconButton>
        }
      />
      <main className={styles.content}>
        <SearchBar
          value={searchValue}
          onChange={setSearchValue}
          inputRef={inputRef}
          className={styles.input}
          size="small"
          clearable
          label="건물명 검색"
          placeholder="건물 명을 입력해주세요."
        />
      </main>
    </>
  );
}

const loadPage = definePageLoad((_context, cacheControl, serverRequest) => {
  if (!isMobileView(serverRequest.device)) throw redirect({ href: ROUTES.Room(), statusCode: 302 });
  cacheControl.enablePublicCache();

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/room/search/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const { serverRequest } = Route.useLoaderData();

  return (
    <MobileOnlyPage device={serverRequest.device} desktopHref={ROUTES.Room()} className={styles.layout}>
      <RoomSearchPage />
    </MobileOnlyPage>
  );
}
