import { z } from 'zod';

const text = z.string().max(200_000);
const uint = z.number().int().min(0).max(4_294_967_295);
const flag = z.union([z.literal(0), z.literal(1)]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dining = z
  .object({
    date,
    type: text.max(9),
    place: text.max(9),
    price_card: uint.nullable(),
    price_cash: uint.nullable(),
    kcal: uint.nullable(),
    menu: text.max(65_535),
    is_changed: text.nullable(),
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
    content: text.nullable(),
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
  .strict()
  .superRefine((row, ctx) => {
    if (new Set(row.attachments.map((item) => item.hash)).size !== row.attachments.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate attachment hash' });
  });
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
    content: text.nullable(),
  })
  .strict();
const citybus = z
  .object({
    id: z.string().min(1).max(255),
    bus_info: z.unknown().refine((value) => value !== undefined),
    bus_timetables: z.unknown().refine((value) => value !== undefined),
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
const dataset = z.enum(['dining', 'articles', 'lectures', 'semesters', 'versions', 'citybus', 'weather']);
const keys = {
  dining: z.tuple([date, text.max(9), text.max(9)]),
  articles: z.tuple([uint, uint]),
  lectures: z.tuple([text.max(10), text.max(10), text.max(3)]),
  semesters: z.tuple([text.max(10)]),
  versions: z.tuple([z.literal('timetable')]),
  citybus: z.tuple([z.string().min(1).max(255)]),
  weather: z.tuple([z.literal('Weather:byeongcheon')]),
} as const;
export type Key = (string | number)[];
export function parseKey(name: Dataset, value: unknown): Key {
  return keys[name].parse(value) as Key;
}
export function rowKey(name: Dataset, row: Record<string, unknown>): Key {
  switch (name) {
    case 'dining':
      return [row.date as string, row.type as string, row.place as string];
    case 'articles':
      return [row.board_id as number, row.portal_num as number];
    case 'lectures':
      return [row.semester_date as string, row.code as string, row.class as string];
    case 'semesters':
      return [row.semester as string];
    case 'versions':
      return ['timetable'];
    case 'citybus':
    case 'weather':
      return [row.id as string];
  }
}
/** SQLite NOCASE folds ASCII A-Z only; do not Unicode-normalize source identifiers. */
export function canonicalKey(name: Dataset, key: Key): string {
  return JSON.stringify(
    key.map((value, index) =>
      typeof value === 'string' && (name === 'lectures' || name === 'versions' || (name === 'dining' && index > 0))
        ? value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
        : value,
    ),
  );
}
const baseline = z
  .object({ version: z.literal(2), action: z.literal('baseline'), dataset, keys: z.array(z.unknown()).min(1).max(100) })
  .strict();
const delta = z
  .object({
    version: z.literal(2),
    dataset,
    checkpoint: z.string().regex(/^[1-9]\d{12,14}$/),
    page: z.number().int().min(0).max(100_000),
    final: z.boolean(),
    upserts: z.array(z.unknown()).max(1_000),
    deletes: z.array(z.unknown()).max(100),
  })
  .strict();
export type Baseline = { version: 2; action: 'baseline'; dataset: Dataset; keys: Key[] };
export type Delta = {
  version: 2;
  dataset: Dataset;
  checkpoint: string;
  page: number;
  final: boolean;
  upserts: Record<string, unknown>[];
  deletes: Key[];
};
export type SourceEnvelope = Baseline | Delta;
export function parseEnvelope(raw: string): SourceEnvelope {
  const object: unknown = JSON.parse(raw);
  if (typeof object !== 'object' || !object || !('version' in object) || object.version !== 2)
    throw new TypeError('Only source sync v2 is accepted');
  if ('action' in object) {
    const payload = baseline.parse(object);
    const parsed = payload.keys.map((value) => parseKey(payload.dataset, value));
    if (new Set(parsed.map((key) => canonicalKey(payload.dataset, key))).size !== parsed.length)
      throw new TypeError('Duplicate baseline keys');
    return { ...payload, keys: parsed };
  }
  const payload = delta.parse(object);
  const schema: z.ZodType = sourceRows[payload.dataset];
  const upserts = payload.upserts.map((row) => schema.parse(row) as Record<string, unknown>);
  const deletes = payload.deletes.map((value) => parseKey(payload.dataset, value));
  const upsertKeys = upserts.map((row) => canonicalKey(payload.dataset, rowKey(payload.dataset, row)));
  const deleteKeys = deletes.map((key) => canonicalKey(payload.dataset, key));
  if (new Set(deleteKeys).size !== deleteKeys.length || deleteKeys.some((key) => upsertKeys.includes(key)))
    throw new TypeError('Duplicate or contradictory operations');
  if (
    payload.dataset !== 'lectures' &&
    payload.dataset !== 'versions' &&
    new Set(upsertKeys).size !== upsertKeys.length
  )
    throw new TypeError('Duplicate entity operations');
  if (payload.dataset === 'versions') {
    const versions = upserts.map((row) => (row.version as string).replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
    if (new Set(versions).size !== versions.length) throw new TypeError('Duplicate version rows');
  }
  if (
    new Set(upsertKeys).size + deletes.length > 100 ||
    (!upserts.length && !deletes.length) ||
    (payload.dataset !== 'lectures' && payload.dataset !== 'versions' && upserts.length > 100)
  )
    throw new TypeError('Empty or oversized delta');
  return { ...payload, upserts, deletes };
}
