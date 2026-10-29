import { createFileRoute } from '@tanstack/react-router';

import DepartmentPageContent from 'components/Department';
import Layout from 'components/layout';

function DepartmentPage() {
  return <DepartmentPageContent />;
}

export default DepartmentPage;

export const Route = createFileRoute('/department/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <DepartmentPage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
