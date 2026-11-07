import type { LoggingEventName, LoggingTarget, LoggingTeam, NamingRuleEventLabel } from 'lib/gtag';
import type { SubmenuTitle } from 'static/category';

type ShortcutPosition = 'header' | 'footer';

/**
 * 헤더·푸터 바로가기 로깅. 기존 로깅은 team과 공용 label(header·footer)을 쓰고,
 * 네이밍룰 v1.0으로 바꾼 서비스는 event_name과 위치별 label을 쓴다.
 */
type ShortcutLoggingInfo =
  | { team: LoggingTeam; value: string }
  | ({ event_name: LoggingEventName; value: string } & Record<ShortcutPosition, NamingRuleEventLabel>);

export const SHORTCUT_LOGGING_MAP: Partial<Record<SubmenuTitle, ShortcutLoggingInfo>> = {
  공지사항: {
    event_name: 'DA2',
    value: '공지사항',
    header: 'board__header__notice_entry__header_entry__click',
    footer: 'board__footer__notice_entry__footer_entry__click',
  },
  분실물: {
    event_name: 'DA2',
    value: '분실물',
    header: 'board__header__lost_item_entry__header_entry__click',
    footer: 'board__footer__lost_item_entry__footer_entry__click',
  },
  '버스 교통편': {
    event_name: 'DA1',
    value: '버스 교통편',
    header: 'bus__header__route__click',
    footer: 'bus__footer__route__click',
  },
  '버스 시간표': {
    event_name: 'DA1',
    value: '버스 시간표',
    header: 'bus__header__timetable__click',
    footer: 'bus__footer__timetable__click',
  },
  식단: {
    event_name: 'DA1',
    value: '식단',
    header: 'cafeteria__header__cafeteria_entry__header_entry__click',
    footer: 'cafeteria__footer__cafeteria_entry__footer_entry__click',
  },
  시간표: {
    event_name: 'DA1',
    value: '시간표',
    header: 'timetable__header__timetable_entry__header_entry__click',
    footer: 'timetable__footer__timetable_entry__footer_entry__click',
  },
  복덕방: { team: 'BUSINESS', value: '복덕방' },
  주변상점: { team: 'BUSINESS', value: '주변상점' },
  '교내 시설물 정보': {
    event_name: 'DA2',
    value: '교내 시설물 정보',
    header: 'facility__header__facility_entry__header_entry__click',
    footer: 'facility__footer__facility_entry__footer_entry__click',
  },
  '학교 부서 정보': {
    event_name: 'DA2',
    value: '학교 부서 정보',
    header: 'department__header__department_entry__header_entry__click',
    footer: 'department__footer__department_entry__footer_entry__click',
  },
  '코인 사장님': { team: 'BUSINESS', value: '코인 사장님' },
  쪽지: {
    event_name: 'DA2',
    value: '쪽지',
    header: 'chat__header__chat_entry__header_entry__click',
    footer: 'chat__footer__chat_entry__footer_entry__click',
  },
  동아리: { team: 'CAMPUS', value: '동아리' },
  '팀원 모집': { team: 'CAMPUS', value: '팀원 모집' },
};

/** 헤더·푸터 바로가기 클릭 로그. 로깅 대상이 아닌 메뉴면 `null`이다 */
export const getShortcutLog = (
  title: SubmenuTitle,
  position: ShortcutPosition,
): (LoggingTarget & { value: string }) | null => {
  const info = SHORTCUT_LOGGING_MAP[title];
  if (!info) return null;

  if ('event_name' in info) return { event_name: info.event_name, event_label: info[position], value: info.value };

  return { team: info.team, event_label: position, value: info.value };
};
