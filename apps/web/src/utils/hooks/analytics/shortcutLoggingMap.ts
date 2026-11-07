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
  공지사항: { team: 'CAMPUS', value: '공지사항' },
  분실물: { team: 'CAMPUS', value: '분실물' },
  '버스 교통편': { team: 'CAMPUS', value: '버스 교통편' },
  '버스 시간표': { team: 'CAMPUS', value: '버스 시간표' },
  식단: { team: 'CAMPUS', value: '식단' },
  시간표: { team: 'USER', value: '시간표' },
  복덕방: { team: 'BUSINESS', value: '복덕방' },
  주변상점: { team: 'BUSINESS', value: '주변상점' },
  '교내 시설물 정보': { team: 'CAMPUS', value: '교내 시설물 정보' },
  '학교 부서 정보': {
    event_name: 'DA2',
    value: '학교 부서 정보',
    header: 'department__header__department_entry__header_entry__click',
    footer: 'department__footer__department_entry__footer_entry__click',
  },
  '코인 사장님': { team: 'BUSINESS', value: '코인 사장님' },
  쪽지: { team: 'CAMPUS', value: '쪽지' },
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
