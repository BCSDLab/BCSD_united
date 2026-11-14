import { createFileRoute, useSearch, useParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import type { Semester } from 'api/timetable/entity';
import { timetableQueries } from 'api/timetable/queries';
import { SSRLayout } from 'components/layout';
import ModifyTimetablePage from 'components/TimetablePage/ModifyTimetablePage';
import { isKoinError } from 'interfaces/APIError';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { getRecentSemester, getSemesterFromQuery, resolveTimetableSemester } from 'utils/timetable/semester';
import { isUnauthorizedError } from 'utils/ts/httpError';

function ModifyTimetablePageWrapper({ semester }: { semester: Semester }) {
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const { id } = routeQuery;

  if (typeof id !== 'string') {
    return null;
  }

  return <ModifyTimetablePage id={id} semester={semester} />;
}

const loadPage = definePageLoad(async ({ search: query, queryClient }, _cacheControl, serverRequest) => {
  const { isLoggedIn, userType } = serverRequest;
  const timetableFrameId = Number(query.id);
  let currentSemester = getSemesterFromQuery(query.year, query.term) ?? getRecentSemester(new Date(serverRequest.now));

  if (isLoggedIn && userType === 'STUDENT') {
    try {
      const mySemesterData = await queryClient.fetchQuery(timetableQueries.mySemester(isLoggedIn, { userType }));
      const userSemester = mySemesterData?.semesters?.[0];
      const semester = resolveTimetableSemester(query.year, query.term, userSemester);
      currentSemester = semester ?? currentSemester;

      const prefetchPromises = [queryClient.prefetchQuery(timetableQueries.lectureInfo(isLoggedIn, timetableFrameId))];

      if (semester) {
        prefetchPromises.push(queryClient.prefetchQuery(timetableQueries.lectureList(semester)));
      }

      await Promise.all(prefetchPromises);
    } catch (error) {
      if (!isUnauthorizedError(error) && !(isKoinError(error) && error.status === 403)) {
        throw error;
      }
    }
  }

  return {
    semester: currentSemester,
  };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/timetable/modify/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <ModifyTimetablePageWrapper {...props} />;

  return <SSRLayout>{page}</SSRLayout>;
}
