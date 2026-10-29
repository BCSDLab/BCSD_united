import { describe, expect, it } from 'vitest';
import { findSpreadsheetFile, findSpreadsheetFiles } from '~/utils/slackFile';

const file = (name: string, filetype: string) => ({
  id: 'F1',
  name,
  filetype,
  size: 100,
});

describe('스프레드시트 첨부 파일', () => {
  it('지원 형식만 고른다', () => {
    expect(findSpreadsheetFile([file('시간표.xls', 'binary')])?.name).toBe('시간표.xls');
    expect(findSpreadsheetFile([file('시간표.xlsx', 'xlsx')])?.name).toBe('시간표.xlsx');
    // csv는 결정론적 파서가 시트 구조를 요구해 받지 않는다.
    expect(findSpreadsheetFile([file('시간표.csv', 'csv')])).toBeNull();
    expect(findSpreadsheetFile([file('시간표.pdf', 'pdf')])).toBeNull();
    expect(findSpreadsheetFile([file('사진.png', 'png')])).toBeNull();
  });

  it('여러 개를 올리면 전부 돌려준다 — 하나만 조용히 고르지 않는다', () => {
    const files = [file('천안.xlsx', 'xlsx'), file('사진.png', 'png'), file('청주.xls', 'binary')];
    expect(findSpreadsheetFiles(files).map((f) => f.name)).toEqual(['천안.xlsx', '청주.xls']);
    // 첫 번째만 골라도 되는 기존 호출자를 위한 계약은 그대로 유지한다.
    expect(findSpreadsheetFile(files)?.name).toBe('천안.xlsx');
  });
});
