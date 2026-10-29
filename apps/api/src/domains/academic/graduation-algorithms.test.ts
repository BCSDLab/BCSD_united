import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utils, write } from 'xlsx';
import { ApiError } from '@api/errors';
import {
  bestCatalog,
  calculateCredits,
  educationCalculation,
  educationRequirements,
  gradeCell,
  gradeRow,
  importedCourseType,
  importedGradeRows,
  integerCredit,
  koinSemester,
  matchingLecture,
  type GraduationCatalog,
  type GraduationLecture,
} from '@api/domains/academic/graduation-algorithms';
import { workbookGradeRows } from '@api/domains/academic/graduation-excel';

const catalog = (overrides: Partial<GraduationCatalog> = {}): GraduationCatalog => ({
  year: '2020',
  lecture_name: '운영체제',
  code: 'CSE001',
  major_id: 1,
  course_type_id: 10,
  general_education_area_id: 2,
  ...overrides,
});
const lecture = (overrides: Partial<GraduationLecture> = {}): GraduationLecture => ({
  name: '운영체제',
  grades: '3',
  course_type_id: null,
  general_education_area_id: null,
  ...overrides,
});
const cells = (title = '운영체제', grade = 'A+'): unknown[] => [
  1,
  2020,
  1,
  '',
  'CSE001',
  title,
  '01',
  '교수',
  '전필',
  3,
  grade,
  '재수강',
];

test('grade cells match POI numeric truncation and ignore booleans and absent cells', () => {
  assert.equal(gradeCell(3.9), '3');
  assert.equal(gradeCell(-3.9), '-3');
  assert.equal(gradeCell(Number.NaN), '0');
  assert.equal(gradeCell(Number.POSITIVE_INFINITY), '2147483647');
  assert.equal(gradeCell('003'), '003');
  assert.equal(gradeCell(true), '');
  assert.equal(gradeCell(undefined), '');
});

test('grade columns preserve course, class, credit, and retake fields', () => {
  assert.deepEqual(gradeRow(cells()), {
    year: '2020',
    semester: '1',
    code: 'CSE001',
    classTitle: '운영체제',
    lectureClass: '01',
    professor: '교수',
    courseType: '전필',
    credit: '3',
    grade: 'A+',
    retakeStatus: '재수강',
  });
});

test('import skips header, subtotal, F and U, stops at total, and retains retakes', () => {
  const rows = importedGradeRows([
    cells('header'),
    cells('소 계'),
    cells('fail', 'F'),
    cells('unsatisfactory', 'U'),
    cells(),
    cells(),
    cells('합 계'),
    cells('after total'),
  ]);
  assert.deepEqual(
    rows.map((row) => row.classTitle),
    ['운영체제', '운영체제'],
  );
  assert.equal(rows[0]?.retakeStatus, '재수강');
});

test('semester conversion preserves seasonal and unexpected-term source fallback', () => {
  assert.equal(koinSemester('1', '2020'), '20201');
  assert.equal(koinSemester('2', '2020'), '20202');
  assert.equal(koinSemester('동계', '2020'), '2020-겨울');
  assert.equal(koinSemester('하계', '2020'), '2020-여름');
  assert.equal(koinSemester('', '2020'), '2020-여름');
});

test('lecture matching chooses exact class, otherwise first section', () => {
  const sections = [
    { id: 1, class: '01' },
    { id: 2, class: '02' },
  ];
  assert.equal(matchingLecture(sections, '02')?.id, 2);
  assert.equal(matchingLecture(sections, '99')?.id, 1);
  assert.equal(matchingLecture([], '01'), null);
});

test('import classification prioritizes admission-year name over attendance-year code', () => {
  const byName = new Map([['운영체제_2020', catalog()]]);
  const byCode = new Map([['CSE001_2020', catalog({ course_type_id: 20 })]]);
  assert.deepEqual(importedCourseType(true, gradeRow(cells()), '2020', byName, byCode, 99), {
    course_type_id: 10,
    general_education_area_id: 2,
  });
  assert.equal(importedCourseType(true, gradeRow(cells()), '2019', byName, byCode, 99).course_type_id, 20);
});

