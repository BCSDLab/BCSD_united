import { dehydrate, QueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { teamRecruitmentProfileQueries } from 'api/teamRecruitmentProfile/queries';
import Layout from 'components/layout';
import Seo from 'components/seo/Seo';
import TeamProfileForm from 'components/Team/ProfilePage';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';

// 로그인은 루트 라우트의 beforeLoad가 보장한다. 기존 프로필을 서버에서 미리 prefetch해 내려줘야
// 폼이 "빈 값으로 시작했다가 나중에 채워지는" 하이드레이션 불일치 없이 처음부터 채워진 채로 렌더된다.
function TeamProfileEditPage() {
  return (
    <>
      <Seo title="팀원 모집 프로필 수정 | KOIN" description="팀원 모집 프로필을 수정할 수 있습니다." />

      <TeamProfileForm mode="edit" />
    </>
  );
}

export default TeamProfileEditPage;

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (_context, _cacheControl, serverRequest) => {
      const queryClient = new QueryClient();

      if (serverRequest.isLoggedIn) {
        await queryClient.prefetchQuery(teamRecruitmentProfileQueries.me(serverRequest.isLoggedIn));
      }

      return {
        dehydratedState: dehydrate(queryClient),
      };
    }),
  );

export const Route = createFileRoute('/team/profile/edit/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamProfileEditPage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
