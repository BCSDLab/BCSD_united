import { describe, expect, it } from 'vitest';
import { parseCommand } from '~/services/slack/features/lecture/messages';
import { findExcelFile } from '~/utils/slackFile';

describe('!강의반영 인자', () => {
  it('연도와 학기를 읽는다', () => {
    expect(parseCommand('!강의반영 2026 여름학기')).toEqual({ year: 2026, termName: '여름학기' });
    expect(parseCommand('!강의반영 2026 2학기')).toEqual({ year: 2026, termName: '2학기' });
  });

  it('공백이 들쭉날쭉해도 받아준다', () => {
    expect(parseCommand('  !강의반영   2026    겨울학기  ')).toEqual({
      year: 2026,
      termName: '겨울학기',
    });
  });

  it('빠뜨렸거나 모르는 학기면 안내로 넘긴다', () => {
    // 틀린 채로 진행하면 엉뚱한 학기에 들어가고 되돌릴 API가 없다.
    expect(parseCommand('!강의반영')).toBeNull();
    expect(parseCommand('!강의반영 2026')).toBeNull();
    expect(parseCommand('!강의반영 여름학기')).toBeNull();
    expect(parseCommand('!강의반영 2026 계절학기')).toBeNull();
    expect(parseCommand('!강의반영 26 여름학기')).toBeNull();
    expect(parseCommand('!강의반영 2026 여름학기 지금')).toBeNull();
  });
});

describe('첨부 파일 고르기', () => {
  const file = (name: string, filetype: string) => ({ id: 'F1', name, filetype, size: 100 });

  it('엑셀만 고른다', () => {
    expect(findExcelFile([file('a.png', 'png'), file('편람.xlsx', 'xlsx')])?.name).toBe('편람.xlsx');
  });

  it('확장자만 맞아도 받는다', () => {
    // 슬랙이 filetype을 못 알아보는 경우가 있다.
    expect(findExcelFile([file('편람.xlsx', 'binary')])?.name).toBe('편람.xlsx');
  });

  it('엑셀이 없으면 null', () => {
    expect(findExcelFile([file('a.pdf', 'pdf')])).toBeNull();
    expect(findExcelFile(undefined)).toBeNull();
  });
});

describe('파일 첨부 메시지 처리 범위', () => {
  it('강의와 버스 반영 명령어만 파일을 받겠다고 선언한다', async () => {
    const { messageFunctionList } = await import('~/services/slack/registry/messages');
    const accepting = messageFunctionList.filter((m) => m.acceptsFiles);

    // 파일 첨부 메시지가 기존 명령어(!질문 등)에 흘러들어가면 없던 동작이 생긴다.
    expect(accepting).toHaveLength(2);
    expect(accepting.map((item) => item.regex.toString())).toEqual(
      expect.arrayContaining([expect.stringContaining('강의반영'), expect.stringContaining('버스반영')]),
    );
  });
});

describe('명령어 충돌', () => {
  it('!강의반영이 수정 핸들러에 걸리지 않는다', async () => {
    const { messageFunctionList } = await import('~/services/slack/registry/messages');

    // 스레드에서 !강의반영을 치면 두 핸들러가 모두 반응하던 문제.
    const matching = messageFunctionList.filter((m) =>
      typeof m.regex === 'string'
        ? '!강의반영 2026 여름학기'.includes(m.regex)
        : m.regex.test('!강의반영 2026 여름학기'),
    );

    expect(matching).toHaveLength(1);
  });

  it('스레드 잡담에는 아무 핸들러도 걸리지 않는다', async () => {
    const { messageFunctionList } = await import('~/services/slack/registry/messages');

    // 접두사가 없으면 봇이 끼어들지 않아야 한다.
    const matching = messageFunctionList.filter((m) =>
      typeof m.regex === 'string' ? '이거 맞나요?'.includes(m.regex) : m.regex.test('이거 맞나요?'),
    );

    expect(matching).toHaveLength(0);
  });

  it('!수정은 분배기 하나만 받는다', async () => {
    const { messageFunctionList } = await import('~/services/slack/registry/messages');

    const matching = messageFunctionList.filter((m) =>
      typeof m.regex === 'string'
        ? '!수정 유체역학 03 교수 우창규로'.includes(m.regex)
        : m.regex.test('!수정 유체역학 03 교수 우창규로'),
    );

    // 강의·생협·버스가 같은 접두사를 쓰므로 분배기가 스레드 주인에게만 넘긴다.
    expect(matching).toHaveLength(1);
    expect(matching.every((m) => !m.acceptsFiles)).toBe(true);
  });
});

describe('스레드 식별', () => {
  it('답글은 자기 ts가 아니라 부모를 스레드 식별자로 쓴다', async () => {
    const { threadRootOf } = await import('~/utils/slackThread');

    // 최상단에서 실행하면 자기 자신이 스레드 루트가 된다.
    expect(threadRootOf('1000.0001', undefined)).toBe('1000.0001');
    // 답글의 ts를 쓰면 저장한 키를 아무도 조회하지 못해
    // !수정이 조용히 이전 변환에 적용된다.
    expect(threadRootOf('1000.0009', '1000.0001')).toBe('1000.0001');
  });
});
