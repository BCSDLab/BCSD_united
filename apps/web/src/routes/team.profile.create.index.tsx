import { createFileRoute } from '@tanstack/react-router';

import Layout from 'components/layout';
import Seo from 'components/seo/Seo';
import TeamProfileForm from 'components/Team/ProfilePage';

function TeamProfileCreatePage() {
  return (
    <>
      <Seo title="팀원 모집 프로필 작성 | KOIN" description="팀원 모집 프로필을 작성할 수 있습니다." />

      <TeamProfileForm mode="create" />
    </>
  );
}

export default TeamProfileCreatePage;

export const Route = createFileRoute('/team/profile/create/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TeamProfileCreatePage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
