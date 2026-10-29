import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertRows } from '~/services/lecture/convert';
import { readSheet } from '../support/readSheet';
import { FIXTURE_SPECS } from '../fixtures/lecture/specs';

/**
 * 아직 프로덕션에 반영되지 않아 정답지가 없는 학기.
 * 대조할 대상이 없으니 "파서가 한 행도 포기하지 않았는지"만 본다.
 */
describe('미반영 학기 변환', () => {
  it('seasonal-2026-summer', async () => {
    const name = 'seasonal-2026-summer';
    const rows = await readSheet(fileURLToPath(new URL(`../fixtures/lecture/xlsx/${name}.xlsx`, import.meta.url)));
    const result = convertRows(rows, FIXTURE_SPECS[name]);

    console.log(
      `\n[${name}] 엑셀 ${result.stats.totalRows}행 → 강의 ${result.stats.converted}건 (건너뜀 ${result.stats.skipped}, 시간없음 ${result.stats.withoutTime}, 파싱실패 ${result.issues.length})`,
    );
    for (const lecture of result.lectures) {
      const time = lecture.lecture_infos.map((i) => `${i.day}:${i.start_time % 100}-${i.end_time % 100}`).join(' ');
      console.log(
        `  ${lecture.code}|${lecture.lecture_class} ${lecture.name} · ${lecture.professor} · ${lecture.regular_number}명`,
      );
      console.log(`     ${time}`);
    }
    if (result.issues.length > 0) {
      console.log('  파싱 실패:', result.issues);
    }

    expect(result.issues).toHaveLength(0);
    expect(result.stats.converted).toBeGreaterThan(0);
  });
});
