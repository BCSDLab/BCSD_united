import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '@api/errors';
import {
  canCreateQna,
  canDeleteQna,
  compareEvents,
  eventStatus,
  kstDate,
  lastWeek,
  localDateTime,
  localToUtc,
  normalizeName,
  recruitmentInfo,
  selectHotClub,
  validateClub,
  validateEvent,
  validateRecruitment,
} from '@api/domains/clubs/behavior';
import { planEventReminders } from '@api/domains/clubs/schedules';

const time = (value: string) => Date.parse(value);

test('weekly ranking uses period hits, includes inactive clubs, and retains first tied winner', () => {
  const clubs = [
    { id: 1, hits: 1000, last_week_hits: 999, is_active: true },
    { id: 2, hits: 12, last_week_hits: 0, is_active: false },
    { id: 3, hits: 112, last_week_hits: 100, is_active: true },
  ];
  assert.equal(selectHotClub(clubs)?.id, 2);
  assert.equal(selectHotClub([]), undefined);
  assert.equal(selectHotClub([{ id: 4, hits: 0, last_week_hits: 0 }])?.id, 4);
});

test('weekly periods are previous KST Monday through Sunday across year boundaries', () => {
  assert.deepEqual(lastWeek(time('2025-01-05T15:00:00Z')), { start: '2024-12-30', end: '2025-01-05' });
  assert.equal(kstDate(time('2025-01-05T14:59:59Z')), '2025-01-05');
  assert.equal(kstDate(time('2025-01-05T15:00:00Z')), '2025-01-06');
});

test('manager can answer but cannot ask; non-manager student can ask but cannot answer', () => {
  assert.equal(canCreateQna(true, null), false);
  assert.equal(canCreateQna(true, 1), true);
  assert.equal(canCreateQna(false, null), true);
  assert.equal(canCreateQna(false, 1), false);
});

test('QnA deletion belongs to its author or the supplied club manager', () => {
  assert.equal(canDeleteQna(10, 10, false), true);
  assert.equal(canDeleteQna(10, 11, false), false);
  assert.equal(canDeleteQna(10, 11, true), true);
  assert.equal(canDeleteQna(null, 11, false), false);
  assert.equal(canDeleteQna(null, 11, true), true);
});

test('recruitment boundaries include both start and end dates and expose dday only while recruiting', () => {
  assert.deepEqual(recruitmentInfo(null, null, null, '2025-07-01'), { status: 'NONE', dday: null });
  assert.deepEqual(recruitmentInfo(true, null, null, '2025-07-01'), { status: 'ALWAYS', dday: null });
  assert.deepEqual(recruitmentInfo(false, '2025-07-02', '2025-07-04', '2025-07-01'), { status: 'BEFORE', dday: null });
  assert.deepEqual(recruitmentInfo(false, '2025-07-02', '2025-07-04', '2025-07-02'), { status: 'RECRUITING', dday: 2 });
  assert.deepEqual(recruitmentInfo(false, '2025-07-02', '2025-07-04', '2025-07-04'), { status: 'RECRUITING', dday: 0 });
  assert.deepEqual(recruitmentInfo(false, '2025-07-02', '2025-07-04', '2025-07-05'), { status: 'CLOSED', dday: null });
});

