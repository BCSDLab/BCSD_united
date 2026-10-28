import Portal from 'components/Portal';
import { useBodyScrollLock } from 'utils/hooks/ui/useBodyScrollLock';

import styles from './ImagePreview.module.scss';

// KOIN_ORDER_WEBVIEW ReviewCard의 이미지 미리보기 이전. 배경을 누르면 닫고, 여는 동안 body 스크롤을 막는다
interface ImagePreviewProps {
  src: string | null;
  onClose: () => void;
}

export default function ImagePreview({ src, onClose }: ImagePreviewProps) {
  useBodyScrollLock(!!src);

  if (!src) return null;

  return (
    <Portal>
      <div role="presentation" tabIndex={-1} className={styles.preview} onClick={onClose}>
        <div role="presentation" tabIndex={-1} className={styles.preview__frame} onClick={(e) => e.stopPropagation()}>
          {/* 리뷰 이미지는 KOIN_ORDER_WEBVIEW와 같이 업로드 원본 URL로 요청한다. */}
          <img src={src} alt="" className={styles.preview__image} />
        </div>
      </div>
    </Portal>
  );
}
