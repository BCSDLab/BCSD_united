import React, { Suspense, useEffect, useRef } from 'react';
import { cn } from '@bcsdlab/utils';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeQueries, storeQueryKeys } from 'api/store/queries';
import { storeMobileQueries } from 'api/storeMobile/queries';
import EmptyImageIcon from 'assets/svg/empty-thumbnail.svg';
import Phone from 'assets/svg/Review/phone.svg';
import Copy from 'assets/svg/Store/copy.svg';
import StoreErrorBoundary from 'components/boundary/StoreErrorBoundary';
import Layout, { SSRLayout } from 'components/layout';
import ImageModal from 'components/modal/Modal/ImageModal';
import type { Portal } from 'components/modal/Modal/PortalProvider';
import StoreDetailMobilePage from 'components/Store/mobile/StoreDetailPage';
import EventTable from 'components/Store/StoreDetailPage/components/EventTable';
import MenuTable from 'components/Store/StoreDetailPage/components/MenuTable';
import ReviewPage from 'components/Store/StoreDetailPage/components/Review';
import UpdateInfo from 'components/Store/StoreDetailPage/components/UpdateInfo/UpdateInfo';
import ROUTES from 'static/routes';
import { useABTestView } from 'utils/hooks/abTest/useABTestView';
import useLogger from 'utils/hooks/analytics/useLogger';
import { useScrollLogging } from 'utils/hooks/analytics/useScrollLogging';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useModalPortal from 'utils/hooks/layout/useModalPortal';
import useParamsHandler from 'utils/hooks/routing/useParamsHandler';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';
import { copyToClipboard } from 'utils/ts/copyToClipboard';
import { isomorphicSessionStorage } from 'utils/ts/env';
import getDayOfWeek from 'utils/ts/getDayOfWeek';
import getElapsedSeconds from 'utils/ts/getElapsedSeconds';
import { isNotFoundKoinError } from 'utils/ts/isr';
import { parseQueryId } from 'utils/ts/parseServerSideParams';
import showToast from 'utils/ts/showToast';

import styles from 'pages/store/StoreDetailPage.module.scss';

const REVIEW_EXIT_LOG_VALUE: Record<string, string> = {
  메뉴: '메뉴',
  '이벤트/공지': '이벤트·공지',
};

interface Props {
  id: string;
}