test('recruitment validates mutually exclusive dates and permits a single-day period', () => {
  const valid = validateRecruitment({ is_always_recruiting: false, start_date: '2025-07-01', end_date: '2025-07-01' });
  assert.equal(valid.end_date, valid.start_date);
  assert.throws(
    () => validateRecruitment({ is_always_recruiting: true, start_date: '2025-07-01' }),
    (error: unknown) => error instanceof ApiError && error.code === 'MUST_BE_NULL_RECRUITMENT_PERIOD',
  );
  assert.throws(
    () => validateRecruitment({ is_always_recruiting: false }),
    (error: unknown) => error instanceof ApiError && error.code === 'REQUIRED_RECRUITMENT_PERIOD',
  );
  assert.throws(
    () => validateRecruitment({ is_always_recruiting: false, start_date: '2025-07-02', end_date: '2025-07-01' }),
    (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RECRUITMENT_PERIOD',
  );
});

test('event status uses a one-hour soon boundary and a one-minute inclusive end grace', () => {
  const start = '2025-07-01 01:00:00';
  const end = '2025-07-01 02:00:00';
  assert.equal(eventStatus(start, end, time('2025-06-30T23:59:59.999Z')), 'UPCOMING');
  assert.equal(eventStatus(start, end, time('2025-07-01T00:00:00Z')), 'SOON');
  assert.equal(eventStatus(start, end, time('2025-07-01T00:59:59.999Z')), 'SOON');
  assert.equal(eventStatus(start, end, time('2025-07-01T01:00:00Z')), 'ONGOING');
  assert.equal(eventStatus(start, end, time('2025-07-01T02:00:59.999Z')), 'ONGOING');
  assert.equal(eventStatus(start, end, time('2025-07-01T02:01:00Z')), 'ENDED');
});

test('recent event sorting puts ended events last; status sorting shares soon and ongoing priority', () => {
  const now = time('2025-07-01T01:00:00Z');
  const soon = {
    start_date: '2025-07-01 01:30:00',
    end_date: '2025-07-01 03:00:00',
    created_at: '2025-06-01 00:00:00',
  };
  const ongoing = {
    start_date: '2025-07-01 00:00:00',
    end_date: '2025-07-01 03:00:00',
    created_at: '2025-06-02 00:00:00',
  };
  const ended = {
    start_date: '2025-06-30 00:00:00',
    end_date: '2025-06-30 03:00:00',
    created_at: '2025-07-01 00:00:00',
  };
  assert.ok(compareEvents(soon, ended, 'RECENT', now) < 0);
  assert.ok(compareEvents(soon, ongoing, 'ONGOING', now) > 0);
});

test('local event timestamps are explicitly KST rather than machine timezone', () => {
  assert.equal(localToUtc('2025-07-01T00:30:00'), '2025-06-30 15:30:00');
  assert.equal(localDateTime('2025-06-30 15:30:00'), '2025-07-01T00:30:00');
  assert.throws(() => localToUtc('2025-02-30T00:00:00'));
  assert.throws(() => localToUtc('2025-07-01T25:00:00'));
});

test('event validation rejects nonpositive periods and duplicate image URLs', () => {
  const valid = {
    name: 'B-CON',
    introduce: '행사 소개',
    start_date: '2025-07-01T10:00:00',
    end_date: '2025-07-01T11:00:00',
    image_urls: ['https://example.com/a'],
  };
  assert.equal(validateEvent(valid).start_date, '2025-07-01 01:00:00');
  assert.throws(() => validateEvent({ ...valid, end_date: valid.start_date }));
  assert.throws(() => validateEvent({ ...valid, image_urls: ['https://example.com/a', 'https://example.com/a'] }));
});

test('club requests enforce source lengths, manager presence and eleven-digit phone format', () => {
  const valid = {
    name: 'BCSD Lab',
    image_url: 'https://example.com/image',
    club_category_id: 1,
    location: '학생회관',
    phone_number: '01012345678',
    club_managers: [{ user_id: 'manager' }],
    role: '회장',
    is_like_hidden: false,
  };
  assert.equal(validateClub(valid, 'request').normalized_name, 'bcsdlab');
  assert.equal(normalizeName(' B C\tS\nD '), 'bcsd');
  assert.throws(() => validateClub({ ...valid, phone_number: '010-1234-5678' }, 'request'));
  assert.throws(() => validateClub({ ...valid, club_managers: [] }, 'request'));
  assert.throws(() => validateClub({ ...valid, name: 'x'.repeat(21) }, 'request'));
});

test('reminder plans preserve KST previous-day noon and exact one-hour due times', () => {
  const plans = planEventReminders(1, '2025-07-02 01:00:00', false, time('2025-07-01T00:00:00Z'));
  assert.deepEqual(
    plans.map((plan) => new Date(plan.dueAt).toISOString()),
    ['2025-07-01T03:30:00.000Z', '2025-07-02T00:00:00.000Z'],
  );
});

test('late subscription skips the elapsed day reminder and dispatches an unnotified hour reminder immediately', () => {
  const now = time('2025-07-02T00:30:00Z');
  const plans = planEventReminders(1, '2025-07-02 01:00:00', false, now);
  assert.deepEqual(
    plans.map((plan) => plan.dueAt),
    [now],
  );
  assert.equal(planEventReminders(1, '2025-07-02 01:00:00', true, now).length, 0);
  assert.equal(planEventReminders(1, '2025-07-02 01:00:00', false, time('2025-07-02T01:00:01Z')).length, 0);
});
