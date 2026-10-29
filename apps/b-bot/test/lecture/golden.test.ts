import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertRows } from '~/services/lecture/convert';
import { readSheet } from '../support/readSheet';
import type { Lecture } from '~/services/lecture/types';
import { FIXTURE_SPECS, GOLDEN_CASES } from '../fixtures/lecture/specs';

const fixture = (relative: string) => fileURLToPath(new URL(`../fixtures/lecture/${relative}`, import.meta.url));

const key = (lecture: { code: string; lecture_class: string }) => `${lecture.code}|${lecture.lecture_class}`;

const sameTime = (a: Lecture['lecture_infos'], b: Lecture['lecture_infos']) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 엑셀과 프로덕션이 실제로 다른 건수. 전부 확인한 결과 파서 문제가 아니었다.
 * - regular: 슬롯은 정확히 맞고 요일만 다르다. 공지 후 학교가 요일을 바꾼 경우.
 * - 2026-1: 엑셀이 2/3 공지본이라 이후 정정분이 가장 많이 빠져 있다.
 * - 2025-동계: 시간대가 1~2시간 당겨지거나 밀린 강의 4건.
 */
const ALLOWED_TIME_DRIFT: Record<string, number> = {
  'regular-2025-2': 2,
  'regular-2026-1': 8,
  'regular-2026-2': 1,
  'seasonal-2025-summer': 0,
  'seasonal-2025-winter': 4,
};

/** 엑셀에 없는데 프로덕션에는 있는 강의(운영자가 따로 추가한 온라인 강좌 등). */
const ALLOWED_MISSING: Record<string, number> = {
  'regular-2025-2': 0,
  'regular-2026-1': 2,
  'regular-2026-2': 0,
  'seasonal-2025-summer': 0,
  'seasonal-2025-winter': 0,
};

/**
 * 이미 사람이 수동으로 반영해둔 학기를 변환기로 다시 만들어 프로덕션과 대조한다.
 * 강의시간이 틀리면 시간표가 깨지므로 lecture_infos를 가장 엄격하게 본다.
 */
describe('강의 엑셀 변환 골든 테스트', () => {
  for (const name of GOLDEN_CASES) {
    it(name, async () => {
      const rows = await readSheet(fixture(`xlsx/${name}.xlsx`));
      const result = convertRows(rows, FIXTURE_SPECS[name]);

      const expectedList: Lecture[] = JSON.parse(await readFile(fixture(`expected/${name}.json`), 'utf-8'));

      const actual = new Map(result.lectures.map((l) => [key(l), l]));
      const matched: Lecture[] = [];
      const missing: Lecture[] = [];
      const timeMismatch: { key: string; expected: unknown; actual: unknown }[] = [];

      for (const want of expectedList) {
        const got = actual.get(key(want));
        if (!got) {
          missing.push(want);
          continue;
        }
        matched.push(want);
        if (!sameTime(want.lecture_infos, got.lecture_infos)) {
          timeMismatch.push({
            key: key(want),
            expected: want.lecture_infos,
            actual: got.lecture_infos,
          });
        }
      }

      const fieldHits: Record<string, number> = {};
      for (const want of matched) {
        const got = actual.get(key(want))!;
        for (const field of [
          'name',
          'professor',
          'grades',
          'regular_number',
          'department',
          'target',
          'design_score',
        ] as const) {
          fieldHits[field] = (fieldHits[field] ?? 0) + (String(want[field]) === String(got[field]) ? 1 : 0);
        }
      }

      const pct = (n: number, d: number) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(1)}%`);
      console.log(`\n[${name}]`);
      console.log(
        `  엑셀 ${result.stats.totalRows}행 → 변환 ${result.stats.converted}건 (건너뜀 ${result.stats.skipped}, 시간없음 ${result.stats.withoutTime})`,
      );
      console.log(`  프로덕션 ${expectedList.length}건 중 매칭 ${matched.length} / 누락 ${missing.length}`);
      console.log(
        `  강의시간 일치 ${matched.length - timeMismatch.length}/${matched.length} (${pct(matched.length - timeMismatch.length, matched.length)})`,
      );
      for (const [field, hit] of Object.entries(fieldHits)) {
        console.log(`    ${field.padEnd(15)} ${pct(hit, matched.length)}`);
      }
      if (result.issues.length > 0) {
        console.log(`  파싱 실패 ${result.issues.length}건:`, result.issues.slice(0, 5));
      }
      if (missing.length > 0) {
        console.log(
          `  누락 예시:`,
          missing.slice(0, 3).map((m) => `${key(m)} ${m.name}`),
        );
      }
      if (timeMismatch.length > 0) {
        const brief = (infos: unknown) =>
          (infos as Lecture['lecture_infos'])
            .map((i) => `${i.day}:${i.start_time % 100}-${i.end_time % 100}`)
            .join(' ');
        console.log(`  강의시간 불일치 ${timeMismatch.length}건:`);
        for (const m of timeMismatch.slice(0, 5)) {
          console.log(`    ${m.key}`);
          console.log(`      기대 ${brief(m.expected)}`);
          console.log(`      실제 ${brief(m.actual)}`);
        }
      }

      // 파서는 어떤 행에서도 실패하면 안 된다. 실패는 곧 규칙을 모르는 표기가 생겼다는 뜻이다.
      expect(result.issues).toHaveLength(0);

      // 엑셀은 공지 시점 스냅샷이고 프로덕션은 그 뒤 정정까지 반영해서 완전 일치가 원리상 불가능하다.
      // 남은 차이를 건수로 못박아 두면, 늘어나는 순간이 곧 파서 회귀다.
      expect(timeMismatch.length).toBeLessThanOrEqual(ALLOWED_TIME_DRIFT[name]);
      expect(missing.length).toBeLessThanOrEqual(ALLOWED_MISSING[name]);
    });
  }
});
