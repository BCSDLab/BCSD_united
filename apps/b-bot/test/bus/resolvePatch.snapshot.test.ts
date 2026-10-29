import { describe, expect, it } from 'vitest';
import { resolvePatches, type RawPatch } from '~/services/bus/patch';
import type { BusConversion, BusRoute } from '~/services/bus/types';

/**
 * `resolvePatch`가 항목마다 내놓는 결과(패치 또는 거절 사유)를 통째로 고정한다.
 * 함수를 나누는 리팩토링에서 문구 하나라도 바뀌면 여기서 보인다.
 */
const route = (over: Partial<BusRoute> = {}): BusRoute => ({
  region: '천안',
  route_type: '등교',
  route_name: '천안역',
  node_info: [
    { name: '터미널' },
    { name: '천안역 (학화호두과자 앞)' },
    { name: '천안역 2번 출구' },
    { name: '대학(본교)' },
  ],
  route_info: [
    { name: '1회', running_days: ['MON', 'WED'], arrival_time: ['08:10', '08:15', '08:16', '08:50'] },
    { name: '2회', arrival_time: ['09:10', null, null, '09:50'] },
    { name: '3회', arrival_time: ['10:10', null, null, '10:50'] },
  ],
  ...over,
});

const conversion = (semester: 'REGULAR' | 'SEASONAL', period: string): BusConversion => ({
  payloads: [
    {
      target: 'commuting',
      semester_type: semester,
      body: {
        commuting_bus_timetables: [
          route(),
          route({ route_type: '하교', route_name: '천안역' }),
          route({ region: '청주', route_name: '청주 터미널' }),
        ],
      },
    },
  ],
  version_update: {
    type: 'shuttle_bus_timetable',
    title: semester === 'REGULAR' ? '정규학기' : '계절학기',
    content: period,
  },
  provenance: {},
  warnings: [],
});

const regularOnly = [conversion('REGULAR', '2026-03-02~2026-06-19')];
const both = [conversion('REGULAR', '2026-03-02~2026-06-19'), conversion('SEASONAL', '2026-06-22~2026-08-14')];

const raw = (over: Partial<RawPatch>): RawPatch => ({
  semester: '',
  region: '천안',
  direction: '등교',
  route: '천안역',
  field: 'arrival_time',
  trip: '1회',
  stop: '터미널',
  value: '08:05',
  days: '',
  newStop: '',
  referenceStop: '',
  position: '',
  ...over,
});

const CASES: Array<[string, Partial<RawPatch>, BusConversion[]?]> = [
  ['기간 — 학기 하나', { field: 'period', value: '2026-03-03~2026-06-20' }],
  ['기간 — 형식 오류', { field: 'period', value: '3월부터' }],
  ['기간 — 거꾸로', { field: 'period', value: '2026-06-20~2026-03-03' }],
  ['기간 — 없는 학기 지정, 학기 하나', { field: 'period', semester: '계절학기', value: '2026-03-03~2026-06-20' }],
  ['기간 — 없는 학기 지정, 학기 여럿', { field: 'period', semester: '방학기간', value: '2026-03-03~2026-06-20' }, both],
  ['기간 — 학기 여럿, 미지정', { field: 'period', value: '2026-03-03~2026-06-20' }, both],
  ['기간 — 학기 여럿, 지정', { field: 'period', semester: '계절학기', value: '2026-06-23~2026-08-15' }, both],
  ['노선 없음', { route: '대전', region: '', direction: '' }],
  [
    '노선 없음 — 이름 없이',
    { route: '', region: '', direction: '', field: 'route_name', value: 'x' },
    [conversion('REGULAR', 'x')].map((c) => ({ ...c, payloads: [] })),
  ],
  ['노선 여럿', { direction: '' }],
  ['학기 여럿', {}, both],
  ['노선명 변경', { field: 'route_name', value: '천안역 경유' }],
  ['노선명 비움', { field: 'route_name', value: ' ' }],
  ['노선 삭제', { field: 'remove_route' }],
  ['회차 없음', { trip: '9회' }],
  ['회차 미지정', { trip: '' }],
  ['도착시각', {}],
  ['도착시각 — 부분 일치 정류장', { stop: '학화호두과자' }],
  ['도착시각 — 정류장 여럿', { stop: '천안역' }],
  ['도착시각 — 정류장 없음', { stop: '아산' }],
  ['도착시각 — 시각 오류', { value: '8시' }],
  ['운행요일', { field: 'running_days', days: '월수금' }],
  ['운행요일 — 해석 불가', { field: 'running_days', days: '가끔' }],
  ['회차 삭제', { field: 'remove_trip' }],
  ['정류장 삭제', { field: 'remove_stop' }],
  ['정류장 삭제 — 없음', { field: 'remove_stop', stop: '' }],
  ['회차 추가', { field: 'add_trip', trip: '4회', value: '11:10' }],
  ['회차 추가 — 이름 없음', { field: 'add_trip', trip: '', value: '' }],
  ['회차 추가 — 중복', { field: 'add_trip', trip: '2회', value: '' }],
  ['회차 추가 — 시각 오류', { field: 'add_trip', trip: '4회', value: '열한시' }],
  ['정류장 추가', { field: 'add_stop', newStop: '두정역', referenceStop: '터미널', position: 'after' }],
  ['정류장 추가 — 이름 없음', { field: 'add_stop', newStop: '' }],
  ['정류장 추가 — 중복', { field: 'add_stop', newStop: '대학(본교)', referenceStop: '터미널', position: 'after' }],
  ['정류장 추가 — 기준 없음', { field: 'add_stop', newStop: '두정역', referenceStop: '' }],
  ['정류장 추가 — 기준 여럿', { field: 'add_stop', newStop: '두정역', referenceStop: '천안역', position: 'after' }],
  ['정류장 추가 — 앞뒤 없음', { field: 'add_stop', newStop: '두정역', referenceStop: '터미널', position: '' }],
  ['지원하지 않는 항목', { field: 'color' }],
  ['회차 범위', { trip: '1~2회' }],
  ['회차 범위 — 노선 여럿', { trip: '1~2회', direction: '' }],
  ['회차 범위 — 해당 없음', { trip: '7~8회' }],
  ['회차 범위 — 학기 여럿', { trip: '1~2회' }, both],
];

describe('버스 수정 요청 해석 결과', () => {
  it.each(CASES)('%s', (_name, over, conversions = regularOnly) => {
    const problems: string[] = [];
    const patches = resolvePatches(raw(over), conversions, problems);
    expect({ patches, problems }).toMatchSnapshot();
  });
});
