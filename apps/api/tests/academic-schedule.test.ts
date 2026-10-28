import assert from 'node:assert/strict';
import { test } from 'node:test';
import { courseTimeText, customLectureInfo, earnedCredits, encodeClassInfo, encodeLectureInfo, legacyClassInfo, parseTimes, regularLectureInfo, semesterOrder } from '@api/domains/academic/schedule';
import { courseTimes } from '@api/domains/academic/catalog';

test('regular lectures group only consecutive source slots and preserve day offsets', () => {
  assert.deepEqual(regularLectureInfo('[0, 1, 4, 100, 101]', 'A, B, C'), [
    { day: 0, start_time: 0, end_time: 1, place: 'A' },
    { day: 0, start_time: 4, end_time: 4, place: 'B' },
    { day: 1, start_time: 100, end_time: 101, place: 'C' },
  ]);
  assert.deepEqual(regularLectureInfo('[]', 'A'), []);
  assert.deepEqual(regularLectureInfo(null, null), []);
  assert.deepEqual(regularLectureInfo('[3, 2]', null), [
    { day: 0, start_time: 3, end_time: 3, place: '' },
    { day: 0, start_time: 2, end_time: 2, place: '' },
  ]);
});

test('custom lecture separators retain places even when sessions touch or overlap', () => {
  const encoded = encodeLectureInfo([
    { start_time: 0, end_time: 1, place: 'A' },
    { start_time: 1, end_time: 2, place: 'B' },
    { start_time: 100, end_time: 100 },
  ]);
  assert.equal(encoded.class_time, '[0, 1, -1, 1, 2, -1, 100]');
  assert.equal(encoded.class_place, 'A, B, ');
  assert.deepEqual(customLectureInfo(encoded.class_time, encoded.class_place), [
    { day: 0, start_time: 0, end_time: 1, place: 'A' },
    { day: 0, start_time: 1, end_time: 2, place: 'B' },
    { day: 1, start_time: 100, end_time: 100, place: '' },
  ]);
  assert.deepEqual(customLectureInfo('[1, 2]', null), []);
});

test('legacy class info keeps a null-place list unsegmented and splits named places', () => {
  assert.deepEqual(legacyClassInfo('[0, 1, -1, 100]', null), [{ class_time: [0, 1, -1, 100], class_place: null }]);
  assert.deepEqual(legacyClassInfo('[0, 1, -1, 100]', 'A'), [
    { class_time: [0, 1], class_place: 'A' }, { class_time: [100], class_place: '' },
  ]);
  assert.deepEqual(encodeClassInfo(null), { class_time: null, class_place: null });
  assert.deepEqual(parseTimes(' [ 0, 101, -1 ] '), [0, 101, -1]);
});

test('credits use catalog lecture credit instead of edited display credit and ignore nonmain frames', () => {
  const rows = [{ grades: '9', lecture_grades: '3' }, { grades: '2', lecture_grades: null }];
  assert.equal(earnedCredits(rows, true), 5);
  assert.equal(earnedCredits(rows, false), 0);
  assert.equal(earnedCredits(rows, true, true), 3);
});

test('semesters order descending year then winter, second, summer, first', () => {
  const semesters = [{ year: 2025, term: 'FIRST' }, { year: 2024, term: 'WINTER' }, { year: 2025, term: 'SUMMER' }, { year: 2025, term: 'SECOND' }, { year: 2025, term: 'WINTER' }];
  assert.deepEqual(semesters.sort(semesterOrder).map((row) => `${row.year}:${row.term}`), ['2025:WINTER', '2025:SECOND', '2025:SUMMER', '2025:FIRST', '2024:WINTER']);
});

test('course registration sorts raw slots and retains source first-three-period display restriction', () => {
  assert.deepEqual(courseTimes('[105, 0, 100, 6]'), [0, 6, 100, 105]);
  assert.deepEqual(courseTimes('[0, invalid]'), []);
  assert.deepEqual(courseTimes(null), []);
  assert.equal(courseTimeText(courseTimes('[105, 0, 100, 6]')), '월01A,화01A~03B');
  assert.equal(courseTimeText([6, 500]), '');
});
