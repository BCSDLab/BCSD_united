import { isKoinError } from '@bcsdlab/koin';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { articleQueries } from 'api/articles/queries';
import { authQueries } from 'api/auth/queries';
import type { BannersResponse } from 'api/banner/entity';
import { bannerQueries } from 'api/banner/queries';
import { cafeteriaQueries } from 'api/cafeteria/queries';
import { callvanQueries } from 'api/callvan/queries';
import { coopshopQueries } from 'api/coopshop/queries';
import type { StoreCategoriesResponse } from 'api/store/entity';
import { storeQueries } from 'api/store/queries';
import { createDefaultTimetableFrameList, timetableQueries, timetableQueryKeys } from 'api/timetable/queries';
import { weatherQueries } from 'api/weather/queries';
import { convertDateToSimpleString, DiningTime } from 'components/cafeteria/utils/time';
import HomePage from 'components/IndexComponents/HomePage';
import HomeLayout from 'components/layout/HomeLayout';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { getRecentSemester, resolveTimetableSemester } from 'utils/timetable/semester';
import { isUnauthorizedError } from 'utils/ts/httpError';

function Index(props: Awaited<ReturnType<typeof getPageData>>) {
  return <HomePage {...props} />;
}

export default Index;

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (_context, cacheControl, serverRequest) => {
      const queryClient = new QueryClient();
      let isLoggedIn = serverRequest.isLoggedIn;
      let userType = serverRequest.userType;
      const isMobile = serverRequest.device === 'mobile';

      const resetAuthContext = () => {
        isLoggedIn = false;
        userType = null;
        serverRequest.isLoggedIn = false;
        serverRequest.userType = null;
      };

      const setDefaultTimetableFrameList = (semester = getRecentSemester()) => {
        queryClient.setQueryData(timetableQueryKeys.frameList(semester, isLoggedIn), createDefaultTimetableFrameList());
      };

      const fetchMySemester = async () => {
        if (!isLoggedIn || userType !== 'STUDENT') return null;

        try {
          return await queryClient.fetchQuery(timetableQueries.mySemester(isLoggedIn, { userType }));
        } catch (error) {
          if (isUnauthorizedError(error)) {
            resetAuthContext();

            return null;
          }
          if (isKoinError(error) && error.status === 403) {
            return null;
          }
          throw error;
        }
      };

      const serverNow = new Date();
      const diningTime = new DiningTime();
      const diningDate = diningTime.generateDiningDate();
      const serverDining = {
        type: diningTime.getType(),
        dayLabel: diningTime.isTodayDining() ? '오늘' : '내일',
        date: diningDate.toISOString(),
      };

      const prefetchTimetable = async () => {
        const mySemester = await fetchMySemester();
        const userSemester = mySemester?.semesters?.[0];

        if (isMobile || !isLoggedIn || userType !== 'STUDENT') return userSemester;

        if (!userSemester) {
          setDefaultTimetableFrameList();

          return userSemester;
        }

        try {
          const timetableFrameList = await queryClient.fetchQuery(
            timetableQueries.frameList(isLoggedIn, userSemester, { userType }),
          );
          const mainFrame = timetableFrameList.find((frame) => frame.is_main);
          const activeMainFrameId = mainFrame?.id;
          if (typeof activeMainFrameId === 'number') {
            await queryClient.prefetchQuery(timetableQueries.lectureInfo(isLoggedIn, activeMainFrameId));
          }
        } catch (error) {
          if (isUnauthorizedError(error)) {
            resetAuthContext();
          } else if (isKoinError(error) && (error.status === 403 || error.status === 404)) {
            setDefaultTimetableFrameList(userSemester);
          } else {
            throw error;
          }
        }

        return userSemester;
      };

      const prefetchBanners = async () => {
        const banners = await queryClient.fetchQuery(bannerQueries.categories());
        const category = banners.banner_categories[0];
        if (!category) return null;

        const categoryId = Number(category.id);
        const list = await queryClient.fetchQuery(bannerQueries.list(categoryId));

        return { categoryId, list };
      };

      let bannerCategoryId = 0;
      let bannersList: BannersResponse = { count: 0, banners: [] };
      let categories: StoreCategoriesResponse = { total_count: 0, shop_categories: [] };

      const prefetchDeviceContent = async () => {
        if (isMobile) {
          await Promise.all([
            queryClient.prefetchQuery(weatherQueries.info()),
            queryClient.prefetchQuery(
              callvanQueries.list({ statuses: ['RECRUITING'], sort: 'LATEST_DESC', page: 1, limit: 1 }),
            ),
            queryClient.prefetchQuery(storeQueries.counts()),
            queryClient.prefetchQuery(storeQueries.eventCount()),
            queryClient.prefetchQuery(coopshopQueries.cafeteriaInfo()),
          ]);

          return;
        }

        const [banners, categoriesResponse] = await Promise.all([
          prefetchBanners(),
          queryClient.fetchQuery(storeQueries.categories()),
          queryClient.prefetchQuery(articleQueries.list(isLoggedIn, '1')),
          queryClient.prefetchQuery(timetableQueries.semesterInfo()),
          queryClient.prefetchQuery(articleQueries.lostItemStat()),
        ]);
        if (banners) {
          bannerCategoryId = banners.categoryId;
          bannersList = banners.list;
        }
        categories = categoriesResponse;
      };

      const [userSemester] = await Promise.all([
        prefetchTimetable(),
        queryClient.prefetchQuery(cafeteriaQueries.dinings(convertDateToSimpleString(diningDate))),
        isLoggedIn && queryClient.prefetchQuery(authQueries.userInfo(true)),
        prefetchDeviceContent(),
      ]);

      const serverSemester = resolveTimetableSemester(undefined, undefined, userSemester) ?? getRecentSemester();

      if (!isLoggedIn) {
        cacheControl.enablePublicCache();
      }

      return {
        bannerCategoryId,
        bannersList,
        categories,
        serverDining,
        serverSemester,
        serverNow: serverNow.toISOString(),
        dehydratedState: dehydrate(queryClient),
      };
    }),
  );

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <Index {...props} />;

  return <HomeLayout>{page}</HomeLayout>;
}
