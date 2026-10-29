import { createFileRoute } from '@tanstack/react-router';

import Layout from 'components/layout';
import Seo from 'components/seo/Seo';
import CreateTeamRecruitment from 'components/Team/CreateTeamRecruitment';

function TeamRecruitmentNewPage() {
  return (
    <>
      <Seo title="모집글 작성 | KOIN" description="팀원 모집글을 작성할 수 있습니다." />

      <CreateTeamRecruitment />
    </>
  );
}

export default TeamRecruitmentNewPage;

export const Route = createFileRoute('/team/recruitment/new/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamRecruitmentNewPage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
