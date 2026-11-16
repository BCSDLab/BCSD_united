import FailedIcon from 'assets/svg/translation/modal-failed.svg';
import UnavailableIcon from 'assets/svg/translation/modal-unavailable.svg';
import { useEscapeKeyDown } from 'utils/hooks/ui/useEscapeKeyDown';
import { useOutsideClick } from 'utils/hooks/ui/useOutsideClick';

import styles from './TranslationErrorModal.module.scss';

export type TranslationErrorType = 'failed' | 'unavailable';

// TODO: 고정 UI 문구를 언어 레포로 옮기면 화면 언어로 표시한다. 그 전까지는 Figma 한국어 문구를 쓴다.
const CONTENT: Record<TranslationErrorType, { title: string; description: string[]; cases: string[] }> = {
  failed: {
    title: '번역에 실패했어요.',
    description: ['일시적인 오류로 번역을 완료하지 못했어요.', '잠시 후 다시 시도해 주세요.'],
    cases: ['네트워크 연결이 불안정한 경우', '번역 서비스에 일시적인 오류가 발생한 경우'],
  },
  unavailable: {
    title: '번역을 제공할 수 없어요.',
    description: ['선택한 언어의 번역문이 없어', '원문으로 표시돼요.'],
    cases: ['아직 번역이 제공되지 않은 언어인 경우', '번역 대상이 아닌 콘텐츠인 경우'],
  },
};

interface TranslationErrorModalProps {
  type: TranslationErrorType;
  onClose: () => void;
}

export default function TranslationErrorModal({ type, onClose }: TranslationErrorModalProps) {
  const { backgroundRef } = useOutsideClick({ onOutsideClick: onClose });
  useEscapeKeyDown({ onEscape: onClose });
  const { title, description, cases } = CONTENT[type];
  const Icon = type === 'failed' ? FailedIcon : UnavailableIcon;

  return (
    <div className={styles.background} ref={backgroundRef}>
      <div className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby="translation-error-title">
        <Icon className={styles.modal__icon} aria-hidden />
        <div className={styles.modal__text}>
          <h2 id="translation-error-title" className={styles.modal__title}>
            {title}
          </h2>
          <p className={styles.modal__description}>
            {description.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
        </div>
        <div className={styles.modal__cases}>
          <p className={styles['modal__cases-title']}>이런 경우에 발생할 수 있어요</p>
          <ul className={styles['modal__cases-list']}>
            {cases.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 확인 버튼 하나뿐인 알림 모달이라 열리면 바로 닫을 수 있게 한다 */}
        <button type="button" className={styles.modal__confirm} onClick={onClose} autoFocus>
          확인
        </button>
      </div>
    </div>
  );
}
