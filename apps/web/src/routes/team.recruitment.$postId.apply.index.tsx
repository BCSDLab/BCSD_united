import { createFileRoute } from '@tanstack/react-router';

import Layout from 'components/layout';
import Seo from 'components/seo/Seo';
import RecruitmentApplyPage from 'components/Team/RecruitmentApplyPage';

function TeamRecruitmentApplyPage() {
  return (
    <>
      <Seo title="지원서 작성 | KOIN" description="팀원 모집글에 지원서를 작성할 수 있습니다." />

      <RecruitmentApplyPage />
    </>
  );
}

export default TeamRecruitmentApplyPage;

export const Route = createFileRoute('/team/recruitment/$postId/apply/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamRecruitmentApplyPage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
