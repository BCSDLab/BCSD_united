import Seo from 'components/seo/Seo';
import { createFileRoute, useNavigate, useSearch, useParams } from '@tanstack/react-router';

import { Suspense, useEffect } from 'react';




import ErrorBoundary from 'components/boundary/ErrorBoundary';
import LoadingSpinner from 'components/feedback/LoadingSpinner';
import Layout from 'components/layout';
import TeamChatRoom from 'components/Team/components/TeamChatRoom';
import ROUTES from 'static/routes';
import { parseQueryId } from 'utils/ts/parseServerSideParams';

import styles from 'pages/team/chat/TeamChatPage.module.scss';

export default function TeamChatPage() {
  const routeNavigate = useNavigate();
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };

  const recruitmentId = parseQueryId(routeQuery.recruitmentId);
  const chatRoomId = parseQueryId(routeQuery.chatRoomId);
  const hasValidRoom = recruitmentId !== null && chatRoomId !== null;

  useEffect(() => {
    if (!hasValidRoom) {
      void routeNavigate({ href: ROUTES.Team(), replace: true });
    }
  }, [routeNavigate, hasValidRoom]);

  return (
    <>
      <Seo title="팀원 모집 채팅 | KOIN" />
      <main className={styles.page}>
        <h1 className={styles.page__title}>팀원모집</h1>
        <div className={styles.page__content}>
          {hasValidRoom && (
            <ErrorBoundary fallbackClassName={styles.error}>
              <Suspense
                fallback={
                  <div className={styles.loading} role="status" aria-label="채팅방을 불러오는 중입니다.">
                    <LoadingSpinner size="50px" />
                  </div>
                }
              >
                <TeamChatRoom
                  key={`${recruitmentId}-${chatRoomId}`}
                  recruitmentId={recruitmentId}
                  chatRoomId={chatRoomId}
                />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </main>
    </>
  );
}



export const Route = createFileRoute('/team/chat/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamChatPage />;
  return (
  <Layout mobileHeader="page" fitViewport>
    {page}
  </Layout>
);
}
