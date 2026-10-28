import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import React from 'react';

import { isKoinError } from '@bcsdlab/koin';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { timetableQueries } from 'api/timetable/queries';
import { SSRLayout } from 'components/layout';
import MobileTimetableListPage from 'components/TimetablePage/MobileTimetableListPage';
import ROUTES from 'static/routes';

import { isUnauthorizedError } from 'utils/ts/httpError';



export default function TimetableListPage() {
  return (
    <React.Suspense fallback={null}>
      <MobileTimetableListPage />
    </React.Suspense>
  );
}



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async (_context, cacheControl, serverRequest) => {
  // 모바일 전용 화면: 데스크탑은 시간표 페이지로 보낸다.
  if (serverRequest.device === 'desktop') {
    throw redirect({ href: ROUTES.Timetable(), statusCode: 302 });
  }

  const queryClient = new QueryClient();
  const { userType } = serverRequest;
  let isMember = false;

  if (serverRequest.isLoggedIn) {
    try {
      const mySemester = await queryClient.fetchQuery(timetableQueries.mySemester(true, { userType }));
      if (mySemester) {
        isMember = true;
        await Promise.all(
          mySemester.semesters.map((semester) =>
            queryClient.prefetchQuery(timetableQueries.frameList(true, semester, { fallbackOnError: true, userType })),
          ),
        );
      }
    } catch (error) {
      // userType 가드로 학생이 아닌 사용자는 요청 자체를 건너뛰지만, 판별 실패 등으로 요청이 나간 경우의 방어선이다.
      const isForbiddenError = isKoinError(error) && error.status === 403;
      if (!isUnauthorizedError(error) && !isForbiddenError) throw error;
    }
  }

  if (!isMember) {
    await queryClient.prefetchQuery(timetableQueries.semesterInfo());
    if (!serverRequest.isLoggedIn) cacheControl.enablePublicCache();
  }

  return {
      dehydratedState: dehydrate(queryClient),
    };
}));

export const Route = createFileRoute('/timetable/list/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TimetableListPage />;
  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
