import { describe, expect, it } from 'vitest';
import { matchesText, readUserMessage, type MessageEvent } from '~/services/slack/incomingMessage';

const asEvent = (event: Record<string, unknown>) =>
  ({ type: 'message', channel: 'C1', channel_type: 'channel', ...event }) as unknown as MessageEvent;

const file = { id: 'F1', name: '시간표.xlsx' };

describe('Slack 메시지 이벤트 해석', () => {
  it('일반 메시지는 본문·작성자·스레드 정보를 꺼낸다', () => {
    expect(readUserMessage(asEvent({ text: '!주사위', user: 'U1', ts: '2.0', thread_ts: '1.0' }))).toEqual({
      text: '!주사위',
      channel: 'C1',
      user: 'U1',
      ts: '2.0',
      parentTs: '1.0',
      files: undefined,
    });
  });

  it('봇이 쓴 메시지는 무시한다', () => {
    expect(readUserMessage(asEvent({ text: '안녕', bot_id: 'B1', ts: '1.0' }))).toBeNull();
    expect(readUserMessage(asEvent({ subtype: 'file_share', text: '안녕', bot_id: 'B1', ts: '1.0' }))).toBeNull();
  });

  it('file_share는 첨부 파일까지 넘긴다', () => {
    const message = readUserMessage(
      asEvent({ subtype: 'file_share', text: '!강의반영', user: 'U1', ts: '1.0', files: [file] }),
    );
    expect(message?.files).toEqual([file]);
  });

  it('subtype이 없는 메시지에 붙은 files는 넘기지 않는다', () => {
    const message = readUserMessage(asEvent({ text: '!질문 이거', user: 'U1', ts: '1.0', files: [file] }));
    expect(message?.files).toBeUndefined();
  });

  it('수정된 메시지는 바뀐 본문을 쓰고 부모 스레드는 넘기지 않는다', () => {
    const message = readUserMessage(
      asEvent({
        subtype: 'message_changed',
        message: { type: 'message', text: '!점메추', user: 'U1', ts: '3.0', channel: 'C1', thread_ts: '1.0' },
      }),
    );
    expect(message).toEqual({ text: '!점메추', channel: 'C1', user: 'U1', ts: '3.0' });
  });

  it('수정된 메시지에 subtype이 있으면 무시한다', () => {
    const message = readUserMessage(
      asEvent({
        subtype: 'message_changed',
        message: { type: 'message', subtype: 'bot_message', text: 'x', ts: '3.0' },
      }),
    );
    expect(message).toBeNull();
  });

  it('처리하지 않는 subtype은 무시한다', () => {
    expect(readUserMessage(asEvent({ subtype: 'channel_join', text: 'joined', user: 'U1', ts: '1.0' }))).toBeNull();
  });
});

describe('메시지 핸들러 매칭', () => {
  const handler = async () => {};

  it('문자열이면 포함 여부, 정규식이면 test로 본다', () => {
    expect(matchesText({ regex: '축하', handler }, '생일 축하해')).toBe(true);
    expect(matchesText({ regex: /^!주사위/, handler }, '!주사위')).toBe(true);
    expect(matchesText({ regex: /^!주사위/, handler }, '주사위!')).toBe(false);
  });
});
