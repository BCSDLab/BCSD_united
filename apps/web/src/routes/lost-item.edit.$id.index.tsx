import { createFileRoute, useSearch, useParams } from '@tanstack/react-router';




import LostItemEditPage from 'components/Articles/LostItemEditPage';
import Layout from 'components/layout';

export default function LostItemEdit() {
  
  
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };
  
  const { id } = routeQuery;

  if (typeof id !== 'string') {
    return null;
  }

  return <LostItemEditPage articleId={Number(id)} />;
}



export const Route = createFileRoute('/lost-item/edit/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <LostItemEdit />;
  return <Layout>{page}</Layout>;
}
