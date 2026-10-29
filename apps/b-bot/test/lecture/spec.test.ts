import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPreview, generateMappingSpec } from '~/services/lecture/spec';
import { readSheet } from '../support/readSheet';
import { FIXTURE_SPECS } from '../fixtures/lecture/specs';

const NAMES = Object.keys(FIXTURE_SPECS);

const sheet = (name: string) =>
  readSheet(fileURLToPath(new URL(`../fixtures/lecture/xlsx/${name}.xlsx`, import.meta.url)));

describe('미리보기 생성', () => {
  it('헤더 이름과 표본 값을 담는다', async () => {
    const preview = buildPreview(await sheet('regular-2026-1'));

    expect(preview).toContain('r2:');
    expect(preview).toContain('과목코드');
    expect(preview).toContain('강의시간');
    // 값 형태를 볼 표본도 있어야 한다.
    expect(preview).toMatch(/[A-Z]{3}\d{3}/);
  });

  it('셀 안 줄바꿈이 행 구조를 깨뜨리지 않는다', async () => {
    // 헤더에 `학\n점`처럼 개행이 들어 있는 파일이 있다.
    const preview = buildPreview(await sheet('seasonal-2025-summer'));

    for (const line of preview.split('\n')) {
      expect(line === '...' || line.startsWith('r')).toBe(true);
    }
  });

  it('행 수가 많아도 프롬프트 길이가 일정하다', async () => {
    const big = buildPreview(await sheet('regular-2026-1'));
    const small = buildPreview(await sheet('seasonal-2026-summer'));

    // 905행짜리와 23행짜리가 같은 줄 수여야 한다.
    expect(big.split('\n').length).toBeLessThanOrEqual(16);
    expect(small.split('\n').length).toBeLessThanOrEqual(16);
  });
});

/**
 * 실제 API 호출은 RUN_AI_LIVE_TESTS=1과 Cloudflare REST 자격 증명을 모두 설정한 경우에만 실행한다.
 * 손으로 쓴 스펙이 정답지 역할을 한다 — LLM이 같은 결론에 도달하는지 본다.
 */
const liveAiEnabled =
  process.env.RUN_AI_LIVE_TESTS === '1' &&
  Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

describe.skipIf(!liveAiEnabled)('매핑 스펙 생성', () => {
  for (const name of NAMES) {
    it(name, async () => {
      const rows = await sheet(name);
      const generated = await generateMappingSpec(rows);
      const expected = FIXTURE_SPECS[name];

      console.log(`\n[${name}]`);
      console.log(`  헤더행 ${generated.headerRow} (기대 ${expected.headerRow}) · ${generated.timeFormat}`);

      const keys = new Set([...Object.keys(expected.columns), ...Object.keys(generated.columns)]);
      const mismatches: string[] = [];
      for (const key of keys) {
        const want = (expected.columns as Record<string, number>)[key];
        const got = (generated.columns as Record<string, number>)[key];
        const mark = want === got ? '  ' : '✗ ';
        console.log(`  ${mark}${key.padEnd(14)} ${got ?? '-'} (기대 ${want ?? '-'})`);
        if (want !== got) mismatches.push(`${key}: ${got ?? '없음'} ≠ ${want ?? '없음'}`);
      }

      expect(generated.headerRow).toBe(expected.headerRow);
      expect(generated.timeFormat).toBe(expected.timeFormat);
      // 강의 식별과 시간표에 직접 쓰이는 컬럼은 어긋나면 안 된다.
      for (const key of ['code', 'name', 'lectureClass', 'classTime'] as const) {
        expect(generated.columns[key], `${key} 불일치`).toBe(expected.columns[key]);
      }
      expect(mismatches, mismatches.join(' / ')).toHaveLength(0);
    });
  }
});
