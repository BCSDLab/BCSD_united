import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '@api/errors';
import {
  applyBlockReason,
  criteria,
  dDay,
  kstDay,
  validateProfile,
  validateRecruitment,
} from '@api/domains/team/policy';

const input = {
  category: 'PROJECT',
  title: '프로젝트',
  meeting_type: 'MIXED',
  activity_start_date: '2026-01-01',
  activity_end_date: '2026-02-01',
  deadline_date: '2026-02-20',
  recruitment_type: 'GENERAL',
  max_participants: 10,
  roles: [],
  description: '설명',
};
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
test('deadline is inclusive in KST and does not constrain the activity period', () => {
  assert.equal(kstDay(Date.parse('2026-10-28T14:59:59.999Z')), '2026-10-28');
  assert.equal(kstDay(Date.parse('2026-10-28T15:00:00Z')), '2026-10-29');
  assert.equal(dDay('RECRUITING', '2026-10-28', '2026-10-28'), 0);
  assert.equal(dDay('RECRUITING', '2026-10-28', '2026-10-29'), null);
  assert.equal(dDay('CLOSED', '2026-10-30', '2026-10-28'), null);
  assert.equal(validateRecruitment(input).deadline_date, '2026-02-20');
});
test('capacity excludes author and role totals never exceed ten', () => {
  assert.equal(validateRecruitment(input).max_participants, 10);
  assert.throws(
    () => validateRecruitment({ ...input, max_participants: 11 }),
    code('TEAM_RECRUITMENT_INVALID_ROLE_COMPOSITION'),
  );
  assert.throws(
    () =>
      validateRecruitment({
        ...input,
        recruitment_type: 'ROLE_BASED',
        roles: [
          { name: '개발', max_participants: 6 },
          { name: '디자인', max_participants: 5 },
        ],
      }),
    code('INVALID_REQUEST_BODY'),
  );
});
test('role names follow source trim and accent-insensitive uniqueness', () => {
  const roleInput = { ...input, recruitment_type: 'ROLE_BASED', roles: [{ name: ' PM ', max_participants: 1 }] };
  assert.equal(validateRecruitment(roleInput).roles[0]!.name, 'PM');
  assert.throws(
    () =>
      validateRecruitment({
        ...roleInput,
        roles: [
          { name: 'café', max_participants: 1 },
          { name: ' CAFE ', max_participants: 1 },
        ],
      }),
    code('INVALID_REQUEST_BODY'),
  );
});
test('activity ongoing and end date form mutually exclusive valid states', () => {
  const p = {
    profile_nickname: '이름',
    preferred_role: '개발',
    skills: [],
    self_introduction: '소개',
    activities: [{ title: '활동', started_at: '2026-01-01', ended_at: null, is_ongoing: true, description: '설명' }],
  };
  assert.equal(validateProfile(p).activities[0]!.ended_at, null);
  assert.throws(
    () => validateProfile({ ...p, activities: [{ ...p.activities[0], is_ongoing: false }] }),
    code('TEAM_RECRUITMENT_ACTIVITY_END_DATE_REQUIRED'),
  );
  assert.throws(
    () => validateProfile({ ...p, activities: [{ ...p.activities[0], ended_at: '2026-01-01' }] }),
    code('TEAM_RECRUITMENT_ACTIVITY_END_DATE_MUST_BE_NULL'),
  );
});
test('apply blockers preserve documented priority when reasons overlap', () => {
  const state = {
    deleted: false,
    userId: null,
    isAuthor: true,
    applied: true,
    status: 'CLOSED',
    deadline: '2026-01-01',
    full: true,
    hasProfile: false,
  };
  assert.equal(applyBlockReason(state, '2026-01-02'), 'LOGIN_REQUIRED');
  assert.equal(applyBlockReason({ ...state, userId: 1 }, '2026-01-02'), 'OWN_RECRUITMENT');
  assert.equal(applyBlockReason({ ...state, userId: 1, isAuthor: false }, '2026-01-02'), 'ALREADY_APPLIED');
  assert.equal(
    applyBlockReason({ ...state, userId: 1, isAuthor: false, applied: false }, '2026-01-02'),
    'RECRUITMENT_CLOSED',
  );
});
test('pagination clamps pages and limits including empty collections', () => {
  assert.deepEqual(criteria('999', '100', 51), {
    limit: 50,
    page: 2,
    offset: 50,
    total_count: 51,
    total_page: 2,
    current_page: 2,
  });
  assert.equal(criteria('-2', '0', 0).page, 1);
});
