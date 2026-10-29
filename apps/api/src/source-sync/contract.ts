import { z } from 'zod';

const text = z.string().max(200_000);
const uint = z.number().int().min(0).max(4_294_967_295);
const flag = z.union([z.literal(0), z.literal(1)]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalText = text.nullable();
const dining = z
  .object({
    date,
    type: text.max(9),
    place: text.max(9),
    price_card: uint.nullable(),
    price_cash: uint.nullable(),
    kcal: uint.nullable(),
    menu: text.max(65_535),
    is_changed: optionalText,
    image_url: text.max(255).nullable(),
  })
  .strict();
const attachment = z
  .object({ hash: z.string().regex(/^[a-f0-9]{64}$/), url: text, name: text, is_deleted: flag })
  .strict();
const article = z
  .object({
    board_id: uint,
    portal_num: uint,
    title: text.max(255),
    content: optionalText,
    is_notice: flag,
    is_deleted: flag,
    author: text.max(50),
    portal_hit: uint,
    url: text.max(255),
    registered_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/)
      .nullable(),
    attachments: z.array(attachment).max(1_000),
  })
  .strict();
const lecture = z
  .object({
    semester_date: text.max(10),
    code: text.max(10),
    name: text.max(50),
    grades: text.max(2),
    class: text.max(3),
    regular_number: text.max(4),
    department: text.max(30),
    target: text.max(200),
    professor: text.max(30).nullable(),
    is_english: text.max(2),
    design_score: text.max(2),
    is_elearning: text.max(2),
    class_time: text.max(255),
  })
  .strict();
const semester = z.object({ semester: text.max(10), year: uint, term: text.max(20) }).strict();
const version = z
  .object({
    version: text.max(255),
    type: z.literal('timetable'),
    title: text.max(255).nullable(),
    is_previous: flag.nullable(),
    content: optionalText,
  })
  .strict();
const citybus = z
  .object({
    id: z.string().min(1).max(255),
    bus_info: z.unknown(),
    bus_timetables: z.unknown(),
    updated_at: z.string().min(10).max(40),
  })
  .strict();
const epochMilliseconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const weatherHour = z
  .object({
    temperature: z.number().finite(),
    weather: z.string().min(1).max(32),
    weather_id: z.number().int().min(1).max(7),
    weather_icon_url: z.string().url().max(255).startsWith('https://'),
  })
  .strict();
const weather = z
  .object({
    id: z.literal('Weather:byeongcheon'),
    payload: z
      .record(z.string().regex(/^\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])00$/), weatherHour)
      .refine((hours) => Object.keys(hours).length > 0),
    expires_at: epochMilliseconds.nullable(),
    updated_at: epochMilliseconds,
  })
  .strict();
export const sourceRows = {
  dining,
  articles: article,
  lectures: lecture,
  semesters: semester,
  versions: version,
  citybus,
  weather,
} as const;
export type Dataset = keyof typeof sourceRows;
export const datasets = Object.keys(sourceRows) as Dataset[];
export const envelope = z
  .object({
    version: z.literal(1),
    dataset: z.enum(['dining', 'articles', 'lectures', 'semesters', 'versions', 'citybus', 'weather']),
    checkpoint: z.string().regex(/^[1-9]\d{12,14}$/),
    page: z.number().int().min(0).max(100_000),
    final: z.boolean(),
    rows: z.array(z.unknown()).max(100),
    totalRows: z.number().int().min(0).max(2_000_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.final !== (value.totalRows !== undefined))
      ctx.addIssue({ code: 'custom', message: 'totalRows is required only on final page' });
  });
export type SourceEnvelope = z.infer<typeof envelope>;
export function parseEnvelope(raw: string): SourceEnvelope {
  const payload = envelope.parse(JSON.parse(raw));
  const schema: z.ZodType = sourceRows[payload.dataset];
  payload.rows.forEach((row) => schema.parse(row));
  return payload;
}
