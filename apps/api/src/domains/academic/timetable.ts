import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import type { Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { graduationChangedStatement } from '@api/domains/academic/graduation';
import {
  customLectureInfo,
  earnedCredits,
  encodeClassInfo,
  encodeLectureInfo,
  legacyClassInfo,
  parseTimes,
  regularLectureInfo,
  semesterOrder,
  terms,
  type Term,
} from '@api/domains/academic/schedule';

const frames = schema.timetable_frame;
const timetable = schema.timetable_lecture;
const lectures = schema.lectures;
const semesters = schema.semester;
type Frame = typeof frames.$inferSelect;
type Lecture = typeof lectures.$inferSelect;
type Version = 1 | 2 | 3;
type FrameResponse = { id: number; is_main: boolean } & ({ name: string } | { timetable_name: string });
export interface JoinedTimetable {
  timetable: typeof timetable.$inferSelect;
  lecture: Lecture | null;
  course: typeof schema.course_type.$inferSelect | null;
  area: typeof schema.general_education_area.$inferSelect | null;
}
const student = (c: Context<ApiEnv>) => requirePrincipal(c, ['STUDENT', 'COUNCIL']).id;
const invalid = (message: string): never => {
  throw new ApiError(400, '', `${message} null`);
};
export function integer(value: unknown): number {
  const result = Number(value);
  if (value == null || value === '' || !Number.isSafeInteger(result)) return invalid('올바른 정수를 입력해주세요.');
  return result;
}
export function termKey(value: string | undefined): Term {
  const key = (Object.keys(terms) as Term[]).find((term) => terms[term].label === value);
  if (!key) throw new ApiError(400, 'INVALID_SEMESTER_FORMAT', '올바르지 않은 학기 형식입니다.');
  return key;
}
export async function findSemester(db: Database, value: { semester?: string; year?: number; term?: Term }) {
  const [row] = await db
    .select()
    .from(semesters)
    .where(
      value.semester !== undefined
        ? eq(semesters.semester, value.semester)
        : and(eq(semesters.year, value.year!), eq(semesters.term, value.term!)),
    )
    .limit(1);
  if (!row)
    throw new ApiError(
      404,
      '',
      `존재하지 않는 학기입니다. ${value.semester !== undefined ? `semester: ${value.semester}` : `year: ${value.year}, term: ${terms[value.term!].label}`}`,
    );
  return row;
}
export async function ownedFrame(db: Database, id: number, userId: number, withDeleted = false) {
  const [frame] = await db
    .select()
    .from(frames)
    .where(and(eq(frames.id, id), withDeleted ? undefined : eq(frames.is_deleted, false)))
    .limit(1);
  if (!frame)
    throw new ApiError(
      404,
      '',
      `${withDeleted ? '존재하지 않는 시간표 프레임입니다.' : '존재하지 않는 시간표입니다.'} id: ${id}`,
    );
  if (frame.user_id !== userId) throw new ApiError(403, '', `권한이 없습니다. userId: ${userId}`);
  return frame;
}
async function ownedLecture(db: Database, id: number, userId: number, withDeleted = false) {
  const [row] = await db
    .select()
    .from(timetable)
    .where(and(eq(timetable.id, id), withDeleted ? undefined : eq(timetable.is_deleted, false)))
    .limit(1);
  if (!row || row.frame_id === null) throw new ApiError(404, '', `존재하지 않는 수업입니다. id: ${id}`);
  await ownedFrame(db, row.frame_id, userId, withDeleted);
  return row;
}
async function findLecture(db: Database, id: number) {
  const [row] = await db.select().from(lectures).where(eq(lectures.id, id)).limit(1);
  if (!row) throw new ApiError(404, '', `존재하지 않는 강의입니다. lecture_id: ${id}`);
  return row;
}
export async function joinedTimetable(db: Database, frameIds: number[]): Promise<JoinedTimetable[]> {
  if (!frameIds.length) return [];
  return db
    .select({ timetable, lecture: lectures, course: schema.course_type, area: schema.general_education_area })
    .from(timetable)
    .leftJoin(lectures, eq(lectures.id, timetable.lectures_id))
    .leftJoin(schema.course_type, eq(schema.course_type.id, timetable.course_type_id))
    .leftJoin(schema.general_education_area, eq(schema.general_education_area.id, timetable.general_education_area_id))
    .where(
      and(
        inArray(timetable.frame_id, sql`select cast(value as integer) from json_each(${JSON.stringify(frameIds)})`),
        eq(timetable.is_deleted, false),
      ),
    )
    .orderBy(asc(timetable.id));
}
type Joined = JoinedTimetable;
function lectureResponse({ timetable: row, lecture, course, area }: Joined, version: Version) {
  const regular = lecture !== null;
  const response = {
    id: row.id,
    regular_number: lecture?.regular_number ?? null,
    code: lecture?.code ?? null,
    design_score: lecture?.design_score ?? null,
    memo: row.memo,
    grades: regular
      ? version === 2 && row.grades !== '0'
        ? row.grades
        : lecture.grades
      : version === 1
        ? null
        : row.grades,
    class_title: regular ? (version === 2 ? (row.class_title ?? lecture.name) : lecture.name) : row.class_title,
    lecture_class: lecture?.class ?? null,
    target: lecture?.target ?? null,
    professor: version === 1 && regular ? lecture.professor : (row.professor ?? lecture?.professor ?? null),
    department: lecture?.department ?? null,
  };
  if (version === 1)
    return { ...response, class_time: parseTimes(lecture?.class_time ?? row.class_time), class_place: row.class_place };
  const classification = {
    lecture_id: lecture?.id ?? null,
    course_type: !regular && version === 2 ? null : (course?.name ?? '이수구분선택'),
    general_education_area: !regular && version === 2 ? null : (area?.name ?? ''),
  };
  const time = row.class_time ?? lecture?.class_time ?? null;
  if (version === 2) return { ...response, ...classification, class_infos: legacyClassInfo(time, row.class_place) };
  return {
    ...response,
    ...classification,
    lecture_infos: regular ? regularLectureInfo(time, row.class_place) : customLectureInfo(time, row.class_place),
  };
}
async function timetableResponse(db: Database, frame: Frame, userId: number, version: Version) {
  const mainFrames = await db
    .select({ id: frames.id })
    .from(frames)
    .where(and(eq(frames.user_id, userId), eq(frames.is_deleted, false), eq(frames.is_main, true)));
  const ids = [...new Set([...mainFrames.map((entry) => entry.id), frame.id])];
  const rows = await joinedTimetable(db, ids);
  const selected = rows.filter((entry) => entry.timetable.frame_id === frame.id);
  const credits = (entries: Joined[], main: boolean) =>
    earnedCredits(
      entries.map((entry) => ({ grades: entry.timetable.grades, lecture_grades: entry.lecture?.grades })),
      main,
      version === 1,
    );
  const mainIds = new Set(mainFrames.map((entry) => entry.id));
  const response = {
    timetable: selected.map((entry) => lectureResponse(entry, version)),
    grades: credits(selected, frame.is_main),
    total_grades: credits(
      rows.filter((entry) => mainIds.has(entry.timetable.frame_id!)),
      true,
    ),
  };
  if (version === 1) {
    const semester = await db.select().from(semesters).where(eq(semesters.id, frame.semester_id));
    return { semester: semester[0].semester, ...response };
  }
  return { timetable_frame_id: frame.id, ...response };
}
function frameResponse(frame: Frame, version: 2 | 3): FrameResponse {
  return version === 3
    ? { id: frame.id, name: frame.name, is_main: frame.is_main }
    : { id: frame.id, timetable_name: frame.name, is_main: frame.is_main };
}
async function semesterFrames(db: Database, userId: number, semesterId: number, version: 2 | 3) {
  const rows = await db
    .select()
    .from(frames)
    .where(and(eq(frames.user_id, userId), eq(frames.semester_id, semesterId), eq(frames.is_deleted, false)))
    .orderBy(...(version === 3 ? [desc(frames.is_main), asc(frames.id)] : [asc(frames.id)]));
  return rows.map((frame) => frameResponse(frame, version));
}
async function createFrame(db: Database, userId: number, semesterId: number, name?: string | null) {
  const count = sql`(select count(*) from ${frames} where ${frames.user_id} = ${userId} and ${frames.semester_id} = ${semesterId} and ${frames.is_deleted} = 0)`;
  const [frame] = await db
    .insert(frames)
    .values({
      user_id: userId,
      semester_id: semesterId,
      name: name ?? sql`'시간표' || (${count} + 1)`,
      is_main: sql`${count} = 0`,
      is_deleted: false,
    })
    .returning();
  return frame;
}
async function mainFrame(db: Database, userId: number, semesterId: number, create: boolean): Promise<Frame> {
  const [frame] = await db
    .select()
    .from(frames)
    .where(
      and(
        eq(frames.user_id, userId),
        eq(frames.semester_id, semesterId),
        eq(frames.is_deleted, false),
        eq(frames.is_main, true),
      ),
    )
    .limit(1);
  if (frame) return frame;
  if (create) {
    await db.run(
      sql`insert into ${frames} (user_id, semester_id, name, is_main, is_deleted) select ${userId}, ${semesterId}, '시간표1', 1, 0 where not exists (select 1 from ${frames} where user_id=${userId} and semester_id=${semesterId} and is_deleted=0 and is_main=1)`,
    );
    return mainFrame(db, userId, semesterId, false);
  }
  throw new ApiError(404, '', `존재하지 않는 시간표 프레임입니다. userId: ${userId}, semesterId: ${semesterId}`);
}
async function classification(db: Database, lecture: Lecture | null, userId: number) {
  if (!lecture) return { course_type_id: null, general_education_area_id: null };
  const [studentRow] = await db.select().from(schema.students).where(eq(schema.students.user_id, userId)).limit(1);
  let catalog: typeof schema.catalog.$inferSelect | undefined;
  if (studentRow?.student_number) {
    [catalog] = await db
      .select()
      .from(schema.catalog)
      .where(
        and(
          eq(schema.catalog.lecture_name, lecture.name),
          eq(schema.catalog.year, studentRow.student_number.slice(0, 4)),
        ),
      )
      .orderBy(asc(schema.catalog.id))
      .limit(1);
    if (!catalog) {
      const year = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
      [catalog] = await db
        .select()
        .from(schema.catalog)
        .where(
          and(
            eq(schema.catalog.code, lecture.code),
            sql`cast(${schema.catalog.year} as integer) between 2019 and ${year}`,
          ),
        )
        .orderBy(asc(schema.catalog.year), asc(schema.catalog.id))
        .limit(1);
    }
  }
  if (catalog)
    return { course_type_id: catalog.course_type_id, general_education_area_id: catalog.general_education_area_id };
  const [course] = await db
    .select()
    .from(schema.course_type)
    .where(eq(schema.course_type.name, '이수구분선택'))
    .limit(1);
  if (!course) throw new ApiError(404, '', '존재하지 않는 이수 구분입니다. course_type_name: 이수구분선택');
  return { course_type_id: course.id, general_education_area_id: null };
}
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const classInfoInput = z.object({ class_time: z.array(z.number().int()), class_place: optionalText(30) });
const lectureInfoInput = z.object({
  start_time: z.number().int(),
  end_time: z.number().int(),
  place: optionalText(30),
});
const lectureInput = z.object({
  id: z.number().int().optional(),
  lecture_id: z.number().int().nullable().optional(),
  class_title: optionalText(100),
  professor: optionalText(30),
  grades: optionalText(2),
  memo: optionalText(200),
  class_infos: z.array(classInfoInput).nullable().optional(),
  lecture_infos: z.array(lectureInfoInput).optional(),
  course_type: z.string().nullable().optional(),
  general_education_area: z.string().nullable().optional(),
  class_places: z.array(z.object({ class_place: z.string().max(30) })).optional(),
});
type LectureInput = z.infer<typeof lectureInput>;
async function body<T extends z.ZodType>(c: Context<ApiEnv>, validator: T): Promise<z.infer<T>> {
  const parsed = validator.safeParse(await c.req.json());
  if (!parsed.success)
    throw new ApiError(
      400,
      'INVALID_REQUEST_BODY',
      parsed.error.issues[0].message,
      parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  return parsed.data;
}
function lectureValues(input: LectureInput, version: 2 | 3) {
  if (version === 3 && !input.lecture_infos?.length) return invalid('강의 시간 정보는 필수로 입력해야 합니다.');
  return {
    class_title: input.class_title ?? null,
    professor: input.professor ?? null,
    grades: input.grades ?? '0',
    memo: input.memo ?? null,
    ...(version === 3
      ? encodeLectureInfo(input.lecture_infos!)
      : encodeClassInfo(
          input.class_infos?.map((info) => ({ class_time: info.class_time, class_place: info.class_place ?? null })),
        )),
  };
}
async function removeFrames(db: Database, userId: number, frameIds: number[], single: Frame | null) {
  if (!frameIds.length) return;
  const ids = sql`select cast(value as integer) from json_each(${JSON.stringify(frameIds)})`;
  const remove = db
    .update(frames)
    .set({ is_deleted: true, ...(single?.is_main ? { is_main: false } : {}) })
    .where(and(inArray(frames.id, ids), eq(frames.user_id, userId)));
  const removeLectures = db.update(timetable).set({ is_deleted: true }).where(inArray(timetable.frame_id, ids));
  if (single?.is_main) {
    const promote = db
      .update(frames)
      .set({ is_main: true })
      .where(
        eq(
          frames.id,
          sql`(select id from ${frames} where user_id=${userId} and semester_id=${single.semester_id} and is_deleted=0 and is_main=0 order by created_at, id limit 1)`,
        ),
      );
    await db.batch([remove, removeLectures, promote, graduationChangedStatement(db, userId)]);
  } else await db.batch([remove, removeLectures, graduationChangedStatement(db, userId)]);
}
export function registerTimetable(app: Hono<ApiEnv>): void {
  app.get('/lectures', async (c) => {
    const semester = await findSemester(c.get('db'), {
      semester: c.req.query('semester_date') ?? invalid('학기 정보를 입력해주세요.'),
    });
    const rows = await c.get('db').select().from(lectures).where(eq(lectures.semester_date, semester.semester));
    return c.json(
      rows.map(({ created_at, updated_at, semester_date, class: lecture_class, class_time, ...row }) => ({
        ...row,
        lecture_class,
        class_time: parseTimes(class_time),
      })),
    );
  });
  app.get('/v3/lectures', async (c) => {
    const semester = await findSemester(c.get('db'), {
      year: integer(c.req.query('year')),
      term: termKey(c.req.query('term')),
    });
    const rows = await c.get('db').select().from(lectures).where(eq(lectures.semester_date, semester.semester));
    return c.json(
      rows.map(({ created_at, updated_at, semester_date, class: lecture_class, class_time, ...row }) => ({
        ...row,
        lecture_class,
        lecture_infos: regularLectureInfo(class_time, null).map(({ place, ...info }) => info),
      })),
    );
  });
  app.get('/semesters', async (c) =>
    c.json(
      (await c.get('db').select().from(semesters)).sort(semesterOrder).map(({ id, semester }) => ({ id, semester })),
    ),
  );
  app.get('/v3/semesters', async (c) =>
    c.json(
      (await c.get('db').select().from(semesters))
        .sort(semesterOrder)
        .map(({ year, term }) => ({ year, term: terms[term as Term].label })),
    ),
  );
  const checkedSemesters = async (c: Context<ApiEnv>) => {
    const userId = student(c);
    const rows = await c
      .get('db')
      .selectDistinct({ id: semesters.id, semester: semesters.semester, year: semesters.year, term: semesters.term })
      .from(semesters)
      .innerJoin(frames, eq(frames.semester_id, semesters.id))
      .where(and(eq(frames.user_id, userId), eq(frames.is_main, true), eq(frames.is_deleted, false)));
    return { userId, rows: rows.sort(semesterOrder) };
  };
  app.get('/semesters/check', async (c) => {
    const { userId, rows } = await checkedSemesters(c);
    return c.json({ user_id: userId, semesters: rows.map((row) => row.semester) });
  });
  app.get('/v3/semesters/check', async (c) => {
    const { rows } = await checkedSemesters(c);
    return c.json({ semesters: rows.map((row) => ({ year: row.year, term: terms[row.term as Term].label })) });
  });

  app.get('/timetables', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const semester = await findSemester(db, {
      semester: c.req.query('semester') ?? invalid('학기 정보를 입력해주세요.'),
    });
    return c.json(await timetableResponse(db, await mainFrame(db, userId, semester.id, true), userId, 1));
  });
  app.post('/timetables', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(
      c,
      z.object({
        semester: z.string().min(1),
        timetable: z.array(
          z.object({
            code: z.string().nullable().optional(),
            lecture_class: optionalText(3),
            class_title: z.string().min(1),
            class_time: z.array(z.number().int()),
            class_place: z.string().nullable().optional(),
            memo: optionalText(200),
          }),
        ),
      }),
    );
    const semester = await findSemester(db, { semester: request.semester });
    const frame = await mainFrame(db, userId, semester.id, false);
    const values = [];
    for (const input of request.timetable) {
      if (input.code == null || input.lecture_class == null)
        throw new ApiError(
          404,
          '',
          `존재하지 않는 학기입니다. semester: ${semester.semester} code: ${input.code ?? 'null'} classLecture: ${input.lecture_class ?? 'null'}`,
        );
      const [lecture] = await db
        .select()
        .from(lectures)
        .where(
          and(
            eq(lectures.semester_date, semester.semester),
            eq(lectures.code, input.code),
            eq(lectures.class, input.lecture_class),
          ),
        )
        .limit(1);
      if (!lecture)
        throw new ApiError(
          404,
          '',
          `존재하지 않는 학기입니다. semester: ${semester.semester} code: ${input.code} classLecture: ${input.lecture_class}`,
        );
      values.push({
        frame_id: frame.id,
        lectures_id: lecture.id,
        class_place: input.class_place,
        memo: input.memo,
        grades: '0',
      });
    }
    if (values.length)
      await db.batch([
        graduationChangedStatement(db, userId),
        ...values.map((value) => db.insert(timetable).values(value)),
      ]);
    return c.json(await timetableResponse(db, frame, userId, 1));
  });
  app.put('/timetables', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(
      c,
      z.object({
        semester: z.string(),
        timetable: z.array(
          lectureInput.extend({
            id: z.number().int(),
            class_time: z.array(z.number().int()),
            class_place: z.string().nullable().optional(),
          }),
        ),
      }),
    );
    const semester = await findSemester(db, { semester: request.semester });
    const frame = await mainFrame(db, userId, semester.id, false);
    for (const input of request.timetable) await ownedLecture(db, input.id, userId);
    if (request.timetable.length)
      await db.batch([
        graduationChangedStatement(db, userId),
        ...request.timetable.map((input) =>
          db
            .update(timetable)
            .set({
              class_title: input.class_title ?? null,
              class_time: `[${input.class_time.join(', ')}]`,
              class_place: input.class_place ?? null,
              professor: input.professor ?? null,
              grades: input.grades ?? '0',
              memo: input.memo ?? null,
            })
            .where(eq(timetable.id, input.id)),
        ),
      ]);
    return c.json(await timetableResponse(db, frame, userId, 1));
  });
  app.delete('/timetable', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const row = await ownedLecture(db, integer(c.req.query('id')), userId);
    await db.batch([
      db.update(timetable).set({ is_deleted: true }).where(eq(timetable.id, row.id)),
      graduationChangedStatement(db, userId),
    ]);
    return c.body(null, 200);
  });

  app.post('/v2/timetables/frame', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(c, z.object({ semester: z.string(), timetable_name: optionalText(255) }));
    const semester = await findSemester(db, { semester: request.semester });
    return c.json(frameResponse(await createFrame(db, userId, semester.id, request.timetable_name), 2));
  });
  app.post('/v3/timetables/frame', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(c, z.object({ year: z.number().int(), term: z.string() }));
    const semester = await findSemester(db, { year: request.year, term: termKey(request.term) });
    await createFrame(db, userId, semester.id);
    return c.json(await semesterFrames(db, userId, semester.id, 3));
  });
  const updateFrame = async (c: Context<ApiEnv>, version: 2 | 3) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(
      c,
      z.object({
        is_main: z.boolean(),
        name: z.string().max(255).optional(),
        timetable_name: z.string().max(255).optional(),
      }),
    );
    const frame = await ownedFrame(db, integer(c.req.param('id')), userId);
    if (frame.is_main && !request.is_main) return invalid('메인 시간표는 필수입니다.');
    const name = version === 3 ? request.name : request.timetable_name;
    if (name === undefined) return invalid('시간표 이름을 입력해주세요.');
    if (request.is_main)
      await db
        .update(frames)
        .set({
          is_main: sql`${frames.id} = ${frame.id}`,
          name: sql`case when ${frames.id} = ${frame.id} then ${name} else ${frames.name} end`,
        })
        .where(
          and(eq(frames.user_id, userId), eq(frames.semester_id, frame.semester_id), eq(frames.is_deleted, false)),
        );
    else await db.update(frames).set({ name, is_main: false }).where(eq(frames.id, frame.id));
    return version === 3
      ? c.json(await semesterFrames(db, userId, frame.semester_id, 3))
      : c.json(frameResponse({ ...frame, name, is_main: request.is_main }, 2));
  };
  app.put('/v2/timetables/frame/:id', (c) => updateFrame(c, 2));
  app.put('/v3/timetables/frame/:id', (c) => updateFrame(c, 3));
  app.get('/v2/timetables/frames', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const semesterName = c.req.query('semester');
    if (semesterName !== undefined) {
      const semester = await findSemester(db, { semester: semesterName });
      return c.json(await semesterFrames(db, userId, semester.id, 2));
    }
    const rows = await db
      .select({ frame: frames, semester: semesters })
      .from(frames)
      .innerJoin(semesters, eq(semesters.id, frames.semester_id))
      .where(and(eq(frames.user_id, userId), eq(frames.is_deleted, false)))
      .orderBy(asc(frames.id));
    const grouped: Record<string, FrameResponse[]> = {};
    for (const { frame, semester } of rows) (grouped[semester.semester] ??= []).push(frameResponse(frame, 2));
    return c.json({ semesters: grouped });
  });
  app.get('/v3/timetables/frame', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const semester = await findSemester(db, { year: integer(c.req.query('year')), term: termKey(c.req.query('term')) });
    return c.json(await semesterFrames(db, userId, semester.id, 3));
  });
  app.get('/v3/timetables/frames', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const rows = await db
      .select({ frame: frames, semester: semesters })
      .from(frames)
      .innerJoin(semesters, eq(semesters.id, frames.semester_id))
      .where(and(eq(frames.user_id, userId), eq(frames.is_deleted, false)));
    rows.sort(
      (a, b) =>
        semesterOrder(a.semester, b.semester) ||
        Number(b.frame.is_main) - Number(a.frame.is_main) ||
        a.frame.id - b.frame.id,
    );
    const years: { year: number; timetable_frames: { term: string; frames: FrameResponse[] }[] }[] = [];
    for (const { frame, semester } of rows) {
      let year = years.find((entry) => entry.year === semester.year);
      if (!year) {
        year = { year: semester.year, timetable_frames: [] };
        years.push(year);
      }
      const term = terms[semester.term as Term].label;
      let group = year.timetable_frames.find((entry) => entry.term === term);
      if (!group) {
        group = { term, frames: [] };
        year.timetable_frames.push(group);
      }
      group.frames.push(frameResponse(frame, 3));
    }
    return c.json(years);
  });
  app.delete('/v2/timetables/frame', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const frame = await ownedFrame(db, integer(c.req.query('id')), userId);
    await removeFrames(db, userId, [frame.id], frame);
    return c.body(null, 204);
  });
  const removeSemester = async (c: Context<ApiEnv>, version: 2 | 3) => {
    const userId = student(c);
    const db = c.get('db');
    const semester = await findSemester(
      db,
      version === 2
        ? { semester: c.req.query('semester') ?? invalid('학기 정보를 입력해주세요.') }
        : { year: integer(c.req.query('year')), term: termKey(c.req.query('term')) },
    );
    const rows = await db
      .select({ id: frames.id })
      .from(frames)
      .where(and(eq(frames.user_id, userId), eq(frames.semester_id, semester.id), eq(frames.is_deleted, false)));
    await removeFrames(
      db,
      userId,
      rows.map((row) => row.id),
      null,
    );
    return c.body(null, 204);
  };
  app.delete('/v2/all/timetables/frame', (c) => removeSemester(c, 2));
  app.delete('/v3/timetables/frames', (c) => removeSemester(c, 3));

  const getTimetable = async (c: Context<ApiEnv>, version: 2 | 3) => {
    const userId = student(c);
    const db = c.get('db');
    const frame = await ownedFrame(db, integer(c.req.query('timetable_frame_id')), userId);
    return c.json(await timetableResponse(db, frame, userId, version));
  };
  app.get('/v2/timetables/lecture', (c) => getTimetable(c, 2));
  app.get('/v3/timetables/lecture', (c) => getTimetable(c, 3));
  app.get('/v3/timetables/main/lectures', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const rows = await db
      .select({ id: frames.id })
      .from(frames)
      .where(and(eq(frames.user_id, userId), eq(frames.is_main, true), eq(frames.is_deleted, false)));
    return c.json({
      timetable: (
        await joinedTimetable(
          db,
          rows.map((row) => row.id),
        )
      ).map((row) => lectureResponse(row, 3)),
    });
  });
  app.post('/v2/timetables/lecture', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(
      c,
      z.object({ timetable_frame_id: z.number().int(), timetable_lecture: z.array(lectureInput) }),
    );
    const frame = await ownedFrame(db, request.timetable_frame_id, userId);
    const values = [];
    for (const input of request.timetable_lecture) {
      if (input.lecture_id == null && !input.class_infos) return invalid('강의 시간을 입력해주세요.');
      const lecture = input.lecture_id == null ? null : await findLecture(db, input.lecture_id);
      values.push({
        ...lectureValues(input, 2),
        ...(await classification(db, lecture, userId)),
        frame_id: frame.id,
        lectures_id: lecture?.id ?? null,
      });
    }
    if (values.length)
      await db.batch([
        graduationChangedStatement(db, userId),
        ...values.map((value) => db.insert(timetable).values(value)),
      ]);
    return c.json(await timetableResponse(db, frame, userId, 2));
  });
  app.put('/v2/timetables/lecture', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(
      c,
      z.object({
        timetable_frame_id: z.number().int(),
        timetable_lecture: z.array(lectureInput.extend({ id: z.number().int() })).min(1),
      }),
    );
    const frame = await ownedFrame(db, request.timetable_frame_id, userId);
    for (const input of request.timetable_lecture) {
      const row = await ownedLecture(db, input.id, userId);
      if (row.frame_id !== frame.id) throw new ApiError(403, '', `권한이 없습니다. userId: ${userId}`);
    }
    await db.batch([
      graduationChangedStatement(db, userId),
      ...request.timetable_lecture.map((input) =>
        db.update(timetable).set(lectureValues(input, 2)).where(eq(timetable.id, input.id)),
      ),
    ]);
    return c.json(await timetableResponse(db, frame, userId, 2));
  });
  app.post('/v3/timetables/lecture/regular', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(c, z.object({ timetable_frame_id: z.number().int(), lecture_id: z.number().int() }));
    const frame = await ownedFrame(db, request.timetable_frame_id, userId);
    const lecture = await findLecture(db, request.lecture_id);
    await db.batch([
      db.insert(timetable).values({
        frame_id: frame.id,
        lectures_id: lecture.id,
        grades: '0',
        ...(await classification(db, lecture, userId)),
      }),
      graduationChangedStatement(db, userId),
    ]);
    return c.json(await timetableResponse(db, frame, userId, 3));
  });
  app.post('/v3/timetables/lecture/custom', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(c, z.object({ timetable_frame_id: z.number().int(), timetable_lecture: lectureInput }));
    const frame = await ownedFrame(db, request.timetable_frame_id, userId);
    await db.insert(timetable).values({ frame_id: frame.id, ...lectureValues(request.timetable_lecture, 3) });
    return c.json(await timetableResponse(db, frame, userId, 3));
  });
  app.put('/v3/timetables/lecture/custom', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(
      c,
      z.object({
        timetable_frame_id: z.number().int(),
        timetable_lecture: lectureInput.extend({ id: z.number().int() }),
      }),
    );
    const frame = await ownedFrame(db, request.timetable_frame_id, userId);
    const row = await ownedLecture(db, request.timetable_lecture.id, userId);
    if (row.frame_id !== frame.id) throw new ApiError(403, '', `권한이 없습니다. userId: ${userId}`);
    const { grades, memo, ...values } = lectureValues(request.timetable_lecture, 3);
    await db.update(timetable).set(values).where(eq(timetable.id, row.id));
    return c.json(await timetableResponse(db, frame, userId, 3));
  });
  app.put('/v3/timetables/lecture/regular', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const request = await body(
      c,
      z.object({
        timetable_frame_id: z.number().int(),
        timetable_lecture: lectureInput.extend({
          id: z.number().int(),
          class_places: z.array(z.object({ class_place: z.string().max(30) })),
        }),
      }),
    );
    const frame = await ownedFrame(db, request.timetable_frame_id, userId);
    const input = request.timetable_lecture;
    const row = await ownedLecture(db, input.id, userId);
    if (row.frame_id !== frame.id) throw new ApiError(403, '', `권한이 없습니다. userId: ${userId}`);
    const course =
      input.course_type == null
        ? null
        : (
            await db.select().from(schema.course_type).where(eq(schema.course_type.name, input.course_type)).limit(1)
          )[0];
    const area =
      input.general_education_area == null
        ? null
        : (
            await db
              .select()
              .from(schema.general_education_area)
              .where(eq(schema.general_education_area.name, input.general_education_area))
              .limit(1)
          )[0];
    if (course === undefined)
      throw new ApiError(404, '', `존재하지 않는 이수 구분입니다. course_type_name: ${input.course_type}`);
    if (area === undefined)
      throw new ApiError(404, '', `존재하지 않는 교양 이수구분입니다. name${input.general_education_area}`);
    const lecture = row.lectures_id === null ? null : await findLecture(db, row.lectures_id);
    await db.batch([
      db
        .update(timetable)
        .set({
          class_title:
            (lecture?.name ?? row.class_title) === input.class_title ? row.class_title : (input.class_title ?? null),
          class_place: input.class_places.map((entry) => entry.class_place).join(', '),
          course_type_id: course?.id ?? null,
          general_education_area_id: area?.id ?? null,
        })
        .where(eq(timetable.id, row.id)),
      graduationChangedStatement(db, userId),
    ]);
    return c.json(await timetableResponse(db, frame, userId, 3));
  });
  const removeLectures = async (c: Context<ApiEnv>, ids: number[]) => {
    const userId = student(c);
    const db = c.get('db');
    for (const id of ids) await ownedLecture(db, id, userId);
    if (ids.length)
      await db.batch([
        db
          .update(timetable)
          .set({ is_deleted: true })
          .where(inArray(timetable.id, sql`select cast(value as integer) from json_each(${JSON.stringify(ids)})`)),
        graduationChangedStatement(db, userId),
      ]);
    return c.body(null, 204);
  };
  app.delete('/v2/timetables/lecture/:id', (c) => removeLectures(c, [integer(c.req.param('id'))]));
  app.delete('/v2/timetables/lectures', (c) =>
    removeLectures(
      c,
      (c.req.queries('timetable_lecture_ids') ?? invalid('시간표 강의 id를 입력해주세요.'))
        .flatMap((value) => value.split(','))
        .map(integer),
    ),
  );
  app.delete('/v2/timetables/frame/:frameId/lecture/:lectureId', async (c) => {
    const userId = student(c);
    const db = c.get('db');
    const frame = await ownedFrame(db, integer(c.req.param('frameId')), userId);
    await db.batch([
      db
        .update(timetable)
        .set({ is_deleted: true })
        .where(
          and(
            eq(timetable.frame_id, frame.id),
            eq(timetable.lectures_id, integer(c.req.param('lectureId'))),
            eq(timetable.is_deleted, false),
          ),
        ),
      graduationChangedStatement(db, userId),
    ]);
    return c.body(null, 204);
  });
  const rollbackLecture = async (c: Context<ApiEnv>, version: 2 | 3) => {
    const userId = student(c);
    const db = c.get('db');
    const ids = (c.req.queries('timetable_lectures_id') ?? []).flatMap((value) => value.split(',')).map(integer);
    if (!ids.length) return invalid('시간표 강의 id를 입력해주세요.');
    const rows = [];
    for (const id of ids) rows.push(await ownedLecture(db, id, userId, true));
    await db
      .update(timetable)
      .set({ is_deleted: false })
      .where(inArray(timetable.id, sql`select cast(value as integer) from json_each(${JSON.stringify(ids)})`));
    const frame = await ownedFrame(db, rows[0].frame_id!, userId);
    return c.json(await timetableResponse(db, frame, userId, version));
  };
  const rollbackFrame = async (c: Context<ApiEnv>, version: 2 | 3) => {
    const userId = student(c);
    const db = c.get('db');
    const frame = await ownedFrame(db, integer(c.req.query('timetable_frame_id')), userId, true);
    await db.batch([
      db
        .update(frames)
        .set({
          is_deleted: false,
          is_main: sql`case when not exists(select 1 from ${frames} where user_id=${userId} and semester_id=${frame.semester_id} and is_deleted=0) then 1 else ${frames.is_main} end`,
        })
        .where(eq(frames.id, frame.id)),
      db.update(timetable).set({ is_deleted: false }).where(eq(timetable.frame_id, frame.id)),
    ]);
    return c.json(await timetableResponse(db, await ownedFrame(db, frame.id, userId), userId, version));
  };
  app.post('/v2/timetables/lecture/rollback', (c) => rollbackLecture(c, 2));
  app.post('/v3/timetables/lecture/rollback', (c) => rollbackLecture(c, 3));
  app.post('/v2/timetables/frame/rollback', (c) => rollbackFrame(c, 2));
  app.post('/v3/timetables/frame/rollback', (c) => rollbackFrame(c, 3));
}
