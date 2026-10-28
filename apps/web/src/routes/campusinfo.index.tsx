import { createFileRoute } from '@tanstack/react-router';
import PageLayout from 'components/layout';
import CampusInfoPage from 'components/CampusInfo';
export default CampusInfoPage;
export const Route = createFileRoute('/campusinfo/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <CampusInfoPage />;
  return <PageLayout>{page}</PageLayout>;
}
