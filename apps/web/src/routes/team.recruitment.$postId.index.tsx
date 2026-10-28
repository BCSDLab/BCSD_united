import Seo from 'components/seo/Seo';
import { createFileRoute } from '@tanstack/react-router';




import Layout from 'components/layout';
import RecruitmentDetail from 'components/Team/RecruitmentDetail';

export default function TeamDetailPage() {
  return (
    <>
      <Seo title="팀원 모집 상세 | KOIN" description="팀원 모집글의 상세 내용과 모집 현황을 확인할 수 있습니다." />

      <RecruitmentDetail />
    </>
  );
}



export const Route = createFileRoute('/team/recruitment/$postId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamDetailPage />;
  return <Layout mobileHeader="page">{page}</Layout>;
}
