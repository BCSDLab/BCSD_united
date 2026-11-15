import { Suspense, useState, useEffect, useRef } from 'react';
import { cn } from '@bcsdlab/utils';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useSearch, useParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import type { StoreSorterType, StoreFilterType, StoreCategory } from 'api/store/entity';
import { storeQueries } from 'api/store/queries';
import { storeMobileQueries } from 'api/storeMobile/queries';
import Close from 'assets/svg/close-icon-20x20.svg';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import StoreListPage from 'components/Store/mobile/StoreListPage';
import { getListRequestParams, parseListQuery } from 'components/Store/mobile/StoreListPage/utils/listQuery';
import DesktopStoreList from 'components/Store/StorePage/components/DesktopStoreList';
import EventCarousel from 'components/Store/StorePage/components/EventCarousel';
import SearchBarModal from 'components/Store/StorePage/components/SearchBarModal';
import { getCategoryDurationTime, initializeCategoryEntryTime } from 'components/Store/utils/durationTime';
import ROUTES from 'static/routes';
import { STORE_PAGE } from 'static/store';
import useLogger from 'utils/hooks/analytics/useLogger';
import { useScrollLogging } from 'utils/hooks/analytics/useScrollLogging';
import useMobileView, { isMobileView } from 'utils/hooks/layout/useMobileView';
import useBooleanState from 'utils/hooks/state/useBooleanState';
import { useLocalStorage } from 'utils/hooks/state/useLocalStorage';
import useMount from 'utils/hooks/state/useMount';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';
import { isomorphicLocalStorage, isomorphicSessionStorage } from 'utils/ts/env';

import styles from 'pages/store/StorePage.module.scss';

interface StoreSearchQueryType {
  storeName?: string;
  category?: string;
  delivery?: string;
  bank?: string;
  card?: string;
  shopIds?: string;
}

const SORT_CHECK_BOX = [
  {
    id: 'COUNT',
    content: '리뷰순',
  },
  {
    id: 'RATING',
    content: '별점순',
  },
] as const;

const FILTER_CHECK_BOX = [
  {
    id: 'OPEN',
    content: '영업중',
  },
  {
    id: 'DELIVERY',
    content: '배달 가능',
  },
] as const;

const TOGGLE_LOG_VALUE = {
  COUNT: '리뷰',
  RATING: '별점',
  OPEN: '영업중',
  DELIVERY: '배달',
} as const;

const useStoreList = (sorter: StoreSorterType, filter: StoreFilterType[], params: StoreSearchQueryType) => {
  const selectedCategory = Number(params.category);

  const { data: storeList } = useQuery({
    ...storeQueries.listV2({
      sorter,
      filter,
      query: params.storeName,
    }),
    placeholderData: (previousData) => previousData,
    select: (data) => {
      if (!data || !data.shops) return [];

      if (params.category === undefined) {
        return data.shops;
      }

      return data.shops.filter((store) => store.category_ids.some((id) => id === selectedCategory));
    },
  });

  return storeList || [];
};

