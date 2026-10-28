import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { courseTimeText, terms, type Term } from '@api/domains/academic/schedule';
import { integer, joinedTimetable, ownedFrame } from '@api/domains/academic/timetable';

const categories = { ACADEMIC: '학사 / 수업', STUDENT_SUPPORT: '학생지원 / 행정', EMPLOYMENT: '취업 / 현장실습', INTERNATIONAL: '국제 / 교환학생', FACILITY: '시설 / 생활', OTHER: '기타 기관' } as const;
const normalized = (value: string) => value.replace(/\s+/g, '').toLowerCase();
export function courseTimes(raw: string | null): number[] {
  if (!raw) return [];
  const cleaned = raw.replace(/[\[\]\s]/g, '');
  if (!cleaned) return [];
  const tokens = cleaned.split(',');
  while (tokens[tokens.length - 1] === '') tokens.pop();
  if (tokens.some((token) => !/^[+-]?\d+$/.test(token) || !Number.isSafeInteger(Number(token)))) return [];
  return tokens.map(Number).sort((a, b) => a - b);
}
async function contacts(c: Context<ApiEnv>, category?: keyof typeof categories) {
  const db = c.get('db');
  const departments = await db.select().from(schema.department_contact_departments).where(category ? eq(schema.department_contact_departments.category, category) : undefined).orderBy(asc(schema.department_contact_departments.display_order));
  const rows = await db.select().from(schema.department_contacts).orderBy(asc(schema.department_contacts.display_order));
  departments.sort((a, b) => Number(b.name === '학사팀') - Number(a.name === '학사팀') || a.display_order - b.display_order);
  const departmentIds = new Set(departments.map((row) => row.id));
  const updates = [...departments.map((row) => row.updated_at), ...rows.filter((row) => departmentIds.has(row.department_id)).map((row) => row.updated_at)].filter((date): date is string => date !== null).sort();
  const keyword = normalized(c.req.query('keyword') ?? '');
  const response = (key: keyof typeof categories) => ({
    category: key, category_name: categories[key], departments: departments.filter((department) => department.category === key && (!keyword || normalized(categories[key]).includes(keyword) || normalized(department.name).includes(keyword) || rows.some((row) => row.department_id === department.id && normalized(row.task).includes(keyword)))).map((department) => {
      const entries = rows.filter((row) => row.department_id === department.id).map((row) => ({ task: row.task, phone_number: row.phone_number }));
      return { name: department.name, is_single_contact: entries.length === 1, contacts: entries };
    }),
  });
  const updated_at = updates.length ? new Date(Date.parse(`${updates[updates.length - 1].replace(' ', 'T')}Z`) + 9 * 3600_000).toISOString().slice(0, 19) : null;
  if (category) return { updated_at, ...response(category) };
  return { updated_at, categories: (Object.keys(categories) as (keyof typeof categories)[]).map(response).filter((entry) => !keyword || entry.departments.length > 0) };
}
const adminLecture = z.object({
  code: z.string().min(1).max(10).refine((value) => value.trim().length > 0), name: z.string().min(1).max(50).refine((value) => value.trim().length > 0), grades: z.string().min(1).max(2), lecture_class: z.string().min(1).max(3),
  regular_number: z.string().max(4), department: z.string().min(1).max(30), target: z.string().max(200), professor: z.string().max(30).nullable().optional(),
  is_english: z.string().max(2), design_score: z.string().min(1).max(2), is_elearning: z.string().max(2), class_time: z.array(z.number().int().min(0).max(999)).max(50),
});
async function validated<T extends z.ZodType>(c: Context<ApiEnv>, validator: T): Promise<z.infer<T>> {
  const result = validator.safeParse(await c.req.json());
  if (!result.success) throw new ApiError(400, 'INVALID_REQUEST_BODY', result.error.issues[0].message, result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  return result.data;
}
export function lectureImportStatement(semester: string, payload: string) {
  return sql`with incoming as materialized (select value from json_each(${payload})), eligible as materialized (select not exists(select 1 from ${schema.lectures} existing join incoming candidate on existing.code=json_extract(candidate.value,'$.code') and existing.class=json_extract(candidate.value,'$.lecture_class') where existing.semester_date=${semester}) as allowed)
    insert into ${schema.lectures} (semester_date, code, name, grades, class, regular_number, department, target, professor, is_english, design_score, is_elearning, class_time)
    select ${semester}, json_extract(value,'$.code'), json_extract(value,'$.name'), json_extract(value,'$.grades'), json_extract(value,'$.lecture_class'), json_extract(value,'$.regular_number'), json_extract(value,'$.department'), json_extract(value,'$.target'), json_extract(value,'$.professor'), json_extract(value,'$.is_english'), json_extract(value,'$.design_score'), json_extract(value,'$.is_elearning'), json_extract(value,'$.class_time')
    from incoming cross join eligible where eligible.allowed returning id`;
}
export function registerAcademicCatalog(app: Hono<ApiEnv>): void {
  app.get('/dept', async (c) => {
    const deptNum = c.req.query('dept_num');
    if (deptNum === undefined) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
    const rows = await c.get('db').select().from(schema.department).orderBy(asc(schema.department.display_order), asc(schema.department.id));
    const department = rows.find((row) => Array.isArray(row.dept_nums) && row.dept_nums.includes(deptNum));
    return department ? c.json({ dept_num: deptNum, name: department.name }) : c.body(null, 200);
  });
  app.get('/depts', async (c) => {
    const rows = await c.get('db').select().from(schema.department).where(eq(schema.department.is_selectable, true)).orderBy(asc(schema.department.display_order), asc(schema.department.id));
    return c.json(rows.map((row) => ({ name: row.name, curriculum_link: row.curriculum_link, dept_nums: row.dept_nums })));
  });
  app.get('/depts/major', async (c) => {
    const db = c.get('db');
    const year = c.req.query('student_year');
    if (year !== undefined && !/^\d{4}$/.test(year)) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
    const departments = await db.select().from(schema.department).orderBy(asc(schema.department.id));
    const majors = await db.select().from(schema.major).orderBy(asc(schema.major.id));
    if (year !== undefined) {
      const programs = await db.select().from(schema.academic_program_year).where(eq(schema.academic_program_year.student_year, year)).orderBy(asc(schema.academic_program_year.department_id), asc(schema.academic_program_year.id));
      if (programs.length) {
        const result: { department: string; majors: string[] }[] = [];
        for (const departmentId of new Set(programs.map((row) => row.department_id))) {
          const department = departments.find((row) => row.id === departmentId)!;
          const majorNames = programs
            .filter((row) => row.department_id === departmentId)
            .flatMap((row) => {
              const major = majors.find((entry) => entry.id === row.major_id);
              return major?.name == null ? [] : [major.name];
            });
          result.push({ department: department.name, majors: majorNames });
        }
        return c.json(result);
      }
    }
    return c.json(departments.map((department) => ({ department: department.name, majors: majors.filter((major) => major.department_id === department.id && major.name !== null).map((major) => major.name!) })));
  });
  app.get('/department-contacts', async (c) => c.json(await contacts(c)));
  app.get('/department-contacts/:category', async (c) => {
    const category = c.req.param('category');
    if (!Object.hasOwn(categories, category)) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
    return c.json(await contacts(c, category as keyof typeof categories));
  });
  app.get('/course/registration/precourse', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT', 'COUNCIL']).id;
    const db = c.get('db');
    const frame = await ownedFrame(db, integer(c.req.query('timetable_frame_id')), userId);
    const rows = await joinedTimetable(db, [frame.id]);
    return c.json(rows.map(({ timetable, lecture }) => ({ department: lecture?.department ?? '-', lecture_info: { lecture_code: lecture?.code ?? null, lecture_name: lecture?.name ?? timetable.class_title }, class_number: lecture?.class ?? null, grades: lecture?.grades ?? timetable.grades, class_time_raw: courseTimes(timetable.class_time ?? lecture?.class_time ?? null) })));
  });
  app.get('/course/registration/search', async (c) => {
    const name = c.req.query('name');
    const department = c.req.query('department');
    const yearQuery = c.req.query('year');
    const term = c.req.query('semester');
    const year = yearQuery === undefined ? undefined : integer(yearQuery);
    const key = (Object.keys(terms) as Term[]).find((entry) => terms[entry].label === term);
    const semester = year !== undefined && key ? `${year}${terms[key].suffix}` : undefined;
    const lecture = schema.lectures;
    const rows = await c.get('db').select().from(lecture).where(and(name !== undefined ? sql`instr(lower(${lecture.name}), lower(${name})) > 0` : undefined, department !== undefined ? eq(lecture.department, department) : undefined, semester ? eq(lecture.semester_date, semester) : undefined)).orderBy(desc(lecture.semester_date), asc(lecture.code));
    return c.json(rows.map((row) => {
      const times = courseTimes(row.class_time);
      return {
        department: row.department,
        lecture_info: { lecture_code: row.code, lecture_name: row.name },
        class_number: row.class,
        grades: row.grades,
        professor: row.professor,
        regular_number: row.regular_number,
        class_time: courseTimeText(times),
        class_time_raw: times,
      };
    }));
  });
  app.post('/admin/semesters', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const request = await validated(c, z.object({ year: z.number().int().positive(), term: z.enum(['FIRST', 'SECOND', 'SUMMER', 'WINTER']) }));
    const semester = `${request.year}${terms[request.term].suffix}`;
    const rows = await c.get('db').all<{ id: number }>(sql`insert into ${schema.semester} (semester, year, term) select ${semester}, ${request.year}, ${request.term} where not exists(select 1 from ${schema.semester} where semester=${semester} or (year=${request.year} and term=${request.term})) returning id`);
    if (!rows.length) throw new ApiError(409, 'DUPLICATE_SEMESTER', '이미 존재하는 학기입니다.');
    return c.body(null, 200);
  });
  app.post('/admin/lectures', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const request = await validated(c, z.object({ year: z.number().int().positive(), term: z.enum(['FIRST', 'SECOND', 'SUMMER', 'WINTER']), lectures: z.array(adminLecture).min(1) }));
    const [semester] = await db.select().from(schema.semester).where(and(eq(schema.semester.year, request.year), eq(schema.semester.term, request.term))).limit(1);
    if (!semester) throw new ApiError(404, 'NOT_FOUND_SEMESTER', '해당 학기가 존재하지 않습니다.');
    const keys = new Set<string>();
    for (const lecture of request.lectures) {
      const key = JSON.stringify([lecture.code, lecture.lecture_class]);
      if (keys.has(key)) throw new ApiError(409, 'DUPLICATE_LECTURE', '이미 존재하는 강의입니다.');
      keys.add(key);
    }
    const payload = JSON.stringify(request.lectures.map((lecture) => ({ ...lecture, professor: lecture.professor ?? null, class_time: `[${lecture.class_time.join(', ')}]` })));
    const rows = await db.all<{ id: number }>(lectureImportStatement(semester.semester, payload));
    if (!rows.length) throw new ApiError(409, 'DUPLICATE_LECTURE', '이미 존재하는 강의입니다.');
    return c.body(null, 200);
  });
}
