import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import type { LandDetailResponse } from 'api/room/entity';
import { roomQueries } from 'api/room/queries';
import SleepIcon from 'assets/svg/common/sleep-bbico.svg';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { RoomRentBadge } from 'components/Room/components/RoomCard/RoomCardContent';
import RoomDetailImg from 'components/Room/components/RoomDetailImg';
import RoomDetailInfo from 'components/Room/components/RoomDetailInfo';
import RoomDetailMap from 'components/Room/components/RoomDetailMap';
import RoomDetailOption from 'components/Room/components/RoomDetailOption';
import RoomDetailTable from 'components/Room/components/RoomDetailTable';
import useRoomDetail from 'components/Room/RoomDetailPage/hooks/useRoomDetail';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { isNotFoundKoinError, ROOM_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/room/[id]/RoomDetailPage.module.scss';

interface RoomDetailPageProps {
  readonly id: string;
}

function MobileRoomDetail({ room }: { room: LandDetailResponse }) {
  const { data: roomList } = useQuery(roomQueries.list());
  const summary = roomList?.lands?.find((land) => land.id === room.id);

  return (
    <main className={styles.mobile}>
      <div className={styles.mobile__heading}>
        {(summary?.is_monthly_available || summary?.is_charter_available) && (
          <div className={styles.mobile__badges}>
            {summary.is_monthly_available && <RoomRentBadge type="monthly" />}
            {summary.is_charter_available && <RoomRentBadge type="charter" />}
          </div>
        )}
        <h2 className={styles.mobile__name}>{room.name}</h2>
      </div>
      {room.image_urls?.length ? (
        <RoomDetailImg imgUrl={room.image_urls} />
      ) : (
        <div className={styles.mobile__empty}>
          <SleepIcon aria-hidden />
          <p>이미지 준비 중입니다.</p>
        </div>
      )}
      <div className={styles.mobile__content}>
        <section className={styles.mobile__info}>
          <h2>원룸 정보</h2>
          <RoomDetailInfo size={room.size} roomType={room.room_type} />
        </section>
        <section className={styles.mobile__info}>
          <h2>위치 정보</h2>
          <RoomDetailMap latitude={room.latitude} longitude={room.longitude} address={room.address} />
        </section>
      </div>
      <div className={styles.mobile__contact}>
        <span>연락처</span>
        <p>{room.phone || '-'}</p>
      </div>
    </main>
  );
}

function RoomDetailPage({ id }: RoomDetailPageProps) {
  const isMobile = useMediaQuery();
  const { roomDetail, roomOptions } = useRoomDetail(id);
  useScrollToTop();

  if (isMobile) {
    return (
      <>
        <MobilePageHeader title="복덕방" />
        {roomDetail && <MobileRoomDetail room={roomDetail} />}
      </>
    );
  }

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
            <img src="https://static.koreatech.in/assets/ic-room/img.png" alt="이미지 없음" width={712} height={402} />
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

const loadPage = definePageLoad(async ({ params, queryClient }, cacheControl) => {
  const { id } = params;
  if (!id) {
    cacheControl.enablePublicCache(`public, s-maxage=${ROOM_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);
    throw notFound();
  }

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

  return { id };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/room/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <RoomDetailPage {...props} />;

  return (
    <SSRLayout className={styles.layout} mobileHeader="page">
      {page}
    </SSRLayout>
  );
}
