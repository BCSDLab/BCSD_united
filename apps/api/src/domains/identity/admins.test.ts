import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adminOwnerBody, adminPagination, adminStudentBody, createAdminBody,
  ownerAdminChanges, validateAdminEmail, validateOwnerSearch,
} from '@api/domains/identity/admins';
import { ApiError } from '@api/errors';

function isBadRequest(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

test('manager accounts use exactly five digits and the university domain', () => {
  for (const email of ['koin00000@koreatech.ac.kr', 'koin99999@koreatech.ac.kr']) {
    assert.doesNotThrow(() => validateAdminEmail(email));
  }
  for (const email of [
    'student@koreatech.ac.kr', 'koin1234@koreatech.ac.kr', 'koin123456@koreatech.ac.kr',
    'KOIN12345@koreatech.ac.kr', 'koin12345@example.com', 'koin12345@koreatech.ac.kr.attacker.test',
  ]) {
    assert.throws(() => validateAdminEmail(email), isBadRequest);
  }
});

test('manager creation preserves password bytes and enforces track and name constraints', () => {
  const request = { email: 'koin12345@koreatech.ac.kr', password: 'ab-cd', name: '관리자', track_name: 'IOS' };
  assert.equal(createAdminBody.parse(request).password, 'ab-cd');
  assert.equal(createAdminBody.safeParse({ ...request, track_name: 'iOS' }).success, false);
  assert.equal(createAdminBody.safeParse({ ...request, name: '가'.repeat(50) }).success, true);
  assert.equal(createAdminBody.safeParse({ ...request, name: '가'.repeat(51) }).success, false);
  assert.equal(createAdminBody.safeParse({ ...request, password: ' \t' }).success, false);
});

test('pagination clamps against unfiltered population and retains an empty first page', () => {
  assert.deepEqual(adminPagination(undefined, undefined, 0), { page: 1, limit: 10, offset: 0 });
  assert.deepEqual(adminPagination(-1, 0, 3), { page: 1, limit: 1, offset: 0 });
  assert.deepEqual(adminPagination(999, 100, 101), { page: 3, limit: 50, offset: 100 });
  assert.deepEqual(adminPagination(3, 10, 21), { page: 3, limit: 10, offset: 20 });
});

test('owner search requires a target only when a nonempty query is supplied', () => {
  assert.doesNotThrow(() => validateOwnerSearch(undefined, undefined));
  assert.doesNotThrow(() => validateOwnerSearch(undefined, 'NAME'));
  assert.doesNotThrow(() => validateOwnerSearch(' 사장 ', 'NAME'));
  assert.throws(() => validateOwnerSearch('사장', undefined), isBadRequest);
  assert.throws(() => validateOwnerSearch('', 'EMAIL'), isBadRequest);
  assert.throws(() => validateOwnerSearch(' \t\n', 'NAME'), isBadRequest);
});

test('owner administration changes only registration and grant flags, not credentials or user profile', () => {
  const body = adminOwnerBody.parse({
    company_registration_number: '123-45-67890', grant_shop: false, grant_event: true,
    email: 'new@example.com', name: '새 이름', nickname: '새 닉네임', phone_number: '01012345678',
    password: 'replacement-secret', gender: 1,
  });
  assert.deepEqual(ownerAdminChanges(body), {
    company_registration_number: '123-45-67890', grant_shop: 0, grant_event: 1,
  });
  assert.throws(() => ownerAdminChanges({ ...body, grant_shop: null }), TypeError);
});

test('student administration retains the exact ten-digit DTO boundary independently of admission year', () => {
  const body = { major: '컴퓨터공학부', student_number: '2020136065' };
  assert.equal(adminStudentBody.safeParse(body).success, true);
  assert.equal(adminStudentBody.safeParse({ ...body, student_number: '2099136065' }).success, true);
  assert.equal(adminStudentBody.safeParse({ ...body, student_number: '20201360' }).success, false);
  assert.equal(adminStudentBody.safeParse({ ...body, student_number: '20201360651' }).success, false);
  assert.equal(adminStudentBody.safeParse({ ...body, student_number: '202013606A' }).success, false);
  assert.equal(adminStudentBody.safeParse({ ...body, major: '\t' }).success, false);
  assert.equal(adminStudentBody.safeParse({ ...body, nickname: '가'.repeat(11) }).success, false);
});
