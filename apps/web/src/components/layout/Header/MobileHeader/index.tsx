import { createPortal } from 'react-dom';
import { cn } from '@bcsdlab/utils';
import { useRouter, useLocation, useParams } from '@tanstack/react-router';

import { getStoreDetailInfo } from 'api/store';
import BlackArrowBackIcon from 'assets/svg/black-arrow-back-icon.svg';
import HamburgerIcon from 'assets/svg/hamburger-icon.svg';
import KoinServiceLogo from 'assets/svg/koin-service-logo.svg';
import ArrowBackIcon from 'assets/svg/white-arrow-back-icon.svg';
import { CATEGORY } from 'static/category';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useGoBack from 'utils/hooks/routing/useGoBack';
import useParamsHandler from 'utils/hooks/routing/useParamsHandler';
import useMount from 'utils/hooks/state/useMount';
import { isomorphicSessionStorage } from 'utils/ts/env';
import getElapsedSeconds from 'utils/ts/getElapsedSeconds';
import { backButtonTapped } from 'utils/ts/iosBridge';
import { useMobileSidebar } from 'utils/zustand/mobileSidebar';

import type { LegacyRoute } from './legacyRoute';
import Panel from './Panel';
import styles from './MobileHeader.module.scss';

interface MobileHeaderProps {
  openModal: () => void;
  route: LegacyRoute;
}

export default function MobileHeader({ openModal, route }: MobileHeaderProps) {
  const mounted = useMount();
  const router = useRouter();
  const routeLocation = useLocation();
  const routeParams = useParams({ strict: false });
  const goBack = useGoBack();
  const { pathname } = routeLocation;
  const { openSidebar } = useMobileSidebar();
  const logger = useLogger();
  const { id } = routeParams;

  const { params } = useParamsHandler();

  const backInDetailPage = async () => {
    if (pathname.includes(ROUTES.Store()) && id) {
      const response = await getStoreDetailInfo(Array.isArray(id) ? id[0] : id);
      logger.actionEventClick({
        team: 'BUSINESS',
        event_label: 'shop_detail_view_back',
        value: response.name,
        current_page: isomorphicSessionStorage.getItem('cameFrom') || '',
        duration_time: getElapsedSeconds('enter_storeDetail'),
      }); // 상점 내 뒤로가기 버튼 로깅
      router.history.back();

      return;
    }
    if (
      typeof window !== 'undefined' &&
      window.webkit?.messageHandlers != null &&
      (pathname === ROUTES.Club() || params.hot === 'true')
    ) {
      backButtonTapped();

      return;
    }
    goBack();
  };

  const handleHamburgerClick = () => {
    openSidebar();
  };

  const { isMain, isClub: isClubRoute, isLight: useLightHeader } = route;

  return (
    <>
      <div className={styles.mobileheader}>
        {!isMain && (
          <button
            className={cn({
              [styles.mobileheader__icon]: true,
              [styles['mobileheader__icon--left']]: true,
            })}
            type="button"
            aria-label="뒤로가기 버튼"
            onClick={() => {
              backInDetailPage();
            }}
          >
            {useLightHeader ? <BlackArrowBackIcon /> : <ArrowBackIcon />}
          </button>
        )}
        <span
          className={cn({
            [styles.mobileheader__title]: true,
            [styles['mobileheader__title--main']]: isMain,
            [styles['mobileheader__title--light']]: useLightHeader,
          })}
        >
          {isMain && <KoinServiceLogo />}
          {!isMain &&
            !isClubRoute &&
            (CATEGORY.flatMap((c) => c.submenu)
              .filter((s) => pathname.startsWith(s.link))
              .sort((a, b) => b.link.length - a.link.length)[0]?.title ??
              '')}
          {pathname.startsWith(ROUTES.NewClub()) && '동아리 생성'}
          {pathname.startsWith('/clubs/edit') && '동아리 수정'}
          {pathname.startsWith('/clubs/recruitment/edit') && '동아리 모집 수정'}
          {pathname.startsWith('/clubs/recruitment') &&
            !pathname.startsWith('/clubs/recruitment/edit') &&
            '동아리 모집 생성'}
          {pathname.startsWith('/clubs/event/edit') && '동아리 행사 수정'}
          {pathname.startsWith('/clubs/event') && !pathname.startsWith('/clubs/event/edit') && '동아리 행사 생성'}
        </span>
        <button
          className={cn({
            [styles.mobileheader__icon]: true,
            [styles['mobileheader__icon--right']]: true,
            [styles['mobileheader__icon--none']]: useLightHeader,
          })}
          type="button"
          aria-label="메뉴 버튼"
          onClick={handleHamburgerClick}
        >
          <HamburgerIcon />
        </button>
      </div>
      {mounted && createPortal(<Panel openModal={openModal} />, document.body)}
    </>
  );
}
