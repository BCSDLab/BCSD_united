import { useQuery } from '@tanstack/react-query';

import type { LandList } from 'api/room/entity';
import { roomQueries } from 'api/room/queries';
import { RoomRentBadge } from 'components/Room/components/RoomCard/RoomCardContent';
import RoomDetailInfo from 'components/Room/components/RoomDetailInfo';
import Button from 'components/ui/Button';
import { copyToClipboard } from 'utils/ts/copyToClipboard';
import showToast from 'utils/ts/showToast';

import RoomSelectionImages from './RoomSelectionImages';
import styles from './RoomSelection.module.scss';

export default function RoomSelectionDetail({ room }: { room: LandList }) {
  const { data: detail, error, isFetching, refetch } = useQuery(roomQueries.detail(String(room.id)));

  if (error || detail?.is_deleted) {
    return (
      <div className={styles.info} role="alert">
        <p>건물 정보를 불러오지 못했습니다.</p>
        <Button color="neutral" size="sm" state={isFetching ? 'disabled' : 'default'} onClick={() => refetch()}>
          다시 시도
        </Button>
      </div>
    );
  }
  const phone = detail?.phone;

  const copyPhone = async (phone: string) => {
    await copyToClipboard(phone);
    showToast('info', '전화번호가 복사되었습니다.');
  };

  return (
    <>
      <div className={styles.header}>
        {(room.is_monthly_available || room.is_charter_available) && (
          <div className={styles.badges}>
            {room.is_monthly_available && <RoomRentBadge type="monthly" />}
            {room.is_charter_available && <RoomRentBadge type="charter" />}
          </div>
        )}
        <h2 className={styles.name}>{detail?.name ?? room.name}</h2>
      </div>
      {detail ? (
        <>
          <RoomSelectionImages imageUrls={detail.image_urls} name={detail.name} />
          <div className={styles.info}>
            <h3>원룸 정보</h3>
            <RoomDetailInfo size={detail.size} roomType={detail.room_type} />
          </div>
          <div className={styles.info}>
            <h3>위치 정보</h3>
            <dl>
              <dt>주소</dt>
              <dd>{detail.address || '-'}</dd>
              <dt>연락처</dt>
              <dd>
                {phone ? (
                  <button
                    type="button"
                    className={styles.phone}
                    aria-label={`${phone} 복사`}
                    onClick={() => copyPhone(phone)}
                  >
                    {phone}
                  </button>
                ) : (
                  '연락처가 비어 있습니다.'
                )}
              </dd>
            </dl>
          </div>
        </>
      ) : (
        <p role="status">건물 정보를 불러오는 중입니다.</p>
      )}
    </>
  );
}
