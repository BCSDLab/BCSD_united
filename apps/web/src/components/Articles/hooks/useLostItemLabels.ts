import { CATEGORY_OPTIONS, STATUS_OPTIONS } from 'static/filterOptions';
import useServerMessage from 'utils/language/useServerMessage';

const labelOf = (options: ReadonlyArray<{ key: string; label: string }>, key: string) =>
  options.find((option) => option.key === key)?.label;

/** 분실물 서버 값(글 종류·분류·찾음 여부)을 화면 언어 문구로 바꾼다. 한국어 화면은 필터와 같은 문구 그대로다. */
export default function useLostItemLabels() {
  const message = useServerMessage();

  return {
    // `LOST`·`FOUND`가 아닌 값은 분실물로 표시한다
    type: (type: string) =>
      message('lost_item.type', type, labelOf(CATEGORY_OPTIONS, type) ?? labelOf(CATEGORY_OPTIONS, 'LOST')),
    // 분류는 서버가 한국어 원문(`카드` 등)으로 준다
    category: (category: string) => message('lost_item.category', category),
    foundStatus: (isFound: boolean) => {
      const status = isFound ? 'FOUND' : 'NOT_FOUND';

      return message('lost_item.found_status', status, labelOf(STATUS_OPTIONS, status));
    },
  };
}
