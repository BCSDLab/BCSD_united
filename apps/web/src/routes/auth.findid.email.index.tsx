import { createFileRoute } from '@tanstack/react-router';

import FindIdLayout from 'components/Auth/FindIdPage/Mobile';
import MobileFindIdByEmail from 'components/Auth/FindIdPage/Mobile/EmailPage';
import PCFindIdByEmail from 'components/Auth/FindIdPage/PC/EmailPage';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

function FindIdPage() {
  const isMobile = useMediaQuery();

  return isMobile ? <MobileFindIdByEmail /> : <PCFindIdByEmail />;
}



export default FindIdPage;

export const Route = createFileRoute('/auth/findid/email/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <FindIdPage />;
  return <FindIdLayout>{page}</FindIdLayout>;
}