function Store() {
  const enterCategoryTimeRef = useRef<number | null>(null);
  const [storeSorter, setStoreSorter] = useState<StoreSorterType>('NONE');
  const [storeFilterList, setStoreFilterList] = useState<Record<StoreFilterType, boolean>>({
    OPEN: false,
    DELIVERY: false,
  });

  const routeNavigate = useNavigate();
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const logger = useLogger();
  const [localStorageValue] = useLocalStorage('store-review-tooltip', null);
  const [isTooltipOpen, , closeTooltip] = useBooleanState(localStorageValue === null);
  const isMounted = useMount();

  const filteredTypeList = Object.entries(storeFilterList)
    .filter(([, value]) => value)
    .map(([key]) => key as StoreFilterType);
  const { data: categories } = useSuspenseQuery(storeQueries.categories());
  const storeList = useStoreList(storeSorter, filteredTypeList, routeQuery);

  const selectedCategory = routeQuery.category ? Number(routeQuery.category) : -1;

  const handleTooltipCloseButtonClick = () => {
    isomorphicLocalStorage.setItem('store-review-tooltip', 'used');
    closeTooltip();
  };

  const handleCategoryClick = (category: StoreCategory) => {
    const { id: categoryId } = category;
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_list__filter__category__click',
      value: category.name,
      previous_page: categories.shop_categories.find((item) => item.id === selectedCategory)?.name || '전체보기',
      duration_time: getCategoryDurationTime(),
      current_page: categoryId.toString(),
    });

    initializeCategoryEntryTime();

    routeNavigate({ to: ROUTES.Store(), search: { ...routeQuery, category: String(categoryId) } });
  };

  const handleSortCheckBox = (type: StoreSorterType) => () => {
    setStoreSorter((prevSorter) => (prevSorter === type ? 'NONE' : type));

    if (type === 'COUNT' || type === 'RATING') {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'shop__shop_list__filter__checkbox__select',
        value: TOGGLE_LOG_VALUE[type],
        event_category: 'select',
      });
    }
  };

  const handleFilterCheckBox = (type: StoreFilterType) => () => {
    setStoreFilterList((prevFilterList) => ({ ...prevFilterList, [type]: !prevFilterList[type] }));

    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_list__filter__checkbox__select',
      value: TOGGLE_LOG_VALUE[type],
      event_category: 'select',
    });
  };

  const storeScrollLogging = () => {
    const currentCategoryId = selectedCategory;

    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_list__shop_list__scroll',
      value: categories.shop_categories[currentCategoryId]?.name || '전체보기',
      event_category: 'scroll',
    });
  };

  useScrollToTop();
  useScrollLogging(storeScrollLogging);
  useEffect(() => {
    if (enterCategoryTimeRef.current === null) {
      const currentTime = new Date().getTime();
      initializeCategoryEntryTime();
      enterCategoryTimeRef.current = currentTime;
    }
    isomorphicSessionStorage.setItem('cameFrom', categories.shop_categories[selectedCategory]?.name || '전체보기');
  }, [categories, selectedCategory]);

  const handleBenefitClick = () => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_list__shop_benefit__entry__click',
      value: '혜택이 있는 상점 모아보기',
      previous_page: categories.shop_categories.find((item) => item.id === selectedCategory)?.name || '전체보기',
      duration_time: getCategoryDurationTime(),
      current_page: 'benefit',
    });

    routeNavigate({ href: `${ROUTES.BenefitStore()}?category=1` });
  };

  return (
    <div className={styles.section}>
      <div className={styles.header}>주변 상점</div>
      <div className={styles.category}>
        <div className={styles.category__header}>CATEGORY</div>
        <div className={styles.category__wrapper}>
          {categories.shop_categories.slice(0, 12).map((category) => (
            <button
              className={cn({
                [styles.category__menu]: true,
                [styles['category__menu--selected']]: category.id === selectedCategory,
              })}
              role="radio"
              aria-checked={category.id === selectedCategory}
              type="button"
              onClick={() => handleCategoryClick(category)}
              key={category.id}
            >
              <img
                className={styles.category__image}
                src={category.image_url}
                alt="category_img"
                width={50}
                height={50}
              />
              <span>{category.name}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={handleBenefitClick} className={styles.category__benefit}>
          혜택이 있는 상점 모아보기
        </button>
      </div>
      <SearchBarModal onClose={() => {}} />
      <div className={styles.option}>
        {routeQuery.storeName ? (
          <div className={styles.option__count}>
            <strong>{`"${routeQuery.storeName}" 관련 가게가 총 ${storeList.length}개 있습니다.`}</strong>
          </div>
        ) : (
          <div className={styles.option__count}>
            총
            <strong>
              {storeList.length}
              개의 업체가
            </strong>
            있습니다.
          </div>
        )}

        <div className={styles.option__checkbox}>
          {SORT_CHECK_BOX.map(({ id, content }) => (
            <div key={id} className={styles['option-checkbox']}>
              <label htmlFor={id} className={styles['option-checkbox__label']}>
                <input
                  id={id}
                  type="checkbox"
                  checked={storeSorter === id}
                  className={styles['option-checkbox__input']}
                  onChange={handleSortCheckBox(id)}
                />
                {content}
              </label>
            </div>
          ))}
          {FILTER_CHECK_BOX.map(({ id, content }) => (
            <div key={id} className={styles['option-checkbox']}>
              <label htmlFor={id} className={styles['option-checkbox__label']}>
                <input
                  id={id}
                  type="checkbox"
                  checked={storeFilterList[id]}
                  className={styles['option-checkbox__input']}
                  onChange={handleFilterCheckBox(id)}
                />
                {content}
              </label>
            </div>
          ))}
          {isMounted && isTooltipOpen && (
            <div className={styles.tooltip}>
              <div className={styles.tooltip__content}>지금 리뷰가 가장 많은 상점을 확인해보세요!</div>
              <button
                type="button"
                aria-label="리뷰 툴팁 닫기"
                className={styles.tooltip__close}
                onClick={handleTooltipCloseButtonClick}
              >
                <Close />
              </button>
            </div>
          )}
        </div>
      </div>
      <EventCarousel />
      <DesktopStoreList storeListData={storeList} storeType={STORE_PAGE.MAIN} />
    </div>
  );
}

interface StorePageProps {
  showMobile: boolean;
}

// 데스크톱 창을 모바일 폭으로 줄이면 데이터를 미리 받지 않은 모바일 화면으로 바뀌므로 Suspense로 감싼다
function StorePage({ showMobile }: StorePageProps) {
  if (showMobile) {
    return (
      <>
        <MobilePageHeader background="gray" title="주변상점" />
        <Suspense fallback={null}>
          <StoreListPage />
        </Suspense>
      </>
    );
  }

  return (
    <Suspense fallback={null}>
      <Store />
    </Suspense>
  );
}

const loadPage = definePageLoad(async ({ search, queryClient }, cacheControl, serverRequest) => {
  // 모바일 화면은 KOIN_ORDER_WEBVIEW 주변상점 화면을 그린다. order가 부르는 API(카테고리·v3 목록)만 미리 받아 본문까지 렌더한다
  if (isMobileView(serverRequest.device)) {
    const { sort, filter } = parseListQuery(search);
    const { sorter, filter: listFilter } = getListRequestParams(sort, filter);

    await Promise.all([
      queryClient.prefetchQuery(storeMobileQueries.categories()),
      queryClient.prefetchQuery(storeMobileQueries.list(sorter, listFilter)),
    ]);

    cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

    return {};
  }

  const { storeName } = search;
  const selectedStoreName = storeName ? String(storeName) : undefined;

  await Promise.all([
    queryClient.prefetchQuery(storeQueries.categories()),
    queryClient.prefetchQuery(
      storeQueries.listV2({
        sorter: 'NONE',
        filter: [],
        query: selectedStoreName,
      }),
    ),
    queryClient.prefetchQuery(storeQueries.allEvents()),
  ]);

  cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

// 정렬·필터·카테고리·검색어는 화면이 클라이언트 쿼리로 처리한다. 진입 시에만 현재 주소로 미리 받는다.
// search만 바뀌면 loader를 다시 실행하지 않고 StoreListPage가 낙관적 상태로 선택을 즉시 반영한다.
export const Route = createFileRoute('/store/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loader: ({ params, location, context }) => pageLoader({ params, search: location.search }, context),
  component: RouteComponent,
});

// 모바일 기기이거나 창이 모바일 폭이면 모바일 화면을 그린다(useMobileView). 페이지 헤더 레이아웃은 모바일 폭에서만 적용되므로 데스크톱 폭에서는 기본 헤더가 그대로 보인다
function RouteComponent() {
  const { serverRequest } = Route.useLoaderData();
  const showMobile = useMobileView(serverRequest.device);

  return (
    <SSRLayout mobileHeader="page">
      <StorePage showMobile={showMobile} />
    </SSRLayout>
  );
}
