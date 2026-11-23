import { useState } from 'react';

import showToast from 'utils/ts/showToast';

const useClickArrow = (length: number) => {
  const [selectedIndex, setImgIndex] = useState(0);
  const imgIndex = Math.min(selectedIndex, Math.max(0, length - 1));
  const clickLeftArrow = () => {
    if (length === 0) return;
    if (imgIndex === 0) {
      showToast('info', '첫 이미지입니다.');
    } else {
      setImgIndex(imgIndex - 1);
    }
  };
  const clickRightArrow = () => {
    if (length === 0) return;
    if (imgIndex >= length - 1) {
      showToast('info', '마지막 이미지입니다.');
    } else {
      setImgIndex(imgIndex + 1);
    }
  };

  return { imgIndex, clickLeftArrow, clickRightArrow };
};

export default useClickArrow;
