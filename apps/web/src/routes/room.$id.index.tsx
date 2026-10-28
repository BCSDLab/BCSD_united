import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';



import { dehydrate, QueryClient } from '@tanstack/react-query';

import { roomQueries } from 'api/room/queries';
import { SSRLayout } from 'components/layout';
import RoomDetailImg from 'components/Room/components/RoomDetailImg';
import RoomDetailMap from 'components/Room/components/RoomDetailMap';
import RoomDetailOption from 'components/Room/components/RoomDetailOption';
import RoomDetailTable from 'components/Room/components/RoomDetailTable';
import useRoomDetail from 'components/Room/RoomDetailPage/hooks/useRoomDetail';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { isNotFoundKoinError, ROOM_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/room/[id]/RoomDetailPage.module.scss';

interface RoomDetailPageProps {
  readonly id: string;
}





function RoomDetailPage({ id }: RoomDetailPageProps) {
  const isMobile = useMediaQuery();
  const { roomDetail, roomOptions } = useRoomDetail(id);
  useScrollToTop();

  return (
    <div className={styles.template}>
      <div>{!isMobile && <h1 className={styles.template__title}>복덕방</h1>}</div>
      {roomDetail && <div className={styles.template__name}>{roomDetail?.name}</div>}
      <div className={styles.info}>
        <h2 className={styles.info__title}>원룸 정보</h2>
        {roomDetail && (
          <RoomDetailTable
            monthlyFee={roomDetail?.monthly_fee}
            roomType={roomDetail?.room_type}
            charterFee={roomDetail?.charter_fee}
            deposit={roomDetail?.deposit}
            floor={roomDetail?.floor}
            managementFee={roomDetail?.management_fee}
            size={roomDetail?.size}
            phone={roomDetail?.phone}
          />
        )}
        {roomDetail?.image_urls ? (
          <RoomDetailImg imgUrl={roomDetail?.image_urls} />
        ) : (
          <div className={styles['info__img-slider__img--empty']}>
            <img
              src="https://static.koreatech.in/assets/ic-room/img.png"
              alt="이미지 없음"
              width={712}
              height={402}
            />
          </div>
        )}
      </div>
      <div className={styles.info}>
        <h2 className={styles.info__title}>원룸 옵션</h2>
        {roomDetail && <RoomDetailOption roomOptions={roomOptions} />}
      </div>
      <div className={styles.info}>
        <h2 className={styles.info__title}>원룸 위치</h2>
        {roomDetail && (
          <RoomDetailMap latitude={roomDetail.latitude} longitude={roomDetail.longitude} address={roomDetail.address} />
        )}
      </div>
    </div>
  );
}

export default RoomDetailPage;



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async ({ params }, cacheControl) => {
  const { id } = params;
  if (!id) {
    cacheControl.enablePublicCache(`public, s-maxage=${ROOM_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);
throw notFound();
  }
  const queryClient = new QueryClient();

  try {
    await withStaticFetchRetry('room.detail', () => queryClient.fetchQuery(roomQueries.detail(id)));
  } catch (error) {
    if (isNotFoundKoinError(error)) {
      cacheControl.enablePublicCache(`public, s-maxage=${ROOM_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);
throw notFound();
    }
    throw error;
  }

  cacheControl.enablePublicCache(`public, s-maxage=${ROOM_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);
return {
      dehydratedState: dehydrate(queryClient),
      id,
    };
}));

export const Route = createFileRoute('/room/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <RoomDetailPage {...props} />;
  return <SSRLayout>{page}</SSRLayout>;
}
