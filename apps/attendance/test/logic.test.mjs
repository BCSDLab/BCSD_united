import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAY_MS,
  DEBOUNCE_MS,
  HOUR_MS,
  MAX_SESSION_MS,
  decideTap,
  kstDayStart,
  kstWeekStart,
  summarize,
} from '../src/logic.ts';

// 2026-11-10(화) 00:00 KST
const TUE = Date.UTC(2026, 10, 9, 15, 0, 0);
const MON = TUE - DAY_MS;

const session = (overrides) => ({ memberId: '가', checkIn: TUE, checkOut: null, autoClosed: false, ...overrides });

test('KST 날짜·주 경계는 UTC 자정이 아니라 한국 시간 기준이다', () => {
  assert.equal(kstDayStart(TUE + 5 * HOUR_MS), TUE);
  assert.equal(kstDayStart(TUE - 1), TUE - DAY_MS);
  assert.equal(kstWeekStart(TUE + 5 * HOUR_MS), MON);
  assert.equal(kstWeekStart(MON), MON);
  // 일요일 23:59는 직전 월요일이 속한 주
  assert.equal(kstWeekStart(MON - 1), MON - 7 * DAY_MS);
});

test('태그는 입실과 퇴실을 번갈아 만든다', () => {
  assert.deepEqual(decideTap(null, TUE), { kind: 'check-in' });
  assert.deepEqual(decideTap(session({}), TUE + HOUR_MS), { kind: 'check-out' });
  assert.deepEqual(decideTap(session({ checkOut: TUE + HOUR_MS }), TUE + 2 * HOUR_MS), { kind: 'check-in' });
});

test('디바운스 안의 태그와 직전 이벤트보다 이른 재전송은 무시한다', () => {
  assert.deepEqual(decideTap(session({}), TUE + DEBOUNCE_MS - 1), { kind: 'ignore' });
  assert.deepEqual(decideTap(session({}), TUE - HOUR_MS), { kind: 'ignore' });
  assert.deepEqual(decideTap(session({}), TUE + DEBOUNCE_MS), { kind: 'check-out' });
});

test('최대 길이를 넘긴 미퇴실 세션은 최대 길이 시점에 자동 종료하고 새로 입실한다', () => {
  assert.deepEqual(decideTap(session({}), TUE + MAX_SESSION_MS), {
    kind: 'expire-and-check-in',
    closeAt: TUE + MAX_SESSION_MS,
  });
  assert.deepEqual(decideTap(session({}), TUE + MAX_SESSION_MS - 1), { kind: 'check-out' });
});

test('체류 시간은 오늘/이번 주 경계로 잘리고 입실 중이면 현재까지 더한다', () => {
  const now = TUE + 3 * HOUR_MS;
  const members = [
    { id: '가', name: '가' },
    { id: '나', name: '나' },
  ];
  const sessions = [
    // 월요일 22:00 → 화요일 01:00: 오늘 1시간, 이번 주 3시간
    session({ memberId: '가', checkIn: TUE - 2 * HOUR_MS, checkOut: TUE + HOUR_MS }),
    // 화요일 02:00부터 입실 중: 현재까지 1시간
    session({ memberId: '가', checkIn: TUE + 2 * HOUR_MS }),
    // 지난주 세션은 합산하지 않는다
    session({ memberId: '나', checkIn: MON - 8 * DAY_MS, checkOut: MON - 8 * DAY_MS + HOUR_MS }),
  ];
  const [first, second] = summarize(members, sessions, now);
  assert.equal(first.name, '가');
  assert.equal(first.present, true);
  assert.equal(first.since, TUE + 2 * HOUR_MS);
  assert.equal(first.todayMs, 2 * HOUR_MS);
  assert.equal(first.weekMs, 4 * HOUR_MS);
  assert.equal(first.firstInToday, TUE + 2 * HOUR_MS);
  assert.equal(second.present, false);
  assert.equal(second.weekMs, 0);
});

test('퇴근 태그가 없는 세션은 입실 중으로 보지 않고 시간 합계에서 빼며 건수만 센다', () => {
  const now = TUE + 20 * HOUR_MS;
  const sessions = [
    // 최대 길이를 넘겨 열려 있는 세션
    session({ checkIn: TUE }),
    // 다음 태그로 자동 종료된 세션
    session({ checkIn: TUE + 8 * HOUR_MS, checkOut: TUE + 8 * HOUR_MS + MAX_SESSION_MS, autoClosed: true }),
    // 정상 세션 1시간
    session({ checkIn: TUE + 17 * HOUR_MS, checkOut: TUE + 18 * HOUR_MS }),
  ];
  const [member] = summarize([{ id: '가', name: '가' }], sessions, now);
  assert.equal(member.present, false);
  assert.equal(member.todayMs, HOUR_MS);
  assert.equal(member.weekMs, HOUR_MS);
  assert.equal(member.unrecordedWeek, 2);
});
