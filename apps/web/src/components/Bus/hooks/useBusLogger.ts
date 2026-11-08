import useLogger from 'utils/hooks/analytics/useLogger';

// 로깅 네이밍룰 v1.0 · Notion 버스 로깅 명세 5번(교통편 조회하기)
const CLICK_EVENTS = [
  { key: 'departure_box', label: 'bus__bus_search__search__departure_open__click', value: '출발지 선택' },
  { key: 'arrival_box', label: 'bus__bus_search__search__arrival_open__click', value: '목적지 선택' },
  { key: 'swap_destination', label: 'bus__bus_search__search__swap__click', value: '출발지 도착지 바꾸기' },
  { key: 'search_bus', label: 'bus__bus_search__search__click', value: '조회하기' },
  {
    key: 'search_result_departure_time',
    label: 'bus__bus_search_result__search__departure_time_open__click',
    value: '출발 시각 설정',
  },
  { key: 'departure_now', label: 'bus__bus_search_result__search__departure_time_now__click', value: '지금 출발' },
  {
    key: 'departure_time_confirm',
    label: 'bus__bus_search_result__search__departure_time_confirm__click',
    value: '', // 시간 변경, 시간 유지
  },
  {
    key: 'departure_location_confirm',
    label: 'bus__bus_search__search__departure_confirm__select',
    value: '', // 코리아텍, 천안역, 천안터미널
    category: 'select',
  },
  {
    key: 'arrival_location_confirm',
    label: 'bus__bus_search__search__arrival_confirm__select',
    value: '', // 코리아텍, 천안역, 천안터미널
    category: 'select',
  },
  {
    key: 'search_result_bus_type',
    label: 'bus__bus_search_result__filter__bus_type__select',
    value: '', // 전체 차종, 셔틀, 대성, 시내
    category: 'select',
  },
] as const;

export type ClickEventKey = (typeof CLICK_EVENTS)[number]['key'];

export type LoggingLocation = '코리아텍' | '천안역' | '천안터미널';
export type LoggingBusType = '전체 차종' | '셔틀' | '대성' | '시내';

export const loggingBusTypeMap = {
  ALL: '전체 차종',
  SHUTTLE: '셔틀',
  EXPRESS: '대성',
  CITY: '시내',
} as const;

export const useBusLogger = () => {
  const logger = useLogger();

  const logEvent = (eventKey: ClickEventKey, eventValue?: string) => {
    const event = CLICK_EVENTS.find(({ key }) => key === eventKey);
    if (event) {
      logger.actionEventClick({
        event_name: 'DA1',
        event_label: event.label,
        value: eventValue || event.value,
        event_category: 'category' in event ? event.category : 'click',
      });
    }
  };

  const logDepartureBoxClick = () => logEvent('departure_box');
  const logArrivalBoxClick = () => logEvent('arrival_box');
  const logSwapDestinationClick = () => logEvent('swap_destination');
  const logSearchBusClick = () => logEvent('search_bus');
  const logSearchResultDepartureTimeClick = () => logEvent('search_result_departure_time');
  const logDepartureNowClick = () => logEvent('departure_now');
  const logDepartureTimeConfirm = (isTimeChanged: boolean) =>
    logEvent('departure_time_confirm', isTimeChanged ? '시간 변경' : '시간 유지');
  const logDepartureLocationConfirm = (location: LoggingLocation) => logEvent('departure_location_confirm', location);
  const logArrivalLocationConfirm = (location: LoggingLocation) => logEvent('arrival_location_confirm', location);
  const logSearchResultBusType = (busType: LoggingBusType) => logEvent('search_result_bus_type', busType);

  return {
    logDepartureBoxClick,
    logArrivalBoxClick,
    logSwapDestinationClick,
    logSearchBusClick,
    logSearchResultDepartureTimeClick,
    logDepartureNowClick,
    logDepartureTimeConfirm,
    logDepartureLocationConfirm,
    logArrivalLocationConfirm,
    logSearchResultBusType,
  };
};
