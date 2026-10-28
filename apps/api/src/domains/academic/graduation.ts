import type { Hono } from 'hono';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { requirePrincipal } from '@api/auth';
import type { ApiEnv } from '@api/runtime';
import { ApiError } from '@api/errors';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import {
  calculateCredits, educationCalculation, educationRequirements,
} from '@api/domains/academic/graduation-algorithms';
import { importGradeWorkbook } from '@api/domains/academic/graduation-excel';

const s = schema;
type BatchStatement = Parameters<Database['batch']>[0][number];

function notFound(message: string, detail: string | null = null): never {
  throw new ApiError(404, '', `${message} ${detail}`);
}

export function graduationChangedStatement(db: Database, userId: number) {
  return db.update(s.detect_graduation_calculation).set({ is_changed: true })
    .where(eq(s.detect_graduation_calculation.user_id, userId));
}

export async function markGraduationChanged(db: Database, userId: number): Promise<void> {
  await graduationChangedStatement(db, userId);
}

async function studentById(db: Database, userId: number) {
  const [student] = await db.select().from(s.students).where(eq(s.students.user_id, userId)).limit(1);
  if (!student) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
  return student;
}

async function requirementsFor(db: Database, majorId: number, year: string) {
  return db.select().from(s.standard_graduation_requirements).where(and(
    eq(s.standard_graduation_requirements.major_id, majorId),
    eq(s.standard_graduation_requirements.year, year),
    eq(s.standard_graduation_requirements.is_deleted, 0),
  ));
}

export async function buildResetStudentCourseCalculation(
  db: Database, userId: number, newMajorId: number | null, studentNumber: string | null,
): Promise<SQL[]> {
  if (newMajorId === null || studentNumber === null) return [];
  const [existing] = await db.select({ id: s.student_course_calculation.id }).from(s.student_course_calculation)
    .where(and(eq(s.student_course_calculation.user_id, userId), eq(s.student_course_calculation.is_deleted, 0))).limit(1);
  if (!existing) return [];
  const requirements = await requirementsFor(db, newMajorId, studentNumber.slice(0, 4));
  if (!requirements.length) return [];
  return [
    sql`DELETE FROM ${s.student_course_calculation} WHERE user_id = ${userId} AND is_deleted = 0`,
    ...requirements.map((requirement) => sql`INSERT INTO ${s.student_course_calculation}
      (user_id, standard_graduation_requirements_id, completed_grades, is_deleted)
      VALUES (${userId}, ${requirement.id}, 0, 0)`),
    sql`UPDATE ${s.detect_graduation_calculation} SET is_changed = 1 WHERE user_id = ${userId}`,
  ];
}

export async function resetStudentCourseCalculation(
  db: Database, userId: number, newMajorId: number | null, studentNumber: string | null,
): Promise<void> {
  const statements = await buildResetStudentCourseCalculation(db, userId, newMajorId, studentNumber);
  if (statements.length) await executeAtomic(db, statements);
}

async function courseTypeByName(db: Database, name: string) {
  const [type] = await db.select().from(s.course_type)
    .where(and(eq(s.course_type.name, name), eq(s.course_type.is_deleted, 0))).limit(1);
  if (!type) notFound('존재하지 않는 이수 구분입니다.', `course_type_name: ${name}`);
  return type;
}

async function mainLectures(db: Database, userId: number) {
  const rows = await db.select({ timetable: s.timetable_lecture, lecture: s.lectures })
    .from(s.timetable_frame)
    .innerJoin(s.timetable_lecture, eq(s.timetable_lecture.frame_id, s.timetable_frame.id))
    .leftJoin(s.lectures, eq(s.lectures.id, s.timetable_lecture.lectures_id))
    .where(and(eq(s.timetable_frame.user_id, userId), eq(s.timetable_frame.is_main, true),
      eq(s.timetable_frame.is_deleted, false), eq(s.timetable_lecture.is_deleted, false)));
  return rows.map(({ timetable, lecture }) => ({
    name: lecture ? lecture.name : timetable.class_title,
    grades: lecture ? lecture.grades : timetable.grades,
    course_type_id: timetable.course_type_id,
    general_education_area_id: timetable.general_education_area_id,
  }));
}

