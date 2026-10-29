import { and, eq, sql, type SQL } from 'drizzle-orm';
import { read, utils } from 'xlsx';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import {
  importedCourseType,
  importedGradeRows,
  koinSemester,
  matchingLecture,
  type GraduationCatalog,
  type GradeRow,
} from '@api/domains/academic/graduation-algorithms';

const s = schema;

export function workbookGradeRows(bytes: Uint8Array): GradeRow[] {
  const oleSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!oleSignature.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Not an OLE2 workbook');
  }
  const workbook = read(bytes, { type: 'array', cellFormula: true, cellDates: false, sheetStubs: true });
  const firstName = workbook.SheetNames[0];
  if (!firstName || !workbook.Sheets[firstName]) throw new Error('Workbook has no sheets');
  const sheet = workbook.Sheets[firstName];
  const rows: unknown[][] = [];
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const { r, c } = utils.decode_cell(address);
    const cell = sheet[address];
    const row = rows[r] ?? (rows[r] = []);
    row[c] = cell && !cell.f && (cell.t === 's' || cell.t === 'n') ? cell.v : '';
  }
  return importedGradeRows(rows);
}

export async function importGradeWorkbook(db: Database, userId: number, file: File): Promise<boolean> {
  const dot = file.name.lastIndexOf('.');
  if (dot === -1) throw new ApiError(404, '', '파일의 형식이 맞는지 확인 해주세요. null');
  const extension = file.name.slice(dot + 1);
  if (extension !== 'xls' && extension !== 'xlsx') {
    throw new ApiError(404, '', '엑셀 파일인지 확인 해주세요. null');
  }
  const [student] = await db.select().from(s.students).where(eq(s.students.user_id, userId)).limit(1);
  if (!student) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
  const year = student.student_number?.slice(0, 4) ?? null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new ApiError(500, 'INTERNAL_SERVER_ERROR', '서버 내부 오류가 발생했습니다.');
  }
  let rows: GradeRow[];
  try {
    rows = workbookGradeRows(bytes);
  } catch {
    await db
      .update(s.detect_graduation_calculation)
      .set({ is_changed: true })
      .where(eq(s.detect_graduation_calculation.user_id, userId));
    return false;
  }
  const semesters = [...new Set(rows.map((row) => koinSemester(row.semester, row.year)))];
  const codes = [...new Set(rows.map((row) => row.code))];
  const names = [...new Set(rows.map((row) => row.classTitle))];
  const years = [...new Set(rows.map((row) => row.year))];
  const lectures = codes.length
    ? await db
        .select()
        .from(s.lectures)
        .where(
          and(
            sql`${s.lectures.semester_date} IN (SELECT value FROM json_each(${JSON.stringify(semesters)}))`,
            sql`${s.lectures.code} IN (SELECT value FROM json_each(${JSON.stringify(codes)}))`,
          ),
        )
    : [];
  const nameCatalogs =
    names.length && year !== null
      ? await db
          .select()
          .from(s.catalog)
          .where(
            and(
              sql`${s.catalog.lecture_name} IN (SELECT value FROM json_each(${JSON.stringify(names)}))`,
              eq(s.catalog.year, year),
            ),
          )
      : [];
  const codeCatalogs = codes.length
    ? await db
        .select()
        .from(s.catalog)
        .where(
          and(
            sql`${s.catalog.code} IN (SELECT value FROM json_each(${JSON.stringify(codes)}))`,
            sql`${s.catalog.year} IN (SELECT value FROM json_each(${JSON.stringify(years)}))`,
          ),
        )
    : [];
  const byName = new Map<string, GraduationCatalog>();
  const byCode = new Map<string, GraduationCatalog>();
  for (const catalog of nameCatalogs) byName.set(`${catalog.lecture_name}_${catalog.year}`, catalog);
  for (const catalog of codeCatalogs) byCode.set(`${catalog.code}_${catalog.year}`, catalog);
  const semesterRows = semesters.length
    ? await db
        .select()
        .from(s.semester)
        .where(sql`${s.semester.semester} IN (SELECT value FROM json_each(${JSON.stringify(semesters)}))`)
    : [];
  const types = await db.select().from(s.course_type).where(eq(s.course_type.is_deleted, 0));
  const defaultType = types.find((type) => type.name === '이수구분선택');
  const statements: SQL[] = [];
  let currentSemester = 'default';
  for (const row of rows) {
    const semesterName = koinSemester(row.semester, row.year);
    const semester = semesterRows.find((item) => item.semester === semesterName);
    if (!semester) throw new ApiError(404, '', `존재하지 않는 학기입니다. semester: ${semesterName}`);
    const lecture = matchingLecture(
      lectures.filter((item) => item.semester_date === semesterName && item.code === row.code),
      row.lectureClass,
    );
    const catalog =
      lecture && row.courseType !== '자선'
        ? (byName.get(`${row.classTitle}_${year}`) ?? byCode.get(`${row.code}_${row.year}`))
        : undefined;
    if (!catalog && !defaultType)
      throw new ApiError(404, '', '존재하지 않는 이수 구분입니다. course_type_name: 이수구분선택');
    const classification = importedCourseType(
      lecture !== null,
      row,
      year,
      byName,
      byCode,
      defaultType?.id ?? catalog!.course_type_id,
    );
    if (currentSemester !== semesterName) {
      statements.push(sql`UPDATE ${s.timetable_frame} SET is_main = 0, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ${userId} AND semester_id = ${semester.id} AND is_main = 1 AND is_deleted = 0`);
      statements.push(sql`INSERT INTO ${s.timetable_frame} (user_id, semester_id, name, is_main, is_deleted)
        VALUES (${userId}, ${semester.id}, ${'졸업학점 계산 테이블'}, 1, 0)`);
      currentSemester = semesterName;
    }
    statements.push(sql`INSERT INTO ${s.timetable_lecture}
      (class_title, class_time, professor, grades, is_deleted, lectures_id, frame_id, course_type_id, general_education_area_id)
      VALUES (${row.classTitle}, ${lecture?.class_time ?? '[]'}, ${row.professor}, ${row.credit}, 0,
        ${lecture?.id ?? null},
        (SELECT id FROM ${s.timetable_frame} WHERE user_id = ${userId} AND semester_id = ${semester.id}
          AND is_main = 1 AND is_deleted = 0 ORDER BY id DESC LIMIT 1),
        ${classification.course_type_id}, ${classification.general_education_area_id})`);
  }
  statements.push(sql`UPDATE ${s.detect_graduation_calculation} SET is_changed = 1 WHERE user_id = ${userId}`);
  await executeAtomic(db, statements);
  return true;
}