test('free selection and unmatched regular lectures always use default classification', () => {
  const row = gradeRow(cells());
  const byName = new Map([['운영체제_2020', catalog()]]);
  for (const result of [
    importedCourseType(false, row, '2020', byName, new Map(), 99),
    importedCourseType(true, { ...row, courseType: '자선' }, '2020', byName, new Map(), 99),
    importedCourseType(true, row, '2019', byName, new Map(), 99),
  ])
    assert.deepEqual(result, { course_type_id: 99, general_education_area_id: null });
});

test('calculation catalog selection prioritizes major and admission year, attended year, then latest', () => {
  const entries = [catalog({ year: '2024', major_id: 2 }), catalog({ year: '2022', major_id: 2 }), catalog()];
  assert.equal(bestCatalog(entries, '운영체제', '2020', 1, new Set(['2022']))?.year, '2020');
  assert.equal(bestCatalog(entries, '운영체제', '2019', 1, new Set(['2022']))?.year, '2022');
  assert.equal(bestCatalog(entries, '운영체제', '2019', 1, new Set())?.year, '2024');
  assert.equal(bestCatalog(entries, '알수없는강의', '2020', 1, new Set()), undefined);
});

test('calculation counts every main-frame entry and credits from lectures rather than catalog', () => {
  const credits = calculateCredits(
    [lecture(), lecture({ grades: '2' }), lecture({ name: '미등록', grades: '1' })],
    [catalog()],
    '2020',
    1,
    new Set(),
    99,
  );
  assert.deepEqual(
    [...credits],
    [
      [10, 5],
      [99, 1],
    ],
  );
});

test('first matching duplicate-name catalog carries first override unless current entry overrides', () => {
  const credits = calculateCredits(
    [lecture({ course_type_id: 20 }), lecture(), lecture({ course_type_id: 30 })],
    [catalog()],
    '2020',
    1,
    new Set(),
    99,
  );
  assert.deepEqual(
    [...credits],
    [
      [20, 6],
      [30, 3],
    ],
  );
});

test('credit parser rejects fractional, whitespace and overflowing Java integers', () => {
  assert.equal(integerCredit('+3'), 3);
  assert.equal(integerCredit('03'), 3);
  for (const value of ['3.0', ' 3', '', '2147483648']) {
    assert.throws(
      () => integerCredit(value),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
});

test('general education curriculum switches 2021 area and rejects unsupported years', () => {
  assert.deepEqual(educationRequirements('2019')[0], ['글로벌', 2]);
  assert.deepEqual(educationRequirements('2020')[0], ['글로벌', 2]);
  assert.deepEqual(educationRequirements('2021')[0], ['인성과소양', 2]);
  assert.equal(
    educationRequirements('2024').reduce((sum, [, required]) => sum + required, 0),
    14,
  );
  for (const year of ['2018', '2025', '2026']) {
    assert.throws(
      () => educationRequirements(year),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
});

test('general education response preserves uncapped completed credits and duplicate names', () => {
  assert.deepEqual(educationCalculation('교양선택', 3, [lecture(), lecture()]), {
    course_type: '교양선택',
    required_credit: 3,
    completed_credit: 6,
    course_names: ['운영체제', '운영체제'],
  });
});

test('native BIFF import reads first worksheet only using actual xls binary bytes', () => {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([cells('header'), cells(), cells('합 계')]), '성적');
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([cells('header'), cells('다른 시트')]), '기타');
  const bytes = new Uint8Array(write(workbook, { bookType: 'biff8', type: 'array' }));
  assert.deepEqual(workbookGradeRows(bytes), [gradeRow(cells())]);
});

test('native workbook decoder refuses CSV and OOXML accepted by permissive generic readers', () => {
  assert.throws(() => workbookGradeRows(new TextEncoder().encode('year,semester,name\n2020,1,test')));
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([cells('header'), cells()]), '성적');
  assert.throws(() => workbookGradeRows(new Uint8Array(write(workbook, { bookType: 'xlsx', type: 'array' }))));
});