async function agree(db: Database, userId: number) {
  const student = await studentById(db, userId);
  const [detect] = await db.select().from(s.detect_graduation_calculation)
    .where(eq(s.detect_graduation_calculation.user_id, userId)).limit(1);
  const [existing] = await db.select().from(s.student_course_calculation)
    .where(and(eq(s.student_course_calculation.user_id, userId), eq(s.student_course_calculation.is_deleted, 0))).limit(1);
  if (detect || existing) throw new ApiError(409, '', '이미 졸업요건 계산이 초기화 되었습니다. null');
  if (student.major_id === null) notFound('존재하지 않는 학과입니다.', '전공을 추가하세요.');
  if (student.student_number === null) notFound('존재하지 않는 학과입니다.', '학번을 추가하세요.');
  const requirements = await requirementsFor(db, student.major_id, student.student_number.slice(0, 4));
  const statements: [BatchStatement, ...BatchStatement[]] = [
    db.insert(s.detect_graduation_calculation).values({ user_id: userId, is_changed: false }),
    ...requirements.map((requirement) => db.insert(s.student_course_calculation).values({
      user_id: userId, standard_graduation_requirements_id: requirement.id, completed_grades: 0, is_deleted: 0,
    })),
  ];
  await db.batch(statements);
}

async function calculation(db: Database, userId: number) {
  const [detect] = await db.select().from(s.detect_graduation_calculation)
    .where(eq(s.detect_graduation_calculation.user_id, userId)).limit(1);
  if (!detect) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
  if (!detect.is_changed) {
    const rows = await db.select({
      course_type: s.course_type.name,
      required_grades: s.standard_graduation_requirements.required_grades,
      grades: s.student_course_calculation.completed_grades,
    }).from(s.student_course_calculation)
      .innerJoin(s.standard_graduation_requirements,
        eq(s.standard_graduation_requirements.id, s.student_course_calculation.standard_graduation_requirements_id))
      .innerJoin(s.course_type, eq(s.course_type.id, s.standard_graduation_requirements.course_type_id))
      .where(and(eq(s.student_course_calculation.user_id, userId), eq(s.student_course_calculation.is_deleted, 0),
        eq(s.standard_graduation_requirements.is_deleted, 0), eq(s.course_type.is_deleted, 0)));
    return { course_types: rows.sort((a, b) => a.course_type < b.course_type ? -1 : a.course_type > b.course_type ? 1 : 0) };
  }
  const student = await studentById(db, userId);
  if (student.department_id === null) notFound('학과를 추가하세요.');
  if (student.student_number === null) notFound('학번을 추가하세요.');
  const year = student.student_number.slice(0, 4);
  const lectures = await mainLectures(db, userId);
  const names = [...new Set(lectures.flatMap((lecture) => lecture.name === null ? [] : [lecture.name]))];
  const catalogs = names.length ? await db.select().from(s.catalog)
    .where(sql`${s.catalog.lecture_name} IN (SELECT value FROM json_each(${JSON.stringify(names)}))`) : [];
  const years = student.major_id === null ? [] : await db.selectDistinct({ year: s.semester.year })
    .from(s.timetable_lecture).innerJoin(s.timetable_frame, eq(s.timetable_frame.id, s.timetable_lecture.frame_id))
    .innerJoin(s.semester, eq(s.semester.id, s.timetable_frame.semester_id))
    .where(eq(s.timetable_frame.user_id, student.major_id));
  const needsDefault = lectures.some((lecture) => lecture.name === null
    || !catalogs.some((catalog) => catalog.lecture_name === lecture.name));
  const defaultTypeId = needsDefault ? (await courseTypeByName(db, '이수구분선택')).id : 0;
  const credits = calculateCredits(lectures, catalogs, year, student.major_id,
    new Set(years.map((row) => String(row.year))), defaultTypeId);
  const requirements = student.major_id === null ? [] : await requirementsFor(db, student.major_id, year);
  const types = await db.select().from(s.course_type).where(eq(s.course_type.is_deleted, 0));
  const existing = await db.select().from(s.student_course_calculation)
    .where(and(eq(s.student_course_calculation.user_id, userId), eq(s.student_course_calculation.is_deleted, 0)));
  const grouped = new Map<number, { course_type: string; required_grades: number; grades: number }>();
  const statements: BatchStatement[] = [];
  for (const requirement of requirements) {
    if (requirement.course_type_id === null) continue;
    const type = types.find((row) => row.id === requirement.course_type_id);
    if (!type) notFound('존재하지 않는 이수 구분입니다.');
    const completed = credits.get(type.id) ?? 0;
    const firstRequirement = requirements.find((row) => row.course_type_id === type.id)!;
    if (!grouped.has(type.id)) {
      const record = existing.find((row) => row.standard_graduation_requirements_id === firstRequirement.id);
      if (record) {
        statements.push(db.update(s.student_course_calculation).set({ completed_grades: completed, updated_at: sql`CURRENT_TIMESTAMP` })
          .where(eq(s.student_course_calculation.id, record.id)));
      } else {
        statements.push(db.insert(s.student_course_calculation).values({ user_id: userId,
          standard_graduation_requirements_id: firstRequirement.id, completed_grades: completed, is_deleted: 0 }));
      }
    }
    grouped.set(type.id, { course_type: type.name, required_grades: requirement.required_grades, grades: completed });
  }
  statements.push(db.update(s.detect_graduation_calculation).set({ is_changed: false })
    .where(eq(s.detect_graduation_calculation.id, detect.id)));
  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
  return { course_types: [...grouped.values()].sort((a, b) => a.course_type < b.course_type ? -1 : a.course_type > b.course_type ? 1 : 0) };
}

