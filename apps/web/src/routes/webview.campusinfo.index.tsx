import { createFileRoute } from '@tanstack/react-router';

import CampusInfo from 'components/CampusInfo';

export default function WebviewCampusInfo() {
  return <CampusInfo />;
}



export const Route = createFileRoute('/webview/campusinfo/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <WebviewCampusInfo />;
  return page;
}
