import { lazy, useEffect, useState } from 'react';
import { isKoinError } from '@bcsdlab/koin';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { createFileRoute, useSearch, useParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { deptQueries } from 'api/dept/queries';
import type { TimetableFrameListResponse } from 'api/timetable/entity';
import {
  createDefaultTimetableFrameList,
  isValidTimetableFrameId,
  timetableQueries,
  timetableQueryKeys,
} from 'api/timetable/queries';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { TimetableEditButton } from 'components/TimetablePage/components/MobileHeaderActions';
import useTimetableFrameList from 'components/TimetablePage/hooks/useTimetableFrameList';
import DefaultPage from 'components/TimetablePage/MainTimetablePage/DefaultPage';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useGoBack from 'utils/hooks/routing/useGoBack';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { loadPageData, validatePageInput, type PageRequest } from 'utils/ssr/pageData';
import type { ServerRequestContext } from 'utils/ssr/requestContext';
import { getRecentSemester, getSemesterFromQuery, resolveTimetableSemester } from 'utils/timetable/semester';
import { isomorphicSessionStorage } from 'utils/ts/env';
import getElapsedSeconds from 'utils/ts/getElapsedSeconds';
import { isUnauthorizedError } from 'utils/ts/httpError';
import { useSemester } from 'utils/zustand/semester';

import styles from 'pages/timetable/TimetablePage.module.scss';

const MobilePage = lazy(() =>
  import('components/TimetablePage/MainTimetablePage/MobilePage').then((mod) => ({ default: mod.MobilePage })),
);

const prefetchBaseTimetableData = async (queryClient: QueryClient) => {
  await Promise.all([
    queryClient.prefetchQuery(timetableQueries.semesterInfo()),
    queryClient.prefetchQuery(deptQueries.list()),
  ]);
};

const setDefaultTimetableFrameList = (
  queryClient: QueryClient,
  isLoggedIn: boolean,
  semester = getRecentSemester(),
) => {
  queryClient.setQueryData(timetableQueryKeys.frameList(semester, isLoggedIn), createDefaultTimetableFrameList());
};

async function prefetchTimetableData(
  queryClient: QueryClient,
  context: PageRequest,
  isLoggedIn: boolean,
  userType: ServerRequestContext['userType'],
  query: PageRequest['search'],
  validatedFrameId: number | null,
): Promise<void> {
  // 학기·학과 목록은 사용자 학기와 무관하므로 먼저 띄워 두고 각 분기에서 기다린다. prefetchQuery는 실패해도 reject하지 않는다
  const baseTimetablePrefetch = prefetchBaseTimetableData(queryClient);

  try {
    const mySemesterData = await queryClient.fetchQuery(timetableQueries.mySemester(isLoggedIn, { userType }));
    const userSemester = mySemesterData?.semesters?.[0];
    const semester = resolveTimetableSemester(query.year, query.term, userSemester);

    if (!semester) {
      setDefaultTimetableFrameList(queryClient, isLoggedIn);
      await baseTimetablePrefetch;

      return;
    }

    let timetableFrameList: TimetableFrameListResponse;

    try {
      timetableFrameList = await queryClient.fetchQuery(timetableQueries.frameList(isLoggedIn, semester, { userType }));
    } catch (error) {
      if (!(isKoinError(error) && error.status === 404)) {
        throw error;
      }

      setDefaultTimetableFrameList(queryClient, isLoggedIn, semester);
      await baseTimetablePrefetch;

      return;
    }

    const mainFrame = timetableFrameList.find((frame) => frame.is_main);
    const hasValidatedFrame =
      validatedFrameId !== null && timetableFrameList.some((frame) => frame.id === validatedFrameId);
    const currentFrameId = hasValidatedFrame ? validatedFrameId : (mainFrame?.id ?? null);

    const prefetchPromises = [baseTimetablePrefetch];

    if (currentFrameId !== null) {
      prefetchPromises.push(queryClient.prefetchQuery(timetableQueries.lectureInfo(isLoggedIn, currentFrameId)));
    }

    await Promise.all(prefetchPromises);
  } catch (error) {
    const isAuthError = isUnauthorizedError(error);
    const isForbiddenError = isKoinError(error) && error.status === 403;
    if (!isAuthError && !isForbiddenError) throw error;
    setDefaultTimetableFrameList(
      queryClient,
      isLoggedIn,
      getSemesterFromQuery(query.year, query.term) ?? getRecentSemester(),
    );
    await baseTimetablePrefetch;
  }
}

function TimetablePage() {
  const isMobile = useMediaQuery();
  useScrollToTop();
  const semester = useSemester();

  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const logger = useLogger();
  const goBack = useGoBack();
  const { timetableFrameId } = routeQuery;
  const { data: timetableFrameList } = useTimetableFrameList(semester);
  const mainFrame = timetableFrameList.find((frame) => frame.is_main === true);
  const mainFrameId = isValidTimetableFrameId(mainFrame?.id) ? mainFrame.id : 0;
  const queryFrameId = typeof timetableFrameId === 'string' ? Number(timetableFrameId) : Number.NaN;
  const hasQueryFrame = timetableFrameList.some((frame) => frame.id === queryFrameId);
  const initialFrameId = hasQueryFrame ? queryFrameId : mainFrameId;
  const [currentFrameIndex, setCurrentFrameIndex] = useState(initialFrameId);
  const resolvedCurrentFrameIndex = timetableFrameList.some((frame) => frame.id === currentFrameIndex)
    ? currentFrameIndex
    : initialFrameId;

  useEffect(() => {
    isomorphicSessionStorage.setItem('enterTimetablePage', new Date().getTime().toString());
  }, []);

  const handleBack = () => {
    logger.actionEventClick({
      team: 'USER',
      event_label: 'timetable_back',
      value: '뒤로가기버튼',
      previous_page: '시간표',
      current_page: '메인',
      duration_time: getElapsedSeconds('enterTimetablePage'),
    });
    goBack();
  };

  return (
    <>
      <MobilePageHeader title="시간표" rightAction={<TimetableEditButton />} onBack={handleBack} />
      <div className={styles.page}>
        {!isMobile ? (
          <DefaultPage timetableFrameId={resolvedCurrentFrameIndex} setCurrentFrameId={setCurrentFrameIndex} />
        ) : (
          <MobilePage timetableFrameId={resolvedCurrentFrameIndex} setCurrentFrameId={setCurrentFrameIndex} />
        )}
      </div>
    </>
  );
}

export default TimetablePage;

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (context, cacheControl, serverRequest) => {
      const queryClient = new QueryClient();
      const { search: query } = context;
      const frameId = Number(query.timetableFrameId);
      const validatedFrameId = isValidTimetableFrameId(frameId) ? frameId : null;

      if (serverRequest.isLoggedIn) {
        await prefetchTimetableData(
          queryClient,
          context,
          serverRequest.isLoggedIn,
          serverRequest.userType,
          query,
          validatedFrameId,
        );
      } else {
        setDefaultTimetableFrameList(queryClient, false);
        cacheControl.enablePublicCache();
      }

      return {
        dehydratedState: dehydrate(queryClient),
      };
    }),
  );

export const Route = createFileRoute('/timetable/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const page = <TimetablePage />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
