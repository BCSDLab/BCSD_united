import LoginRequiredModal from 'components/modal/LoginRequiredModal';
import type { Portal } from 'components/modal/Modal/PortalProvider';
import useStoreDetail from 'components/Store/StoreDetailPage/hooks/useStoreDetail';
import useLogger from 'utils/hooks/analytics/useLogger';
import useModalPortal from 'utils/hooks/layout/useModalPortal';
import { useUser } from 'utils/hooks/state/useUser';
import { isomorphicSessionStorage } from 'utils/ts/env';

import styles from './index.module.scss';

export const REVEIW_LOGIN = ['리뷰를 작성하기 ', '리뷰 작성은 회원만 사용 가능합니다.'];

export default function ReviewButton({ id, goReviewPage }: { id: string; goReviewPage: () => void }) {
  const { data: userInfo } = useUser();
  const portalManager = useModalPortal();
  const logger = useLogger();
  const { storeDetail } = useStoreDetail(id);

  const openLoginModal = () => {
    const loggingLoginClick = () => {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'account__shop_detail__login_popup__login_entry__click',
        value: storeDetail.name,
      });
    };
    const loggingCancelClick = () => {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: 'account__shop_detail__login_popup__close__click',
        value: storeDetail.name,
      });
    };
    portalManager.open((portalOption: Portal) => (
      <LoginRequiredModal
        title={REVEIW_LOGIN[0]}
        description={REVEIW_LOGIN[1]}
        onClose={portalOption.close}
        onLoginClick={loggingLoginClick}
        onCancelClick={loggingCancelClick}
      />
    ));
  };

  const goReviewPageLogging = () => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'shop__shop_detail__review_write__entry__click',
      value: storeDetail.name,
    });
    isomorphicSessionStorage.setItem('enterReview', new Date().getTime().toString());
  };

  return (
    <button
      type="button"
      className={styles.container}
      onClick={() => {
        if (userInfo) {
          goReviewPageLogging();
          goReviewPage();
        } else {
          openLoginModal();
        }
      }}
    >
      리뷰 작성하기
    </button>
  );
}
