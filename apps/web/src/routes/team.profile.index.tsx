import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { teamRecruitmentProfileQueries } from 'api/teamRecruitmentProfile/queries';
import Layout from 'components/layout';
import Seo from 'components/seo/Seo';
import TeamProfileDesktop from 'components/Team/TeamProfilePage/TeamProfileDesktop';
import TeamProfileMobile from 'components/Team/TeamProfilePage/TeamProfileMobile';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

import styles from 'pages/team/profile/TeamProfilePage.module.scss';

// 로그인은 루트 라우트의 beforeLoad가 보장한다. 프로필 쿼리를 SSR 또는 클라이언트 이동에서
// 미리 채워 두므로, 처음부터 확정된 데이터로 렌더해 "프로필 없음" 깜빡임을 막는다.
function TeamProfilePage() {
  const routeNavigate = useNavigate();
  const isLoggedIn = useIsLoggedIn();
  const logger = useLogger();
  // 애플리케이션의 QueryClient는 SSR 중 모든 쿼리를 기본적으로 enabled:false로 끈다(전역 기본값).
  // useSuspenseQuery는 enabled를 지원하지 않아 이 기본값을 개별적으로 못 덮어써서 서버에서 빈 데이터로
  // 취급되므로, enabled를 명시할 수 있는 일반 useQuery를 쓴다. 로더가 쿼리를 미리 채우므로
  // 서버·클라이언트 모두 첫 렌더부터 캐시에서 동기적으로 값을 읽는다.
  const { data: profile } = useQuery({
    ...teamRecruitmentProfileQueries.me(isLoggedIn),
    enabled: isLoggedIn,
  });

  const handleModifyClick = () => {
    logger.actionEventClick({
      team: 'CAMPUS',
      event_label: 'team_recruitment_profile_modify',
      value: '프로필 수정하기',
    });
    routeNavigate({ href: ROUTES.TeamProfileEdit() });
  };

  const handleCreateClick = () => {
    logger.actionEventClick({
      team: 'CAMPUS',
      event_label: 'team_recruitment_profile_create',
      value: '프로필 작성하기',
    });
    routeNavigate({ href: ROUTES.TeamProfileCreate() });
  };

  const handleCreatedRecruitmentsClick = () => {
    logger.actionEventClick({
      team: 'CAMPUS',
      event_label: 'team_recruitment_profile_created',
      value: '내가 작성한 모집글',
    });
    routeNavigate({ href: ROUTES.TeamMyCreatedPosts() });
  };

  const handleAppliedRecruitmentsClick = () => {
    logger.actionEventClick({
      team: 'CAMPUS',
      event_label: 'team_recruitment_profile_applied',
      value: '내가 지원한 모집글',
    });
    routeNavigate({ href: ROUTES.TeamMyApplications() });
  };

  const viewProps = {
    profile,
    hasProfile: Boolean(profile),
    onModifyClick: handleModifyClick,
    onCreateClick: handleCreateClick,
    onCreatedRecruitmentsClick: handleCreatedRecruitmentsClick,
    onAppliedRecruitmentsClick: handleAppliedRecruitmentsClick,
  };

  return (
    <>
      <Seo title="팀원 모집 프로필 | KOIN" description="팀원 모집 프로필을 확인하고 관리할 수 있습니다." />

      <div className={styles['desktop-only']}>
        <TeamProfileDesktop {...viewProps} />
      </div>
      <div className={styles['mobile-only']}>
        <TeamProfileMobile {...viewProps} />
      </div>
    </>
  );
}

const loadPage = definePageLoad(async ({ queryClient }, _cacheControl, serverRequest) => {
  if (serverRequest.isLoggedIn) {
    await queryClient.prefetchQuery(teamRecruitmentProfileQueries.me(serverRequest.isLoggedIn));
  }

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/team/profile/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamProfilePage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
