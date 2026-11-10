import { createFileRoute, useSearch, useParams, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { DEPARTMENT_CONTACT_CATEGORIES, type DepartmentContactCategory } from 'api/departmentContact/entity';
import CategoryDetailPage from 'components/Department/CategoryDetail';
import Layout from 'components/layout';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

function isDepartmentContactCategory(value: string | string[] | undefined): value is DepartmentContactCategory {
  return typeof value === 'string' && (DEPARTMENT_CONTACT_CATEGORIES as string[]).includes(value);
}

function DepartmentCategoryRoutePage() {
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const { category } = routeQuery;

  if (!isDepartmentContactCategory(category)) {
    return null;
  }

  return <CategoryDetailPage category={category} />;
}

// 경로 카테고리는 허용 목록으로 검증하므로 잘못된 주소는 404로 응답한다.
const loadPage = definePageLoad(({ params }) => {
  if (!isDepartmentContactCategory(params.category)) throw notFound();

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/department/$category/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const page = <DepartmentCategoryRoutePage />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
