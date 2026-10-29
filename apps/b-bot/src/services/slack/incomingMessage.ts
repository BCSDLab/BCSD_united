import type { GenericMessageEvent, MessageChangedEvent, SlackEvent } from '@slack/web-api';
import type { SlackFile } from '~/utils/slackFile';
import type { MessageSetting } from '~/services/slack/types';

export type MessageEvent = Extract<SlackEvent, { type: 'message' }>;

export interface IncomingMessage {
  text: string;
  ts: string;
  user: string;
  channel: string;
  files?: SlackFile[];
  // 스레드 답장인지 알아야 어느 변환 건에 대한 수정인지 찾을 수 있다.
  // ts는 답장 자신의 ts라 부모를 따로 들고 간다.
  parentTs?: string;
}

/** 사람이 쓴 메시지만 꺼낸다. 봇 메시지와 처리하지 않는 subtype은 null. */
export function readUserMessage(event: MessageEvent): IncomingMessage | null {
  // file_share: 엑셀을 올리면서 명령어를 적는 흐름(!강의반영)을 위해 받는다.
  // 일반 메시지와 달리 subtype이 붙어 있어 따로 허용해야 들어온다.
  if (event.subtype === undefined || event.subtype === 'file_share') {
    const message = event as GenericMessageEvent & { files?: SlackFile[] };
    if (message.bot_id) {
      return null;
    }
    return {
      text: message.text ?? '',
      channel: message.channel,
      user: message.user ?? '',
      ts: message.ts ?? message.thread_ts ?? '',
      parentTs: message.thread_ts,
      files: event.subtype === 'file_share' ? message.files : undefined,
    };
  }

  if (event.subtype === 'message_changed') {
    const changed = (event as MessageChangedEvent).message;
    if (changed.subtype !== undefined) {
      return null;
    }
    const message = changed as GenericMessageEvent;
    return {
      text: message.text ?? '',
      channel: message.channel ?? '',
      user: message.user ?? '',
      ts: message.ts ?? '',
    };
  }

  return null;
}

export function matchesText({ regex }: MessageSetting, text: string): boolean {
  return typeof regex === 'string' ? text.includes(regex) : regex.test(text);
}
