import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockingIssues, buildAdminRequest, toAdminTerm, toClassTime } from '~/services/lecture/adminApi';
import { convertRows } from '~/services/lecture/convert';
import { readSheet } from '../support/readSheet';
import { FIXTURE_SPECS } from '../fixtures/lecture/specs';

const CASES: { name: string; year: number; term: string }[] = [
  { name: 'regular-2025-2', year: 2025, term: '2학기' },
  { name: 'regular-2026-1', year: 2026, term: '1학기' },
  { name: 'regular-2026-2', year: 2026, term: '2학기' },
  { name: 'seasonal-2025-summer', year: 2025, term: '여름학기' },
  { name: 'seasonal-2025-winter', year: 2025, term: '겨울학기' },
  { name: 'seasonal-2026-summer', year: 2026, term: '여름학기' },
];

async function build(name: string, year: number, term: string) {
  const rows = await readSheet(fileURLToPath(new URL(`../fixtures/lecture/xlsx/${name}.xlsx`, import.meta.url)));
  const { lectures } = convertRows(rows, FIXTURE_SPECS[name]);
  return buildAdminRequest(lectures, { year, term: toAdminTerm(term) });
}

describe('class_time 평탄화', () => {
  it('구간을 슬롯 하나하나로 펼친다', () => {
    // 월 07A~09B = 슬롯 12~17
    expect(toClassTime([{ day: 0, start_time: 12, end_time: 17 }])).toEqual([12, 13, 14, 15, 16, 17]);
  });

  it('요일이 다르면 각자의 값을 유지한다', () => {
    expect(
      toClassTime([
        { day: 0, start_time: 2, end_time: 3 },
        { day: 1, start_time: 102, end_time: 103 },
      ]),
    ).toEqual([2, 3, 102, 103]);
  });
});

describe('어드민 요청 사전 검증', () => {
  for (const { name, year, term } of CASES) {
    it(name, async () => {
      const { request, issues, stats } = await build(name, year, term);

      const blocking = blockingIssues(issues);
      console.log(`\n[${name}] ${request.year} ${request.term}`);
      console.log(`  강의 ${stats.total}건 · 시간없음 ${stats.withoutTime} · class_time 최대 ${stats.maxClassTime}/50`);
      console.log(`  반영 불가 ${blocking.length} · 값 없음 ${issues.length - blocking.length}`);
      if (issues.length > 0) {
        const byKind = issues.reduce<Record<string, number>>((acc, i) => {
          acc[i.kind] = (acc[i.kind] ?? 0) + 1;
          return acc;
        }, {});
        console.log(`  ⚠️ 사전 검증 ${issues.length}건:`, byKind);
        for (const issue of issues.slice(0, 5)) {
          console.log(`     ${issue.lecture} — ${issue.detail}`);
        }
      }

      expect(request.lectures.length).toBeGreaterThan(0);
      // 상한을 넘기면 서버가 요청 전체를 거절한다. 여기서 먼저 막아야 한다.
      expect(issues.filter((i) => i.kind === 'too_many_slots')).toHaveLength(0);
      expect(issues.filter((i) => i.kind === 'duplicate')).toHaveLength(0);
      // 엑셀에 값이 없는 건 빈 문자열로 보내면 되므로 반영을 막지 않는다(백엔드 확인).
      expect(blocking).toHaveLength(0);
      // 정원이 비면 0으로 채워 보낸다.
      expect(request.lectures.every((l) => l.regular_number !== '')).toBe(true);
    });
  }
});

describe('학기 매핑', () => {
  it('한글 학기명을 enum으로 바꾼다', () => {
    expect(toAdminTerm('1학기')).toBe('FIRST');
    expect(toAdminTerm('여름학기')).toBe('SUMMER');
    expect(toAdminTerm('겨울학기')).toBe('WINTER');
  });

  it('모르는 학기는 조용히 넘기지 않는다', () => {
    expect(() => toAdminTerm('계절학기')).toThrow();
  });
});
