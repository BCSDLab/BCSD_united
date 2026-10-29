import { describe, expect, it } from 'vitest';
import { messages as busMessages, parseBusCommand } from '~/services/slack/features/bus/messages';
import { findSpreadsheetFile } from '~/utils/slackFile';

const file = (name: string, filetype = 'binary') => ({
  id: 'F1',
  name,
  filetype,
  size: 100,
});

describe('!버스반영 첨부 파일', () => {
  it('지원하는 시간표 파일만 고른다', () => {
    expect(findSpreadsheetFile([file('a.png'), file('시간표.xls')])?.name).toBe('시간표.xls');
    expect(findSpreadsheetFile([file('시간표.xlsx')])?.name).toBe('시간표.xlsx');
    // csv는 결정론적 파서가 시트 구조를 요구해 받지 않는다.
    expect(findSpreadsheetFile([file('시간표.csv')])).toBeNull();
    expect(findSpreadsheetFile([file('시간표.pdf')])).toBeNull();
  });

  it('버스 반영 명령어는 완전 일치만 받는다', () => {
    expect(parseBusCommand('!버스반영')).toBe(true);
    expect(parseBusCommand('  !버스반영  ')).toBe(true);
    expect(parseBusCommand('!버스반영 2026')).toBe(false);
    expect(parseBusCommand('버스반영')).toBe(false);
  });

  it('버스 명령어만 버스 첨부를 받는다', () => {
    const accepting = busMessages.filter((message) => message.acceptsFiles);

    expect(accepting).toHaveLength(1);
    expect(accepting[0].regex.toString()).toContain('버스반영');
  });

  it('파일 첨부 메시지를 받겠다고 선언한 명령어는 강의·버스반영뿐이다', async () => {
    const { messageFunctionList } = await import('~/services/slack/registry/messages');
    const accepting = messageFunctionList.filter((message) => message.acceptsFiles);

    // 파일 첨부 메시지가 선언하지 않은 명령어(!질문 등)에 흘러들어가면 없던 동작이 생긴다.
    expect(accepting).toHaveLength(2);
    expect(accepting.map((m) => m.regex.toString()).join()).toContain('강의반영');
    expect(accepting.map((m) => m.regex.toString()).join()).toContain('버스반영');
  });
});
