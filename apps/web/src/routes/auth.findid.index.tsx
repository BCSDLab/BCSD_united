import { createFileRoute } from '@tanstack/react-router';

import FindIdLayout from 'components/Auth/FindIdPage/Mobile';
import MobileFindIdByPhone from 'components/Auth/FindIdPage/Mobile/PhonePage';
import PCFindIdByPhone from 'components/Auth/FindIdPage/PC/PhonePage';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

function FindIdPage() {
  const isMobile = useMediaQuery();

  return isMobile ? <MobileFindIdByPhone /> : <PCFindIdByPhone />;
}

export default FindIdPage;

export const Route = createFileRoute('/auth/findid/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <FindIdPage />;

  return <FindIdLayout>{page}</FindIdLayout>;
}
