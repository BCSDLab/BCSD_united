import regularPrompt from './prompts/regular-timetable';
import { normalizeSemester, normalizeVacationSemester } from './convert';
import { generateStructured } from '@koin/b-bot-ai';
import type { RawRegularCoopTimetable } from './types';
import type { StructuredImageMimeType } from '@koin/b-bot-ai';

const RAW_TIMETABLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'semesterLabel', 'fromDate', 'toDate', 'shops'],
  properties: {
    title: { type: 'string' },
    semesterLabel: { type: 'string' },
    fromDate: { type: 'string' },
    toDate: { type: 'string' },
    shops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['groupLabel', 'shopLabel', 'phone', 'remark', 'operationHours'],
        properties: {
          groupLabel: { type: 'string' },
          shopLabel: { type: 'string' },
          phone: { type: 'string' },
          remark: { type: 'string' },
          operationHours: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['dayLabel', 'type', 'openTime', 'closeTime', 'rawText'],
              properties: {
                dayLabel: { type: 'string' },
                type: { type: 'string' },
                openTime: { type: 'string' },
                closeTime: { type: 'string' },
                rawText: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const isRegularSemesterLabel = (label: string): boolean => normalizeSemester(label) !== null;

export function resolveRegularSemesterLabel(semesterLabel: string, title: string): string | null {
  return normalizeSemester(semesterLabel) ?? normalizeSemester(title);
}

export async function extractCoopTimetable({
  imageBase64,
  mimeType,
  fileName,
}: {
  imageBase64: string;
  mimeType: StructuredImageMimeType;
  fileName: string;
}): Promise<RawRegularCoopTimetable> {
  const extracted = await generateStructured<RawRegularCoopTimetable>({
    system: regularPrompt,
    prompt: `첨부한 생협 운영시간 이미지를 읽어주세요. 파일명: ${fileName}`,
    schema: RAW_TIMETABLE_SCHEMA,
    images: [{ data: imageBase64, mimeType }],
    maxTokens: 8192,
  });

  return extracted;
}

export async function extractVacationTimetable(
  input: Parameters<typeof extractCoopTimetable>[0],
): Promise<RawRegularCoopTimetable> {
  const extracted = await extractCoopTimetable(input);
  const vacation = normalizeVacationSemester(extracted.semesterLabel) ?? normalizeVacationSemester(extracted.title);
  if (!vacation) {
    throw new Error(
      [
        '하계·동계 방학 시간표가 아닙니다.',
        `읽은 학기: ${extracted.semesterLabel || '(없음)'}`,
        `읽은 제목: ${extracted.title || '(없음)'}`,
      ].join('\n'),
    );
  }
  return {
    ...extracted,
    semesterLabel: `${vacation.year}년 ${vacation.season}방학`,
  };
}

export type ExtractedCoopSemester =
  | { kind: 'regular'; year: number; termName: '1학기' | '2학기'; normalizedLabel: string }
  | {
      kind: 'vacation';
      year: number;
      season: '하계' | '동계';
      termName: '하계방학' | '동계방학';
      normalizedLabel: string;
    };

export function resolveExtractedCoopSemester(
  extracted: Pick<RawRegularCoopTimetable, 'semesterLabel' | 'title'>,
): ExtractedCoopSemester | null {
  const regular = resolveRegularSemesterLabel(extracted.semesterLabel, extracted.title);
  const regularMatch = /^(\d{2})-([12])학기$/.exec(regular ?? '');
  if (regularMatch) {
    return {
      kind: 'regular',
      year: 2000 + Number(regularMatch[1]),
      termName: `${regularMatch[2]}학기` as '1학기' | '2학기',
      normalizedLabel: regular!,
    };
  }
  const vacation = normalizeVacationSemester(extracted.semesterLabel) ?? normalizeVacationSemester(extracted.title);
  if (!vacation) return null;
  return {
    kind: 'vacation',
    year: vacation.year,
    season: vacation.season,
    termName: `${vacation.season}방학`,
    normalizedLabel: `${vacation.year}년 ${vacation.season}방학`,
  };
}
