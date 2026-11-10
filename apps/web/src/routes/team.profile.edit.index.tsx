import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { teamRecruitmentProfileQueries } from 'api/teamRecruitmentProfile/queries';
import Layout from 'components/layout';
import Seo from 'components/seo/Seo';
import TeamProfileForm from 'components/Team/ProfilePage';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

// 로그인은 루트 라우트의 beforeLoad가 보장한다. 기존 프로필을 SSR 또는 클라이언트 이동에서
// 미리 채워 두어 폼이 처음부터 값이 채워진 채로 렌더된다.
function TeamProfileEditPage() {
  return (
    <>
      <Seo title="팀원 모집 프로필 수정 | KOIN" description="팀원 모집 프로필을 수정할 수 있습니다." />

      <TeamProfileForm mode="edit" />
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

export const Route = createFileRoute('/team/profile/edit/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamProfileEditPage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
