import { dehydrate, QueryClient, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useSearch, useParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import dayjs from 'dayjs';

import { busQueries } from 'api/bus/queries';
import InformationIcon from 'assets/svg/Bus/info-gray.svg';
import RightArrow from 'assets/svg/right-arrow.svg';
import BusCoursePage from 'components/Bus/BusCoursePage';
import InfoFooter from 'components/Bus/BusCoursePage/components/InfoFooter';
import { ShuttleCategoryTabs } from 'components/Bus/BusCoursePage/components/ShuttleCategoryTabs';
import useBusPrefetch from 'components/Bus/BusCoursePage/hooks/useBusPrefetch';
import { SSRLayout } from 'components/layout';
import { BUS_FEEDBACK_FORM, SHUTTLE_COURSES, SHUTTLE_ROUTE_TYPE_CLASS } from 'static/bus';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useMount from 'utils/hooks/state/useMount';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { BUS_SHUTTLE_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/bus/shuttle/ShuttleBusTimetable.module.scss';

interface TemplateShuttleVersionProps {
  region: string;
  routes: Array<{
    id: string;
    route_name: string;
    sub_name: string | null;
    type: string;
  }>;
  category: string;
}

function asString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function ShuttleBusTimetable() {
  const routeNavigate = useNavigate();
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const categoryFromURL = asString(routeQuery.category);
  const category = categoryFromURL ?? '전체';

  const logger = useLogger();
  const isMobile = useMediaQuery();
  const isMount = useMount();

  const { data: shuttleCourse } = useSuspenseQuery(busQueries.shuttleCourse());

  const { data: timetable } = useQuery({
    ...busQueries.shuttleTimetable(SHUTTLE_COURSES[0]),
    enabled: isMount,
  });

  const displaySemester = shuttleCourse.semester_info.name;
  const updatedAt = timetable?.updated_at;

  return (
    <BusCoursePage>
      <div className={styles['timetable-container']}>
        {/* 카테고리 버튼 */}
        <ShuttleCategoryTabs
          category={category}
          onChange={(v) => {
            if (v === '전체') {
              routeNavigate({ href: ROUTES.BusCourseShuttle(), replace: true });
            } else {
              routeNavigate({ to: ROUTES.BusCourseShuttle(), search: { category: v }, replace: true });
            }
          }}
        />

        {/* 지역별 리스트 */}
        {!isMobile ? (
          <div className={styles['main-timetable']}>
            <div className={styles['main-timetable__column']}>
              {[
                shuttleCourse.route_regions[0], // 천안, 아산
                shuttleCourse.route_regions[1], // 청주
              ].map((text) => (
                <TemplateShuttleVersion
                  key={text.region}
                  region={text.region}
                  routes={text.routes}
                  category={category}
                />
              ))}
            </div>
            <div className={styles['main-timetable__column']}>
              {[
                shuttleCourse.route_regions[2], // 서울
                shuttleCourse.route_regions[3], // 대전, 세종
              ].map((text) => (
                <TemplateShuttleVersion
                  key={text.region}
                  region={text.region}
                  routes={text.routes}
                  category={category}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className={styles['main-timetable-mobile']}>
            {shuttleCourse.route_regions.map((text) => (
              <TemplateShuttleVersion key={text.region} region={text.region} routes={text.routes} category={category} />
            ))}
            <div className={styles['info-footer-mobile']}>
              <div className={styles['info-footer-mobile__text']}>
                {displaySemester}({shuttleCourse.semester_info.from} ~ {shuttleCourse.semester_info.to}
                )의
                <br />
                시간표가 제공됩니다.
              </div>
              <button
                type="button"
                className={styles['info-footer__icon']}
                onClick={() => {
                  window.open(BUS_FEEDBACK_FORM);
                  logger.actionEventClick({
                    team: 'CAMPUS',
                    event_label: 'error_feedback_button',
                    value: `셔틀_${category}`,
                  });
                }}
              >
                <InformationIcon />
                <div className={styles['info-footer__text']}>정보가 정확하지 않나요?</div>
              </button>
            </div>
          </div>
        )}

        {!isMobile && updatedAt && (
          <InfoFooter type="SHUTTLE" updated={dayjs(updatedAt).format('YYYY-MM-DD')} category={category} />
        )}
      </div>
    </BusCoursePage>
  );
}

function TemplateShuttleVersion({ region, routes, category }: TemplateShuttleVersionProps) {
  const routeNavigate = useNavigate();

  const isMobile = useMediaQuery();
  const logger = useLogger();

  const prefetchBusTimetable = useBusPrefetch();

  const filteredRoutes = (route: string) =>
    routes.filter(({ type }) => {
      if (route === '전체') {
        return true;
      }

      if (route === '주중노선') {
        return type === '주중';
      }

      if (route === '주말노선') {
        return type === '주말';
      }

      if (route === '순환노선') {
        return type === '순환';
      }

      return false;
    });

  if (filteredRoutes(category).length === 0) {
    return null;
  }

  return (
    <div className={styles['template-shuttle']}>
      <h2 className={styles['template-shuttle__title']}>{region}</h2>
      <div>
        {filteredRoutes(category).map((route) => (
          <button
            key={route.id}
            type="button"
            onMouseEnter={() => {
              prefetchBusTimetable({
                type: 'shuttle_detail',
                id: route.id,
              });
            }}
            className={styles['template-shuttle__list_wrapper']}
            onClick={() => {
              logger.actionEventClick({
                team: 'CAMPUS',
                event_label: 'area_specific_route',
                value: `${route.type}_${route.route_name}`,
              });
              routeNavigate({ to: ROUTES.BusShuttleDetail({ routeId: route.id }), search: { category } });
            }}
          >
            <span className={styles['template-shuttle__list']}>
              <div className={styles['template-shuttle__list_header']}>
                <span
                  className={`${styles['template-shuttle__list_type']} ${styles[SHUTTLE_ROUTE_TYPE_CLASS[route.type]] ?? ''}`}
                >
                  {route.type}
                </span>
                <span className={styles['template-shuttle__list_name']}>{route.route_name}</span>
              </div>
              <div className={styles['template-shuttle__list_sub_name']}>{route.sub_name}</div>
            </span>
            <RightArrow className={styles['template-shuttle__arrow']} />
          </button>
        ))}
        {isMobile && <div className={styles['main-timetable-mobile__line']} />}
      </div>
    </div>
  );
}

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (_context, cacheControl) => {
      const queryClient = new QueryClient();

      await withStaticFetchRetry('bus.shuttle-course', () =>
        queryClient.fetchQuery({
          ...busQueries.shuttleCourse(),
          staleTime: 1000 * 60 * 10,
        }),
      );

      cacheControl.enablePublicCache(
        `public, s-maxage=${BUS_SHUTTLE_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`,
      );

      return {
        dehydratedState: dehydrate(queryClient),
      };
    }),
  );

export const Route = createFileRoute('/bus/shuttle/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const page = <ShuttleBusTimetable />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
