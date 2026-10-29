import { createFileRoute } from '@tanstack/react-router';

import Layout from 'components/layout';
import Seo from 'components/seo/Seo';
import ApplicantManagement from 'components/Team/ApplicantManagement';

function TeamApplicantManagementPage() {
  return (
    <>
      <Seo title="지원자 관리 | KOIN" description="모집글에 지원한 팀원 지원자 목록을 확인할 수 있습니다." />

      <ApplicantManagement />
    </>
  );
}

export default TeamApplicantManagementPage;

export const Route = createFileRoute('/team/recruitment/$postId/applicants/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamApplicantManagementPage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
