import Seo from 'components/seo/Seo';
import { createFileRoute } from '@tanstack/react-router';




import Layout from 'components/layout';
import EditTeamRecruitment from 'components/Team/EditTeamRecruitment';

export default function TeamRecruitmentEditPage() {
  return (
    <>
      <Seo title="모집글 수정 | KOIN" description="작성한 팀원 모집글을 수정할 수 있습니다." />

      <EditTeamRecruitment />
    </>
  );
}



export const Route = createFileRoute('/team/recruitment/$postId/edit/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamRecruitmentEditPage />;
  return <Layout mobileHeader="page">{page}</Layout>;
}
