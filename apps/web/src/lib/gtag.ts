import { IS_STAGE } from 'static/url';

export type LoggingTeam = 'CAMPUS' | 'BUSINESS' | 'USER';

/** 로깅 네이밍룰 v1.0의 GA 이벤트명. 서비스 담당자 기준으로 정해진다 */
export type LoggingEventName = 'DA1' | 'DA2';

/** 로깅 네이밍룰 v1.0의 event_label. `service__page__feature[__detail]__category` 4~5구간이다 */
export type NamingRuleEventLabel = `${string}__${string}__${string}__${string}`;

/** 명세에 정의된 추가 파라미터. 검색어·필터처럼 동적인 값은 label이 아니라 여기로 보낸다 */
export type LoggingExtraParams = Record<string, string | number>;

/**
 * 로깅 네이밍룰 개편으로 GA 이벤트명이 team(CAMPUS 등)에서 event_name(DA1 등)으로 바뀐다.
 * 기존 로깅은 team을 그대로 쓰고, 신규 로깅만 event_name·새 label 형식·추가 파라미터를 사용한다.
 * 이후 기존 로깅 변경이 완료되면 team은 제거하고 event_name만 사용하도록
 * 리팩토링한다.
 */
export type LoggingTarget =
  | { team: LoggingTeam; event_name?: never; event_label: string; screen_view?: never; params?: never }
  | {
      team?: never;
      event_name: LoggingEventName;
      event_label: NamingRuleEventLabel;
      /** label의 두 번째 구간과 다른 화면명으로 승인된 예외(동결 명세 등)만 지정한다. 없으면 label에서 계산한다 */
      screen_view?: string;
      params?: LoggingExtraParams;
    };

type GTagEvent = LoggingTarget & {
  event_category: string;
  value: string;
  duration_time?: number;
  previous_page?: string;
  current_page?: string;
};

/** 네이밍룰 v1.0의 screen_view는 event_label의 두 번째 구간(page)과 같은 고정 문자열이다 */
export const getScreenView = (eventLabel: NamingRuleEventLabel) => eventLabel.split('__')[1];

interface SessionEvent {
  event_label: string;
  value: string;
  event_category: string;
  custom_session_id: string;
}

export const GA_TRACKING_ID = process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID;

// https://developers.google.com/analytics/devguides/collection/gtagjs/pages
export const pageView = (url: string, userId?: string) => {
  if (typeof window === 'undefined' || typeof window.gtag === 'undefined' || !GA_TRACKING_ID) return;

  window.gtag('config', GA_TRACKING_ID, {
    page_path: url,
    user_id: userId,
  });
};

// https://developers.google.com/analytics/devguides/collection/gtagjs/events
export const event = (props: GTagEvent) => {
  if (typeof window === 'undefined' || typeof window.gtag === 'undefined') return;

  const { event_category, event_label, value, duration_time, previous_page, current_page } = props;
  // 기존 team 로깅은 screen_view·추가 파라미터 없이 그대로 보낸다
  const isNamingRule = props.event_name !== undefined;
  const eventName = isNamingRule ? props.event_name : props.team;
  const screenView = isNamingRule ? (props.screen_view ?? getScreenView(props.event_label)) : undefined;
  const params = isNamingRule ? props.params : undefined;

  window.gtag('event', eventName, {
    // 추가 파라미터가 공통 필드를 덮어쓰지 않도록 먼저 펼친다
    ...params,
    event_category,
    event_label,
    value,
    duration_time,
    previous_page,
    current_page,
    screen_view: screenView,
  });

  if (IS_STAGE) {
    // eslint-disable-next-line no-console -- stage 환경에서만 분석 이벤트 디버깅용으로 출력
    console.table({
      '이벤트명(team/event_name)': eventName,
      '이벤트 Category': event_category,
      '이벤트 Title': event_label,
      값: value,
      '화면(screen_view)': screenView,
      '체류 시간': duration_time,
      '이전 카테고리': previous_page,
      '현재 페이지': current_page,
      ...params,
    });
  }
};

export const startSession = ({ event_label, value, event_category, custom_session_id }: SessionEvent) => {
  if (typeof window === 'undefined' || typeof window.gtag === 'undefined') return;

  window.gtag('event', 'session_start', {
    event_label,
    value,
    event_category,
    custom_session_id,
  });

  if (IS_STAGE) {
    // eslint-disable-next-line no-console -- stage 환경에서만 분석 이벤트 디버깅용으로 출력
    console.table({
      '세션 시작': event_label,
      값: value,
      '이벤트 Category': event_category,
      '커스텀 세션 ID': custom_session_id,
    });
  }
};