// 기기·로그인 여부는 요청 스냅샷으로 확정한다. SSR은 요청별로 렌더하고, 브라우저 이동은 같은 쿼리 범위를 앱 캐시에 미리 받는다.
// 요청을 모르는 정적 생성은 항상 guest 범위로 프리페치해 캐시 상태에 따라 요청이 달라진다
function StoreDetailPage({ id }: Props) {
  const isMobile = useMediaQuery();
  const enterCategoryTimeRef = useRef<number | null>(null);
  const queryClient = useQueryClient();
  const isLoggedIn = useIsLoggedIn();
  const routeNavigate = useNavigate();
  const testValue = useABTestView('business_call');
  const logger = useLogger();
  // waterfall 현상 막기
  const { data: parallelData } = useSuspenseQuery({
    queryKey: storeQueryKeys.detailPage(id, isLoggedIn),
    queryFn: () =>
      Promise.all([
        queryClient.fetchQuery(storeQueries.detail(id)),
        queryClient.fetchQuery(storeQueries.detailMenu(id)),
        queryClient.fetchQuery(
          storeQueries.reviewList({
            shopId: Number(id),
            page: 1,
            sorter: 'LATEST',
            isLoggedIn,
          }),
        ),
      ]),
  });

  useEffect(() => {
    if (enterCategoryTimeRef.current === null) {
      const currentTime = new Date().getTime();
      isomorphicSessionStorage.setItem('enter_storeDetail', currentTime.toString());
      enterCategoryTimeRef.current = currentTime;
    }
  }, [logger, testValue]);
  const storeDetail = parallelData[0];
  const storeDescription = storeDetail?.description ? storeDetail?.description.replace(/(?:\/)/g, '\n') : '-';
  const storeMenus = parallelData[1];
  const reviews = parallelData[2];
  const storeMenuCategories = storeMenus ? storeMenus.menu_categories : null;
  const { searchParams, setParams } = useParamsHandler();
  const tapType = searchParams.get('state') ?? '메뉴';
  const portalManager = useModalPortal();
  const onClickCallNumber = () => {
    if (searchParams.get('state') === '리뷰' && isomorphicSessionStorage.getItem('enterReviewPage')) {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'shop__shop_detail__navigation__review_exit__click',
        value: '전화',
        previous_page: '리뷰',
        current_page: '전화',
        duration_time: getElapsedSeconds('enterReviewPage'),
      });
    }
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_detail__contact__phone__click',
      value: storeDetail.name,
      duration_time: getElapsedSeconds('enter_storeDetail'),
    });
  };

  const onClickImage = (img: string[], index: number) => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_detail__photo_view__open__click',
      value: storeDetail.name,
    });
    portalManager.open((portalOption: Portal) => (
      <ImageModal imageList={img} imageIndex={index} onClose={portalOption.close} />
    ));
  };
  const onClickList = () => {
    if (searchParams.get('state') === '리뷰' && isomorphicSessionStorage.getItem('enterReviewPage')) {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'shop__shop_detail__navigation__review_exit__click',
        value: '상점 목록',
        previous_page: '리뷰',
        current_page: '전체보기',
        duration_time: getElapsedSeconds('enterReviewPage'),
      });
    }
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_detail__navigation__back__click',
      value: '상점목록',
      current_page: isomorphicSessionStorage.getItem('cameFrom') || '전체보기',
      duration_time: getElapsedSeconds('enter_storeDetail'),
    });
  };
  const onClickEventList = () => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_detail__shop_event__entry__click',
      value: `${storeDetail.name}`,
    });
  };
  const onClickReviewList = () => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_detail__shop_review__entry__click',
      value: `${storeDetail.name}`,
    });
  };
  const copyAccount = async (account: string) => {
    await copyToClipboard(account);
    showToast('info', '계좌번호가 복사되었습니다.');
  };

  const detailScrollLogging = () => {
    if (searchParams.get('state') === '메뉴' || !searchParams.get('state')) {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'shop__shop_detail__shop_menu__scroll',
        value: storeDetail.name,
        event_category: 'scroll',
      });
    }
    if (searchParams.get('state') === '이벤트/공지') {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'shop__shop_detail__shop_event__scroll',
        value: storeDetail.name,
        event_category: 'scroll',
      });
    }
    if (searchParams.get('state') === '리뷰') {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'shop__shop_detail__shop_review__scroll',
        value: storeDetail.name,
        event_category: 'scroll',
      });
    }
  };

  useScrollToTop();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 언마운트 시 1회만 정리 (portalManager 참조 변경은 무시)
  React.useEffect(() => () => portalManager.close(), []);
  useScrollLogging(detailScrollLogging);

  React.useEffect(() => {
    if (searchParams.get('state') !== '리뷰') {
      if (isomorphicSessionStorage.getItem('enterReviewPage')) {
        logger.actionEventClick({
          event_name: 'DA1',
          event_label: 'shop__shop_detail__navigation__review_exit__click',
          value: REVIEW_EXIT_LOG_VALUE[searchParams.get('state') ?? '메뉴'] ?? searchParams.get('state') ?? '메뉴',
          previous_page: '리뷰',
          current_page: searchParams.get('state') || '메뉴',
          duration_time: getElapsedSeconds('enterReviewPage'),
        });
        isomorphicSessionStorage.removeItem('enterReviewPage');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- param이 바뀌어도 버튼이 적용되어야 함 (logger는 안정적)
  }, [searchParams, storeDetail]);

  useEffect(
    () => {
      const handlePopState = () => {
        logger.actionEventClick({
          event_name: 'DA1',
          event_label: 'shop__shop_detail__navigation__back__click',
          value: '스와이프',
          current_page: isomorphicSessionStorage.getItem('cameFrom') || '전체보기',
          duration_time: getElapsedSeconds('enter_storeDetail'),
        });
      };
      window.addEventListener('popstate', handlePopState);

      return () => {
        isomorphicSessionStorage.removeItem('enterReviewPage');
        window.removeEventListener('popstate', handlePopState);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만 리스너 등록
    [],
  );

  return (
    <div className={styles.template}>
      <div className={styles.section}>
        {!isMobile && (
          <div className={styles.section__header}>
            <button
              className={styles['section__header--button']}
              aria-label="주변 상점 리스트 이동"
              type="button"
              onClick={() => routeNavigate({ href: ROUTES.Store() })}
            >
              주변 상점
            </button>
            {storeDetail?.updated_at && <UpdateInfo date={storeDetail.updated_at} />}
          </div>
        )}
        <div className={styles['section__store-info']}>
          {storeDetail && (
            <div className={styles.store}>
              <div className={styles.store__name}>{storeDetail?.name}</div>
              <div className={styles.store__detail}>
                <span>전화번호</span>
                {isMobile && (testValue === 'call_number' || testValue === 'default') ? (
                  <a
                    role="button"
                    aria-label="상점 전화하기"
                    href={`tel:${storeDetail?.phone}`}
                    onClick={onClickCallNumber}
                    className={styles['store__detail--phone']}
                  >
                    <div className={styles['store__detail--number']}>
                      {storeDetail?.phone}{' '}
                      <div>
                        <Phone />
                      </div>
                    </div>
                  </a>
                ) : (
                  storeDetail?.phone
                )}
                <br />
                <span>운영시간</span>
                {storeDetail.open[getDayOfWeek()] && storeDetail?.open
                  ? `${storeDetail?.open[getDayOfWeek()].open_time} ~ ${storeDetail?.open[getDayOfWeek()].close_time}`
                  : '-'}
                <br />
                <span>주소정보</span>
                {storeDetail?.address}
                <br />
                <span>배달요금</span>
                {storeDetail?.delivery_price.toLocaleString()}
                원
                <br />
                {storeDetail.bank && storeDetail.account_number && (
                  <>
                    <span>계좌번호</span>
                    <div className={styles.account}>
                      {`${storeDetail.bank} ${storeDetail.account_number}`}
                      <button
                        type="button"
                        onClick={() => copyAccount(`${storeDetail.bank} ${storeDetail.account_number}`)}
                        aria-label="계좌번호 복사"
                      >
                        <Copy />
                      </button>
                    </div>
                    <br />
                  </>
                )}
                <div className={styles.etc}>
                  <span>기타정보</span>
                  <div className={styles.etc__content}>{storeDescription}</div>
                </div>
              </div>
              <div>
                <span
                  className={cn({
                    [styles.store__tags]: true,
                    [styles['store__tags--active']]: storeDetail?.delivery,
                  })}
                >
                  #배달가능
                </span>
                <span
                  className={cn({
                    [styles.store__tags]: true,
                    [styles['store__tags--active']]: storeDetail?.pay_card,
                  })}
                >
                  #카드가능
                </span>
                <span
                  className={cn({
                    [styles.store__tags]: true,
                    [styles['store__tags--active']]: storeDetail?.pay_bank,
                  })}
                >
                  #계좌이체가능
                </span>
              </div>
              <div className={styles['button-wrapper']}>
                <button
                  className={cn({
                    [styles['button-wrapper__button']]: true,
                    [styles['button-wrapper__button--store-list']]: true,
                  })}
                  aria-label="상점 목록 이동"
                  type="button"
                  onClick={() => {
                    onClickList();
                    routeNavigate({ href: ROUTES.Store() });
                  }}
                >
                  상점목록
                </button>
              </div>
              {isMobile && storeDetail?.updated_at && <UpdateInfo date={storeDetail.updated_at} />}
            </div>
          )}
          <div
            className={cn({
              [styles.image]: true,
              [styles['image--none']]: storeDetail?.image_urls.length === 0,
            })}
          >
            {storeDetail?.image_urls && storeDetail.image_urls.length > 0 ? (
              storeDetail.image_urls.map((img, index) => (
                <div key={img} className={styles.image__content}>
                  <button
                    className={styles.image__button}
                    aria-label="이미지 확대"
                    type="button"
                    onClick={() => onClickImage(storeDetail.image_urls, index)}
                  >
                    <img
                      className={styles.image__poster}
                      src={img}
                      alt="상점이미지"
                      width={320}
                      height={360}
                      fetchPriority="high"
                    />
                  </button>
                </div>
              ))
            ) : (
              <div className={styles['empty-image']}>
                <div>
                  <EmptyImageIcon />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className={styles.tap}>
          <button
            className={cn({
              [styles.tap__type]: true,
              [styles['tap__type--active']]: tapType === '메뉴',
            })}
            type="button"
            onClick={() => {
              setParams({ state: '메뉴' }, { replacePage: true });
              logger.actionEventClick({
                event_name: 'DA1',
                event_label: 'shop__shop_detail__shop_menu__entry__click',
                value: storeDetail.name,
              });
            }}
          >
            메뉴
          </button>
          <button
            className={cn({
              [styles.tap__type]: true,
              [styles['tap__type--active']]: tapType === '이벤트/공지',
            })}
            type="button"
            onClick={() => {
              onClickEventList();
              setParams({ state: '이벤트/공지' }, { replacePage: true });
            }}
          >
            이벤트/공지
          </button>
          <button
            className={cn({
              [styles.tap__type]: true,
              [styles['tap__type--active']]: tapType === '리뷰',
            })}
            type="button"
            onClick={() => {
              onClickReviewList();
              setParams({ state: '리뷰' }, { replacePage: true });
            }}
          >
            리뷰 {`(${reviews.total_count})`}
          </button>
        </div>
        {tapType === '메뉴' && storeMenuCategories && storeMenuCategories.length > 0 && (
          <MenuTable storeMenuCategories={storeMenuCategories} onClickImage={onClickImage} />
        )}
        {tapType === '이벤트/공지' && <EventTable id={id} />}
        {tapType === '리뷰' && <ReviewPage id={id} />}
      </div>
      {testValue === 'call_floating' && (
        <a
          role="button"
          aria-label="상점 전화하기"
          href={`tel:${storeDetail?.phone}`}
          onClick={onClickCallNumber}
          className={styles['phone-button--floating']}
        >
          <Phone />
        </a>
      )}
    </div>
  );
}

interface StoreDetailProps {
  id: string;
  isMobilePage?: boolean;
}

function StoreDetail({ id, isMobilePage }: StoreDetailProps) {
  const routeNavigate = useNavigate();

  if (isMobilePage) {
    return <StoreDetailMobilePage id={id} />;
  }

  return (
    <StoreErrorBoundary onErrorClick={() => routeNavigate({ href: ROUTES.Store() })}>
      <Suspense fallback={<div />}>
        <StoreDetailPage id={id} />
      </Suspense>
    </StoreErrorBoundary>
  );
}

const loadPage = definePageLoad(async ({ params, queryClient }, cacheControl, serverRequest) => {
  const { isLoggedIn } = serverRequest;

  const storeId = params.id;
  if (parseQueryId(storeId) === null) {
    throw notFound();
  }

  // 모바일은 KOIN_ORDER_WEBVIEW 상점 상세 화면을 그린다. order가 부르는 API(요약·v2 상세·메뉴·이벤트)만 미리 받아 본문까지 렌더한다
  if (serverRequest.device === 'mobile') {
    try {
      await Promise.all([
        queryClient.fetchQuery(storeMobileQueries.summary(storeId)),
        queryClient.fetchQuery(storeMobileQueries.detail(storeId)),
        queryClient.fetchQuery(storeMobileQueries.menus(storeId)),
        queryClient.fetchQuery(storeMobileQueries.events(storeId)),
      ]);
    } catch (error) {
      if (isNotFoundKoinError(error)) {
        throw notFound();
      }
      throw error;
    }

    cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

    return {
      isMobilePage: true,
      id: storeId,
    };
  }

  try {
    await Promise.all([
      queryClient.fetchQuery(storeQueries.detail(storeId)),
      queryClient.fetchQuery(storeQueries.detailMenu(storeId)),
      // 리뷰 요청에는 쿠키가 실린다. 만료·무효 access 쿠키로 실패해도 페이지는 그리고 갱신 후 다시 받는다(prefetchQuery는 오류를 삼킨다)
      queryClient.prefetchQuery(
        storeQueries.reviewList({
          shopId: Number(storeId),
          page: 1,
          sorter: 'LATEST',
          isLoggedIn,
        }),
      ),
      // 이벤트/공지 탭 데이터는 부가 정보이므로 실패해도 페이지 렌더를 막지 않도록 오류를 여기서 삼킨다
      queryClient.fetchQuery(storeQueries.eventList(storeId)).catch((error: unknown) => {
        console.error(`Failed to prefetch optional store events for ${storeId}:`, error);
      }),
    ]);
  } catch (error) {
    if (isNotFoundKoinError(error)) {
      throw notFound();
    }
    throw error;
  }

  cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

  return {
    id: storeId,
  };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/store/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

// 기기는 서버가 확정한다. 모바일은 상세 전용 오버레이 헤더를 본문에서 그리므로 페이지 헤더 레이아웃을 쓰고, 데스크톱은 기본 레이아웃 그대로 둔다
function RouteComponent() {
  const loaderData = Route.useLoaderData();
  const page = <StoreDetail {...loaderData} />;

  return loaderData.serverRequest.device === 'mobile' ? (
    <SSRLayout mobileHeader="page">{page}</SSRLayout>
  ) : (
    <Layout>{page}</Layout>
  );
}
