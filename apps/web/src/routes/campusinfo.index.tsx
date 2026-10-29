import { createFileRoute } from '@tanstack/react-router';

import CampusInfoPage from 'components/CampusInfo';
import PageLayout from 'components/layout';

export default CampusInfoPage;
export const Route = createFileRoute('/campusinfo/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <CampusInfoPage />;

  return <PageLayout>{page}</PageLayout>;
}
