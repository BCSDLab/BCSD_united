import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '@api/errors';
import { defaultAcademicMajor, legacyStudentRegistration, studentRegistration, studentView, validateAcademicSelection, validateStudentNumber } from '@api/domains/identity/students';

const major = (id: number, departmentId: number, name: string | null) => ({
  id, department_id: departmentId, name, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
});

const registration = {
  name: '홍길동', nickname: '학생1', email: 'student@koreatech.ac.kr',
  phone_number: '01012345678', gender: 0, department: '컴퓨터공학부',
  student_number: '2026136001', login_id: 'student1', password: 'a'.repeat(64),
};

describe('student academic eligibility', () => {
  it('requires an eight-to-ten digit student number even without a year catalogue', () => {
    for (const value of [null, '', '2026136', '20261360010', '2026A36001']) {
      assert.throws(() => validateAcademicSelection(value, { id: 1 }, null, []), (error) => error instanceof ApiError && error.status === 400);
    }
    for (const value of ['20261360', '202613600', '2026136001']) {
      assert.doesNotThrow(() => validateAcademicSelection(value, { id: 1 }, null, []));
    }
  });

  it('enforces admission year bounds only for legacy registration', () => {
    assert.throws(() => validateStudentNumber('1991136001', 2026));
    assert.throws(() => validateStudentNumber('2027136001', 2026));
    assert.doesNotThrow(() => validateStudentNumber('1992136001', 2026));
    assert.doesNotThrow(() => validateStudentNumber('2026136001', 2026));
    assert.doesNotThrow(() => validateAcademicSelection('2027136001', { id: 1 }, null, []));
  });

  it('rejects a major belonging to another department even without year records', () => {
    assert.throws(() => validateAcademicSelection('2026136001', { id: 1 }, major(10, 2, '전자공학전공'), []), (error) => error instanceof ApiError && error.status === 404);
    assert.throws(() => validateAcademicSelection('2026136001', null, null, []));
  });

  it('restricts known admission years to their actual departments and majors', () => {
    const programs = [{ department_id: 1, major_id: 10 }];
    assert.throws(() => validateAcademicSelection('2026136001', { id: 2 }, null, programs));
    assert.throws(() => validateAcademicSelection('2026136001', { id: 1 }, major(11, 1, '새전공'), programs));
    assert.doesNotThrow(() => validateAcademicSelection('2026136001', { id: 1 }, major(10, 1, null), programs));
    assert.doesNotThrow(() => validateAcademicSelection('2026136001', { id: 1 }, null, programs));
  });

  it('uses the first department major only when no year catalogue exists', () => {
    const majors = [major(8, 1, '두번째'), major(3, 1, '첫번째'), major(1, 2, null)];
    assert.equal(defaultAcademicMajor(1, [], majors)?.id, 3);
    assert.equal(defaultAcademicMajor(1, [{ department_id: 1, major_id: 3 }], majors), null);
    const unnamed = major(9, 1, null);
    assert.equal(defaultAcademicMajor(1, [{ department_id: 1, major_id: 9 }], [...majors, unnamed])?.id, 9);
    assert.equal(defaultAcademicMajor(1, [{ department_id: 2, major_id: 1 }], majors), null);
  });
});

describe('student registration constraints', () => {
  it('accepts optional blank email but enforces source login ID and password hash lengths', () => {
    assert.equal(studentRegistration.safeParse({ ...registration, email: '' }).success, true);
    for (const login_id of ['Student1', '12345', 'stud', 'studentstudent1']) {
      assert.equal(studentRegistration.safeParse({ ...registration, login_id }).success, false);
    }
    assert.equal(studentRegistration.safeParse({ ...registration, password: 'a'.repeat(63) }).success, false);
    assert.equal(studentRegistration.safeParse({ ...registration, password: 'z'.repeat(64) }).success, true);
  });

  it('keeps legacy ten-digit and versioned eight-digit student numbers distinct', () => {
    const legacy = { ...registration, major: registration.department, student_number: '20261360' };
    assert.equal(legacyStudentRegistration.safeParse(legacy).success, false);
    assert.equal(studentRegistration.safeParse({ ...registration, student_number: '20261360' }).success, true);
  });

  it('requires exact versioned phone digits and supported gender', () => {
    assert.equal(studentRegistration.safeParse({ ...registration, phone_number: '010-1234-5678' }).success, false);
    assert.equal(studentRegistration.safeParse({ ...registration, gender: 2 }).success, false);
    assert.equal(studentRegistration.safeParse({ ...registration, name: '홍' }).success, false);
    assert.equal(studentRegistration.safeParse({ ...registration, nickname: '공백 이름' }).success, false);
  });
});

describe('legacy password reset view', () => {
  it('escapes origin markup and encodes reset tokens without making executable HTML', () => {
    const html = studentView('password', 'https://example.test/" onmouseover="alert(1)', '"><script>alert(2)</script>');
    assert.ok(!html.includes('value="https://example.test/" onmouseover='));
    assert.ok(!html.includes('<script>alert(2)</script>'));
    assert.ok(html.includes('crypto.subtle.digest(\'SHA-256\''));
    assert.ok(html.includes('패스워드가 일치하지 않습니다.'));
  });
});
