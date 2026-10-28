import Seo from 'components/seo/Seo';
import { createFileRoute } from '@tanstack/react-router';




import Layout from 'components/layout';
import ApplicantDetail from 'components/Team/ApplicantDetail';

function TeamApplicantDetailPage() {
  return (
    <>
      <Seo title="지원자 상세 | KOIN" description="팀원 모집 지원자의 상세 정보를 확인하고 승인 또는 거절할 수 있습니다." />

      <ApplicantDetail />
    </>
  );
}



export default TeamApplicantDetailPage;

export const Route = createFileRoute('/team/recruitment/$postId/applicants/$applicantId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamApplicantDetailPage />;
  return <Layout mobileHeader="page">{page}</Layout>;
}
