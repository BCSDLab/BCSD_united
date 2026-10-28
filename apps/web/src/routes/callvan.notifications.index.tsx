import { createFileRoute, useNavigate, useRouter, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { useEffect, useState } from 'react';



import { dehydrate, QueryClient, useQuery } from '@tanstack/react-query';
import { callvanQueries, callvanQueryKeys } from 'api/callvan/queries';
import ArrowBackIcon from 'assets/svg/Callvan/arrow-back.svg';
import ThreeDotsIcon from 'assets/svg/Callvan/three-dots.svg';
import DeleteConfirmModal from 'components/Callvan/components/DeleteConfirmModal';
import NotificationCard from 'components/Callvan/components/NotificationCard';
import NotificationDropdown from 'components/Callvan/components/NotificationDropdown';
import NotificationEmptyState from 'components/Callvan/components/NotificationEmptyState';
import useDeleteAllNotifications from 'components/Callvan/hooks/useDeleteAllNotifications';
import useMarkAllNotificationsRead from 'components/Callvan/hooks/useMarkAllNotificationsRead';
import useMarkNotificationRead from 'components/Callvan/hooks/useMarkNotificationRead';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useMount from 'utils/hooks/state/useMount';


import styles from 'pages/callvan/notifications/CallvanNotifications.module.scss';



export default function CallvanNotificationsPage() {
  const router = useRouter();
  const routeNavigate = useNavigate();
  
  
  const isMobile = useMediaQuery();
  const mounted = useMount();
  const isLoggedIn = useIsLoggedIn();

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  useEffect(() => {
    if (mounted && !isMobile) {
      routeNavigate({ href: ROUTES.Main(), replace: true });
    }
  }, [mounted, isMobile, routeNavigate]);

  const { data: notifications } = useQuery({
    ...callvanQueries.notifications(isLoggedIn),
    enabled: isLoggedIn,
  });
  const { mutate: markAllRead } = useMarkAllNotificationsRead();
  const { mutate: markRead } = useMarkNotificationRead();
  const { mutate: deleteAll } = useDeleteAllNotifications({
    onSuccess: () => setIsDeleteModalOpen(false),
  });

  const handleCardClick = (id: number, isRead: boolean) => {
    if (isRead) return;
    markRead(id);
  };

  const isResolved = notifications !== undefined;
  const hasNotifications = isResolved && notifications.length > 0;

  return (
    <div className={styles['notification-page']}>
      <div className={styles['notification-page__header']}>
        <button
          type="button"
          className={styles['notification-page__back-button']}
          onClick={() => router.history.back()}
          aria-label="뒤로가기"
        >
          <ArrowBackIcon />
        </button>
        <h1 className={styles['notification-page__title']}>알림</h1>
        {hasNotifications ? (
          <div className={styles['notification-page__menu-wrapper']}>
            <button
              type="button"
              className={styles['notification-page__menu-button']}
              onClick={() => setIsDropdownOpen((prev) => !prev)}
              aria-label="더보기"
            >
              <ThreeDotsIcon />
            </button>
            {isDropdownOpen && (
              <NotificationDropdown
                onMarkAllRead={() => markAllRead()}
                onDeleteAll={() => setIsDeleteModalOpen(true)}
                onClose={() => setIsDropdownOpen(false)}
              />
            )}
          </div>
        ) : (
          <div className={styles['notification-page__empty-space']} />
        )}
      </div>

      <div className={styles['notification-page__content']}>
        {isResolved &&
          (hasNotifications ? (
            <div className={styles['notification-page__list']}>
              {notifications.map((notification, index) => (
                <div key={notification.id}>
                  <NotificationCard
                    notification={notification}
                    onCardClick={() => handleCardClick(notification.id, notification.is_read)}
                  />
                  {index < notifications.length - 1 && <div className={styles['notification-page__divider']} />}
                </div>
              ))}
            </div>
          ) : (
            <NotificationEmptyState />
          ))}
      </div>

      {isDeleteModalOpen && (
        <DeleteConfirmModal onConfirm={() => deleteAll()} onCancel={() => setIsDeleteModalOpen(false)} />
      )}
    </div>
  );
}



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async (_context, _cacheControl, serverRequest) => {
  // 모바일 전용 화면이다. 데스크톱은 서버에서 바로 돌려보낸다.
  if (serverRequest.device !== 'mobile') {
    throw redirect({ href: ROUTES.Main(), statusCode: 302 });
  }

  const queryClient = new QueryClient();
  const { isLoggedIn } = serverRequest;

  try {
    if (isLoggedIn) {
      await queryClient.prefetchQuery(callvanQueries.notifications(isLoggedIn));
    } else {
      queryClient.setQueryData(callvanQueryKeys.notifications(isLoggedIn), []);
    }
  } catch (error) {
    console.error('[SSR] callvan notifications prefetch failed:', error);
  }

  return {
      dehydratedState: dehydrate(queryClient),
    };
}));

export const Route = createFileRoute('/callvan/notifications/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: CallvanNotificationsPage,
});
