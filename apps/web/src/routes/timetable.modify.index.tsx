import { createFileRoute, useSearch, useParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';



import { isKoinError } from '@bcsdlab/koin';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import type { Semester } from 'api/timetable/entity';
import { timetableQueries } from 'api/timetable/queries';
import { SSRLayout } from 'components/layout';
import ModifyTimetablePage from 'components/TimetablePage/ModifyTimetablePage';

import { getRecentSemester, getSemesterFromQuery, resolveTimetableSemester } from 'utils/timetable/semester';
import { isUnauthorizedError } from 'utils/ts/httpError';



export default function ModifyTimetablePageWrapper({ semester }: { semester: Semester }) {
  
  
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };
  
  const { id } = routeQuery;

  if (typeof id !== 'string') {
    return null;
  }

  return <ModifyTimetablePage id={id} semester={semester} />;
}



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async (context, _cacheControl, serverRequest) => {
    const queryClient = new QueryClient();

    const { search: query } = context;
    const { isLoggedIn, userType } = serverRequest;
    const timetableFrameId = Number(query.id);
    let currentSemester = getSemesterFromQuery(query.year, query.term) ?? getRecentSemester();

    if (isLoggedIn && userType === 'STUDENT') {
      try {
        const mySemesterData = await queryClient.fetchQuery(timetableQueries.mySemester(isLoggedIn, { userType }));
        const userSemester = mySemesterData?.semesters?.[0];
        const semester = resolveTimetableSemester(query.year, query.term, userSemester);
        currentSemester = semester ?? currentSemester;

        const prefetchPromises = [
          queryClient.prefetchQuery(timetableQueries.lectureInfo(isLoggedIn, timetableFrameId)),
        ];

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
        dehydratedState: dehydrate(queryClient),
        semester: currentSemester,
      };
  }));

export const Route = createFileRoute('/timetable/modify/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <ModifyTimetablePageWrapper {...props} />;
  return <SSRLayout>{page}</SSRLayout>;
}
