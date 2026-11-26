import ImageModal, { type ImageModalProps } from 'components/modal/Modal/ImageModal';
import useLogger from 'utils/hooks/analytics/useLogger';
import useModalPortal from 'utils/hooks/layout/useModalPortal';

type RoomPhotoModalOptions = Pick<
  ImageModalProps,
  | 'imageList'
  | 'imageIndex'
  | 'imageAlt'
  | 'imageTitle'
  | 'imageDescription'
  | 'dialogLabel'
  | 'imageSize'
  | 'mobileNavigation'
>;

export default function useRoomPhotoModal() {
  const logger = useLogger();
  const portal = useModalPortal();

  return (options: RoomPhotoModalOptions) => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'real_estate__room_detail__photo_view__expand__click',
      value: '크게 보기',
    });
    portal.open(({ close }) => (
      <ImageModal
        {...options}
        onClose={close}
        onArrowClick={(direction) =>
          logger.actionEventClick({
            event_name: 'DA1',
            event_label: 'real_estate__room_detail__photo_modal__slide__click',
            value: direction === -1 ? '이전' : '다음',
          })
        }
        onCloseButtonClick={() =>
          logger.actionEventClick({
            event_name: 'DA1',
            event_label: 'real_estate__room_detail__photo_modal__close__click',
            value: '닫기',
          })
        }
      />
    ));
  };
}
