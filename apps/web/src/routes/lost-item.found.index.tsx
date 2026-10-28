import { createFileRoute } from '@tanstack/react-router';

import LostItemWritePage from 'components/Articles/LostItemWritePage';
import Layout from 'components/layout';

export default function LostItemFound() {
  return <LostItemWritePage />;
}



export const Route = createFileRoute('/lost-item/found/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <LostItemFound />;
  return <Layout mobileHeader="page">{page}</Layout>;
}
