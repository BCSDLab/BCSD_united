import type { FilterState } from 'components/Articles/components/LostItemFilterContent';
import type { NamingRuleEventLabel } from 'lib/gtag';
import { CATEGORY_OPTIONS, ITEM_TYPE_OPTIONS, LIST_OPTIONS, STATUS_OPTIONS } from 'static/filterOptions';
import useLogger from 'utils/hooks/analytics/useLogger';

// 로깅 네이밍룰 v1.0 · Notion 게시판(커뮤니티) 로깅 명세 11번(분실물)
const EVENT_NAME = 'DA2';

export type FindUserCategory = '카드' | '신분증' | '지갑' | '전자제품' | '기타';

// 추후 로깅 수정 가능성을 염두해두고 남겨둡니다.
export type ReportCategory = '주제에 맞지 않음' | '스팸' | '욕설' | '개인정보' | '기타';

type ArticleType = '분실물' | '습득물';
type LoginPopupAnswer = '닫기' | '로그인하기';

const ALL_FILTER_VALUE = '전체';

const labelOf = <K extends string>(options: ReadonlyArray<{ key: K; label: string }>, key: K) =>
  options.find((option) => option.key === key)?.label ?? ALL_FILTER_VALUE;

/**
 * 11-23 필터 적용의 추가 파라미터. 매번 네 키를 모두 보내고 기본·전체 상태는 '전체'로 쓴다.
 * 복수 선택(물품 종류)은 화면에 정의된 순서로 '|'로 잇는다.
 */
const toFilterParams = (filter: FilterState) => {
  const itemTypes = ITEM_TYPE_OPTIONS.filter(({ key }) => filter.category.includes(key)).map(({ label }) => label);

  return {
    filter_scope: filter.author === 'ALL' ? ALL_FILTER_VALUE : labelOf(LIST_OPTIONS, filter.author),
    filter_post_type: filter.type === 'ALL' ? ALL_FILTER_VALUE : labelOf(CATEGORY_OPTIONS, filter.type),
    filter_item_type: itemTypes.length > 0 ? itemTypes.join('|') : ALL_FILTER_VALUE,
    filter_status: filter.foundStatus === 'ALL' ? ALL_FILTER_VALUE : labelOf(STATUS_OPTIONS, filter.foundStatus),
  };
};

