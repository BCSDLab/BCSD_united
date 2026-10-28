import { ApiError } from '@api/errors';

export interface GraduationCatalog {
  year: string;
  lecture_name: string;
  code: string;
  major_id: number | null;
  course_type_id: number;
  general_education_area_id: number | null;
}

export interface GraduationLecture {
  name: string | null;
  grades: string;
  course_type_id: number | null;
  general_education_area_id: number | null;
}

export interface GradeRow {
  year: string;
  semester: string;
  code: string;
  classTitle: string;
  lectureClass: string;
  professor: string;
  courseType: string;
  credit: string;
  grade: string;
  retakeStatus: string;
}

export function gradeCell(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(Math.max(-2147483648, Math.min(2147483647, Math.trunc(value) || 0)));
  return '';
}

export function gradeRow(cells: readonly unknown[]): GradeRow {
  return {
    year: gradeCell(cells[1]), semester: gradeCell(cells[2]), code: gradeCell(cells[4]),
    classTitle: gradeCell(cells[5]), lectureClass: gradeCell(cells[6]), professor: gradeCell(cells[7]),
    courseType: gradeCell(cells[8]), credit: gradeCell(cells[9]), grade: gradeCell(cells[10]),
    retakeStatus: gradeCell(cells[11]),
  };
}

export function importedGradeRows(rows: readonly (readonly unknown[])[]): GradeRow[] {
  const result: GradeRow[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells) continue;
    const row = gradeRow(cells);
    if (row.classTitle === '소 계' || row.grade === 'F' || row.grade === 'U') continue;
    if (row.classTitle === '합 계') break;
    result.push(row);
  }
  return result;
}

export function koinSemester(semester: string, year: string): string {
  if (semester === '1' || semester === '2') return year + semester;
  return `${year}-${semester === '동계' ? '겨울' : '여름'}`;
}

export function matchingLecture<T extends { class: string }>(lectures: readonly T[], lectureClass: string): T | null {
  return lectures.find((lecture) => lecture.class === lectureClass) ?? lectures[0] ?? null;
}

export function importedCourseType(
  hasLecture: boolean,
  row: GradeRow,
  studentYear: string | null,
  catalogByName: ReadonlyMap<string, GraduationCatalog>,
  catalogByCode: ReadonlyMap<string, GraduationCatalog>,
  defaultTypeId: number,
): { course_type_id: number; general_education_area_id: number | null } {
  const catalog = hasLecture && row.courseType !== '자선'
    ? catalogByName.get(`${row.classTitle}_${studentYear}`) ?? catalogByCode.get(`${row.code}_${row.year}`)
    : undefined;
  return {
    course_type_id: catalog?.course_type_id ?? defaultTypeId,
    general_education_area_id: catalog?.general_education_area_id ?? null,
  };
}

export function bestCatalog(
  catalogs: readonly GraduationCatalog[], name: string, studentYear: string, majorId: number | null,
  attendedYears: ReadonlySet<string>,
): GraduationCatalog | undefined {
  const candidates = catalogs.filter((catalog) => catalog.lecture_name === name);
  return candidates.find((catalog) => catalog.year === studentYear && catalog.major_id === majorId)
    ?? candidates.find((catalog) => attendedYears.has(catalog.year))
    ?? candidates.reduce<GraduationCatalog | undefined>((latest, catalog) => (
      !latest || catalog.year > latest.year ? catalog : latest
    ), undefined);
}

export function integerCredit(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
  const credit = Number(value);
  if (!Number.isInteger(credit) || credit < -2147483648 || credit > 2147483647) {
    throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
  }
  return credit;
}

export function calculateCredits(
  lectures: readonly GraduationLecture[], catalogs: readonly GraduationCatalog[], studentYear: string,
  majorId: number | null, attendedYears: ReadonlySet<string>, defaultTypeId: number,
): Map<number, number> {
  const firstCatalogType = new Map<string, number>();
  for (const lecture of lectures) {
    if (lecture.name === null || firstCatalogType.has(lecture.name)) continue;
    const catalog = bestCatalog(catalogs, lecture.name, studentYear, majorId, attendedYears);
    firstCatalogType.set(lecture.name, lecture.course_type_id ?? catalog?.course_type_id ?? defaultTypeId);
  }
  const credits = new Map<number, number>();
  for (const lecture of lectures) {
    const type = lecture.course_type_id ?? (lecture.name === null ? undefined : firstCatalogType.get(lecture.name)) ?? defaultTypeId;
    credits.set(type, (credits.get(type) ?? 0) + integerCredit(lecture.grades));
  }
  return credits;
}

export function educationRequirements(year: string): ReadonlyArray<readonly [string, number]> {
  if (!['2019', '2020', '2021', '2022', '2023', '2024'].includes(year)) {
    throw new ApiError(400, '', `year 양식이 잘못됐습니다. year : ${year} null`);
  }
  return [[Number(year) <= 2020 ? '글로벌' : '인성과소양', 2], ['예술과문학', 3],
    ['사회와심리', 3], ['역사와철학', 3], ['자연과인간', 3]];
}

export function educationCalculation(name: string, required: number, lectures: readonly GraduationLecture[]) {
  return {
    course_type: name,
    required_credit: required,
    completed_credit: lectures.reduce((total, lecture) => total + integerCredit(lecture.grades), 0),
    course_names: lectures.map((lecture) => lecture.name),
  };
}
