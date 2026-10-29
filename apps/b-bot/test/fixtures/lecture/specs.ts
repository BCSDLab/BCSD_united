import type { MappingSpec } from '~/services/lecture/types';

/**
 * 골든 테스트용 손수 작성한 매핑 스펙.
 * 나중에 LLM이 같은 모양의 객체를 만들게 되고, 그때 이 값들이 정답지가 된다.
 */
export const FIXTURE_SPECS: Record<string, MappingSpec> = {
  'regular-2025-2': {
    headerRow: 1,
    timeFormat: 'period',
    columns: {
      department: 3,
      code: 4,
      lectureClass: 5,
      name: 6,
      grades: 8,
      designScore: 11,
      regularNumber: 12,
      professor: 13,
      target: 14,
      classTime: 16,
      isEnglish: 18,
    },
  },
  'regular-2026-1': {
    headerRow: 2,
    timeFormat: 'period',
    columns: {
      department: 3,
      code: 4,
      name: 5,
      lectureClass: 6,
      regularNumber: 7,
      grades: 8,
      designScore: 11,
      target: 13,
      professor: 15,
      classTime: 16,
      isEnglish: 24,
    },
  },
  'regular-2026-2': {
    headerRow: 2,
    timeFormat: 'period',
    columns: {
      department: 4,
      code: 5,
      name: 6,
      lectureClass: 7,
      grades: 9,
      designScore: 12,
      professor: 14,
      regularNumber: 15,
      target: 16,
      classTime: 17,
      isEnglish: 26,
    },
  },
  'seasonal-2025-summer': {
    headerRow: 3,
    timeFormat: 'range',
    columns: {
      department: 1,
      code: 2,
      name: 3,
      lectureClass: 4,
      grades: 7,
      designScore: 10,
      classTime: 11,
      professor: 12,
      regularNumber: 13,
    },
  },
  'seasonal-2025-winter': {
    headerRow: 3,
    timeFormat: 'range',
    columns: {
      department: 1,
      code: 2,
      name: 3,
      lectureClass: 4,
      grades: 7,
      designScore: 10,
      classTime: 11,
      professor: 12,
      regularNumber: 13,
    },
  },
  'seasonal-2026-summer': {
    headerRow: 3,
    timeFormat: 'range',
    columns: {
      code: 3,
      name: 4,
      lectureClass: 5,
      grades: 8,
      designScore: 11,
      department: 12,
      regularNumber: 13,
      target: 15,
      classTime: 16,
      professor: 17,
    },
  },
};

/** 프로덕션에 이미 반영돼 API로 정답을 받아올 수 있는 학기들. */
export const GOLDEN_CASES = [
  'regular-2025-2',
  'regular-2026-1',
  'regular-2026-2',
  'seasonal-2025-summer',
  'seasonal-2025-winter',
] as const;