export const useArticlesLogger = () => {
  const logger = useLogger();

  const logClick = (event_label: NamingRuleEventLabel, value: string, event_category = 'click') =>
    logger.actionEventClick({ event_name: EVENT_NAME, event_label, value, event_category });

  // 11-1
  const logItemWriteClick = () => logClick('board__lost_item_list__lost_item_write__entry__click', '글쓰기');
  // 11-7·11-8: 글 종류(주인을 찾아요·잃어버렸어요) 선택은 같은 label에 value로 구분한다
  const logFindUserWriteClick = () =>
    logClick('board__lost_item_list__lost_item_write__post_type__select', '주인을 찾아요', 'select');
  const logLostItemWriteClick = () =>
    logClick('board__lost_item_list__lost_item_write__post_type__select', '잃어버렸어요', 'select');
  // 11-3·11-10
  const logFindUserAddItemClick = () =>
    logClick('board__found_item_write__lost_item_write__item_add__click', '물품 추가');
  const logLostItemAddItemClick = () =>
    logClick('board__lost_item_write__lost_item_write__item_add__click', '물품 추가');
  // 11-4·11-11
  const logFindUserWriteConfirmClick = () =>
    logClick('board__found_item_write__lost_item_write__submit', '작성완료', 'submit');
  const logLostItemWriteConfirmClick = () =>
    logClick('board__lost_item_write__lost_item_write__submit', '작성완료', 'submit');
  // 11-5·11-6
  const logFindUserDeleteClick = (value: ArticleType) =>
    logClick('board__lost_item_detail__lost_item_delete__open__click', value);
  const logFindUserDeleteConfirmClick = () =>
    logClick('board__lost_item_detail__lost_item_delete__confirm__click', '확인');
  // 11-2·11-9: 실제 선택한 품목명
  const logFindUserCategory = (category: FindUserCategory) =>
    logClick('board__found_item_write__lost_item_write__item_category__select', category, 'select');
  const logLostItemCategory = (category: FindUserCategory) =>
    logClick('board__lost_item_write__lost_item_write__item_category__select', category, 'select');
  // 11-13·11-14
  const logItemPostReportClick = () => logClick('board__lost_item_detail__lost_item_report__entry__click', '신고하기');
  const logItemPostReportConfirm = () =>
    logClick('board__lost_item_report__lost_item_report__submit', '신고하기', 'submit');
  // 11-22·11-23: 적용하지 않고 닫으면 적용 이벤트를 보내지 않는다
  const logLostItemFilter = () => logClick('board__lost_item_list__filter__open__click', '분실물');
  const logLostItemFilterApply = (filter: FilterState) =>
    logger.actionEventClick({
      event_name: EVENT_NAME,
      event_label: 'board__lost_item_list__filter__apply__click',
      value: '분실물',
      params: toFilterParams(filter),
    });
  // 11-24
  const logLostItemPostEntry = (value: ArticleType) =>
    logClick('board__lost_item_list__lost_item_detail__entry__click', value);
  // 11-25·11-26: 로그인 안내 팝업은 누른 버튼의 label 하나만 보낸다
  const logLostItemMessageLoginRequest = (value: LoginPopupAnswer) =>
    logClick(
      value === '로그인하기'
        ? 'account__lost_item_detail__login_popup__login_entry__click'
        : 'account__lost_item_detail__login_popup__close__click',
      value,
    );
  const logLostItemWriteLoginRequest = (value: LoginPopupAnswer) =>
    logClick(
      value === '로그인하기'
        ? 'account__lost_item_list__login_popup__login_entry__click'
        : 'account__lost_item_list__login_popup__close__click',
      value,
    );
  // 11-27·11-28·11-29
  const logLostItemStateChange = (value: ArticleType) =>
    logClick('board__lost_item_detail__lost_item_status__open__click', value);
  const logLostItemFound = (value: ArticleType) =>
    logClick('board__lost_item_detail__lost_item_status__found_confirm__click', value);
  const logLostItemModify = (value: ArticleType) =>
    logClick('board__lost_item_detail__lost_item_edit__entry__click', value);
  // 11-30: 분실물 수정과 습득물 수정은 화면이 달라 label이 다르다
  const logLostItemModifyComplete = (value: ArticleType) =>
    logClick(
      value === '분실물'
        ? 'board__lost_item_edit__lost_item_edit__submit'
        : 'board__found_item_edit__lost_item_edit__submit',
      value,
      'submit',
    );
  // 11-12
  const logItemMessageSend = (value: '분실물 쪽지 보내기' | '습득물 쪽지 보내기') =>
    logClick('board__lost_item_detail__lost_item_message__entry__click', value);

  return {
    logItemWriteClick,
    logFindUserWriteClick,
    logLostItemWriteClick,
    logFindUserAddItemClick,
    logLostItemAddItemClick,
    logLostItemCategory,
    logFindUserWriteConfirmClick,
    logLostItemWriteConfirmClick,
    logFindUserDeleteClick,
    logFindUserDeleteConfirmClick,
    logFindUserCategory,
    logItemPostReportClick,
    logItemPostReportConfirm,
    logLostItemFilter,
    logLostItemFilterApply,
    logLostItemPostEntry,
    logLostItemMessageLoginRequest,
    logLostItemWriteLoginRequest,
    logLostItemStateChange,
    logLostItemFound,
    logLostItemModify,
    logLostItemModifyComplete,
    logItemMessageSend,
  };
};
