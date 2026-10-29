import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAdminRequest, toAdminTerm } from '~/services/lecture/adminApi';
import { convertRows } from '~/services/lecture/convert';
import { describeClassTime } from '~/services/lecture/describeTime';
import { renderReviewPage } from '~/services/lecture/reviewHtml';
import { readSheet } from '../support/readSheet';
import { FIXTURE_SPECS } from '../fixtures/lecture/specs';

const OUT_DIR = fileURLToPath(new URL('../../.data/review', import.meta.url));

describe('강의시간 사람이 읽는 형태', () => {
  it('정규는 요일과 교시를 함께 보여준다', () => {
    // 월 07A~09B
    expect(describeClassTime([{ day: 0, start_time: 12, end_time: 17 }])).toBe('월 15:00~18:00 (7A~9B)');
  });

  it('계절학기 5일 전개를 한 줄로 줄인다', () => {
    // 월~금 09:00~12:00 — 그대로 두면 5줄이 된다
    const infos = [0, 1, 2, 3, 4].map((day) => ({
      day,
      start_time: day * 100,
      end_time: day * 100 + 5,
    }));
    expect(describeClassTime(infos)).toBe('월~금 09:00~12:00 (1A~3B)');
  });

  it('하루 두 시간대는 둘 다 보여준다', () => {
    const infos = [
      { day: 0, start_time: 0, end_time: 5 },
      { day: 0, start_time: 10, end_time: 13 },
    ];
    expect(describeClassTime(infos)).toBe('월 09:00~12:00 (1A~3B) / 월 14:00~16:00 (6A~7B)');
  });

  it('시간 없는 강의를 빈칸으로 두지 않는다', () => {
    expect(describeClassTime([])).toBe('시간 없음');
  });
});

describe('검토 페이지', () => {
  const CASES = [
    { name: 'seasonal-2026-summer', year: 2026, term: '여름학기' },
    { name: 'regular-2026-2', year: 2026, term: '2학기' },
  ];

  for (const { name, year, term } of CASES) {
    it(name, async () => {
      const rows = await readSheet(fileURLToPath(new URL(`../fixtures/lecture/xlsx/${name}.xlsx`, import.meta.url)));
      const result = convertRows(rows, FIXTURE_SPECS[name]);
      const { issues } = buildAdminRequest(result.lectures, { year, term: toAdminTerm(term) });

      const html = renderReviewPage({
        envLabel: '스테이지',
        isProduction: false,
        year,
        termName: term,
        sourceFileName: `${name}.xlsx`,
        generatedAt: '2026-08-07 00:00',
        lectures: result.lectures,
        issues,
        parseFailures: result.issues.map((i) => ({
          row: i.row,
          value: i.value,
          message: i.message,
        })),
      });

      // 외부 요청이 있으면 사내망·오프라인에서 깨진다.
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).toContain(`${year} ${term} 강의 검토`);
      // 원본과 해석을 나란히 두는 게 이 페이지의 핵심이다.
      expect(html).toContain('원본 강의시간');
      expect(html).toContain('해석된 시간');
      // 링크를 나중에 열었을 때 어느 코인 것인지 알 수 있어야 한다.
      expect(html).toContain('스테이지');

      await mkdir(OUT_DIR, { recursive: true });
      const path = `${OUT_DIR}/${name}.html`;
      await writeFile(path, html, 'utf-8');
      console.log(
        `  ${name}: ${result.lectures.length}건 · 확인필요 ${issues.length} · ${Math.round(html.length / 1024)}KB`,
      );
      console.log(`    → ${path}`);
    });
  }
});