export function registerGraduation(app: Hono<ApiEnv>): void {
  app.post('/graduation/agree', async (c) => {
    await agree(c.get('db'), requirePrincipal(c, ['STUDENT']).id);
    return c.body(null, 200);
  });
  app.post('/graduation/excel/upload', async (c) => {
    const principal = requirePrincipal(c, ['STUDENT']);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) notFound('파일이 있는지 확인 해주세요.');
    const result = await importGradeWorkbook(c.get('db'), principal.id, file);
    if (!result) return c.body(null, 400);
    return c.text('파일이 성공적으로 업로드되었습니다.');
  });
  app.get('/general-education-area', async (c) => c.json(await c.get('db').select().from(s.general_education_area)));
  app.get('/graduation/course/calculation', async (c) =>
    c.json(await calculation(c.get('db'), requirePrincipal(c, ['STUDENT']).id)));
  app.get('/graduation/course-type', async (c) => {
    requirePrincipal(c, ['STUDENT']);
    const db = c.get('db');
    const yearParam = c.req.query('year');
    const term = c.req.query('term');
    const name = c.req.query('name');
    if (!yearParam || !/^[+-]?\d+$/.test(yearParam) || Number(yearParam) < -2147483648
      || Number(yearParam) > 2147483647 || term === undefined || name === undefined) {
      throw new ApiError(400, 'INVALID_REQUEST_BODY', '잘못된 입력값이 포함되어 있습니다.');
    }
    const type = await courseTypeByName(db, name);
    let catalogs = await db.select().from(s.catalog).where(eq(s.catalog.course_type_id, type.id));
    const areaName = c.req.query('general_education_area');
    if (areaName === '교양선택') catalogs = catalogs.filter((row) => row.general_education_area_id === null);
    else if (areaName !== undefined) {
      const [area] = await db.select().from(s.general_education_area).where(eq(s.general_education_area.name, areaName)).limit(1);
      if (!area) notFound('존재하지 않는 교양 이수구분입니다.', `name${areaName}`);
      catalogs = catalogs.filter((row) => row.general_education_area_id === area.id);
    }
    const terms: Record<string, string> = { '1학기': 'FIRST', '2학기': 'SECOND', '여름학기': 'SUMMER', '겨울학기': 'WINTER' };
    const parsedTerm = Object.hasOwn(terms, term) ? terms[term] : undefined;
    if (!parsedTerm) throw new ApiError(400, 'INVALID_SEMESTER_FORMAT', '올바르지 않은 학기 형식입니다.');
    const [semester] = await db.select().from(s.semester).where(and(eq(s.semester.year, Number(yearParam)), eq(s.semester.term, parsedTerm))).limit(1);
    if (!semester) notFound('존재하지 않는 학기입니다.', `year : ${Number(yearParam)}term : ${term}`);
    const codes = [...new Set(catalogs.map((row) => row.code))];
    const rows = codes.length ? await db.select({ id: s.lectures.id, code: s.lectures.code, name: s.lectures.name,
      grades: s.lectures.grades, department: s.lectures.department }).from(s.lectures)
      .where(and(sql`${s.lectures.code} IN (SELECT value FROM json_each(${JSON.stringify(codes)}))`,
        eq(s.lectures.semester_date, semester.semester))) : [];
    const unique = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!unique.has(row.name)) unique.set(row.name, row);
    return c.json({ semester: semester.semester, lectures: [...unique.values()] });
  });
  app.get('/graduation/lecture/general-education', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT', 'COUNCIL']).id;
    const db = c.get('db');
    const student = await studentById(db, userId);
    if (student.student_number === null) notFound('학번을 추가하세요.');
    const lectures = await mainLectures(db, userId);
    const type = await courseTypeByName(db, '교양선택');
    const result = [educationCalculation('교양선택', 3, lectures.filter((lecture) =>
      lecture.general_education_area_id === null && lecture.course_type_id === type.id))];
    const areas = await db.select().from(s.general_education_area);
    for (const [name, required] of educationRequirements(student.student_number.slice(0, 4))) {
      const area = areas.find((row) => row.name === name);
      if (!area) notFound('존재하지 않는 교양 이수구분입니다.', `name${name}`);
      result.push(educationCalculation(name, required, lectures.filter((lecture) => lecture.general_education_area_id === area.id)));
    }
    return c.json({ general_education_area: result });
  });
}
