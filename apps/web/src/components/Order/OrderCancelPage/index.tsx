import { type ChangeEvent, useState } from 'react';
import { cn } from '@bcsdlab/utils';
import { useMutation } from '@tanstack/react-query';

import { orderMutations } from 'api/order/mutations';
import CheckIcon from 'assets/svg/Order/Result/check-icon.svg';
import useOrderExit from 'components/Order/common/hooks/useOrderExit';
import CenterModal from 'components/Store/mobile/common/CenterModal';
import Button from 'components/ui/Button';
import { isKoinError } from 'interfaces/APIError';
import showToast from 'utils/ts/showToast';

import styles from './OrderCancelPage.module.scss';

// KOIN_ORDER_WEBVIEW pages/OrderFinish/OrderCancel 이전(주문 취소 사유 선택).
const ORDER_CANCEL_REASONS: string[] = [
  '단순 변심이에요',
  '주소를 잘못 입력했어요',
  '결제를 잘못했어요',
  '메뉴를 다시 고르고 싶어요',
  '기타',
];

const OTHER_REASON = '기타';

interface OrderCancelPageProps {
  paymentId: number;
}

export default function OrderCancelPage({ paymentId }: OrderCancelPageProps) {
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
  const [selectedCancelReason, setSelectedCancelReason] = useState('');
  const [customCancelReason, setCustomCancelReason] = useState('');

  const { close: closeOrder } = useOrderExit();

  // 취소에 성공한 뒤 화면이 남아 있어도(앱이 이동을 처리하지 않는 등) 다시 취소하지 못하게 성공 후에도 막는다
  const {
    mutate: cancelPayment,
    isPending: isCancelPending,
    isSuccess: isCanceled,
  } = useMutation({
    ...orderMutations.cancelPayment(paymentId),
    onError: (error) => {
      if (isKoinError(error)) showToast('error', error.message);
    },
  });

  const isSubmitButtonDisabled =
    selectedCancelReason === '' || (selectedCancelReason === OTHER_REASON && customCancelReason.length <= 1);

  const handleReason = (reason: string) => {
    if (reason === selectedCancelReason) {
      setSelectedCancelReason('');

      return;
    }

    setSelectedCancelReason(reason);
  };

  const handleCustomCancelReason = (e: ChangeEvent<HTMLInputElement>) => {
    if (selectedCancelReason !== OTHER_REASON) return;
    setCustomCancelReason(e.target.value);
  };

  const handleClickContinueCancel = () => {
    const body = {
      cancel_reason: selectedCancelReason === OTHER_REASON ? customCancelReason : selectedCancelReason,
    };

    // 앱은 웹뷰를 닫으면서 진행 중인 요청도 끊을 수 있어, 앱·웹 모두 취소가 끝난 뒤에 주문 흐름을 벗어난다
    cancelPayment(body, { onSuccess: closeOrder });
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.container__title}>주문을 취소하시겠어요?</div>
        <div className={styles.container__description}>주문 취소 사유를 선택해 주세요.</div>
        <div className={styles.container__body}>
          <div className={styles.reasons}>
            {ORDER_CANCEL_REASONS.map((orderCancelReason, index) => (
              <label
                htmlFor={orderCancelReason}
                key={orderCancelReason}
                className={cn({
                  [styles.reason]: true,
                  [styles['reason--divided']]: index !== 0,
                  [styles['reason--spaced']]: index !== ORDER_CANCEL_REASONS.length - 1,
                })}
              >
                <div className={styles.reason__row}>
                  <div className={styles.reason__radio}>
                    <input
                      name="reason"
                      type="checkbox"
                      className={styles.reason__input}
                      id={orderCancelReason}
                      checked={selectedCancelReason === orderCancelReason}
                      onChange={() => handleReason(orderCancelReason)}
                    />
                    <div className={styles.reason__circle} />
                    <div className={styles.reason__check}>
                      <CheckIcon />
                    </div>
                  </div>
                  <div className={styles.reason__text}>
                    <div>{orderCancelReason}</div>
                    <div className={styles.reason__count}>
                      {orderCancelReason === OTHER_REASON ? `${customCancelReason.length}/150` : ''}
                    </div>
                  </div>
                </div>
                {orderCancelReason === OTHER_REASON && (
                  <input
                    value={customCancelReason}
                    className={styles.reason__custom}
                    placeholder="취소 사유를 최소 2자 이상 입력해주세요."
                    onChange={handleCustomCancelReason}
                    maxLength={150}
                    onClick={() => setSelectedCancelReason(OTHER_REASON)}
                  />
                )}
              </label>
            ))}
          </div>
          <Button
            className={cn({
              [styles.container__submit]: true,
              [styles['container__submit--disabled']]: isSubmitButtonDisabled,
            })}
            onClick={() => setIsCancelModalOpen(true)}
            disabled={isSubmitButtonDisabled}
          >
            취소하기
          </Button>
        </div>
      </div>
      <CenterModal isOpen={isCancelModalOpen} onClose={() => setIsCancelModalOpen(false)}>
        <div className={styles.modal}>
          <div>주문을 취소하시겠어요?</div>
          <div className={styles.modal__buttons}>
            <Button
              onClick={() => setIsCancelModalOpen(false)}
              className={cn({ [styles.modal__button]: true, [styles['modal__button--stop']]: true })}
            >
              닫기
            </Button>
            {/* 취소가 끝날 때까지 이 화면에 머무르므로, 그사이나 성공 뒤에 다시 눌러 요청이 중복되지 않게 막는다 */}
            <Button
              onClick={handleClickContinueCancel}
              className={styles.modal__button}
              disabled={isCancelPending || isCanceled}
            >
              취소하기
            </Button>
          </div>
        </div>
      </CenterModal>
    </div>
  );
}
