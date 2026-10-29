import type { WebClient } from '@slack/web-api';
import type { BlockAction, SlackShortcut, ViewSubmitAction } from '@slack/bolt';

interface Message {
  channel: string;
  user: string;
  ts: string;
  text: string;
}

interface ShortcutHandlerParams {
  client: WebClient;
  shortcut: SlackShortcut;
  [key: string]: any;
}

export interface ShortcutSetting {
  key: string;
  execution?: 'queue';
  handler: (args: ShortcutHandlerParams) => Promise<void>;
}

interface ViewActionHandlerParams {
  client: WebClient;
  action: ViewSubmitAction;
  [key: string]: any;
}

export interface ViewActionSetting {
  actionId: string;
  handler: (args: ViewActionHandlerParams) => Promise<void>;
}

interface BlockActionHandlerParams {
  client: WebClient;
  body: BlockAction;
  /** 이번에 눌린 요소 하나. body.actions에 여러 개가 올 수 있어 따로 넘긴다. */
  action: BlockAction['actions'][number];
  [key: string]: any;
}

export interface BlockActionSetting {
  actionId: string;
  handler: (args: BlockActionHandlerParams) => Promise<void>;
}

export interface Command {
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  api_app_id: string;
}
interface CommandHandlerParams {
  client: WebClient;
  command: Command;
  [key: string]: any;
}
export interface CommandSetting {
  command: string;
  execution?: 'queue';
  handler: (args: CommandHandlerParams) => Promise<void>;
}

export interface MessageHandlerParams extends Message {
  client: WebClient;
  [key: string]: any;
}

/** `!수정` 처리기가 받는 값. 스레드 주인을 가린 뒤라 부모 스레드가 항상 있다. */
export type EditCommandParams = MessageHandlerParams & { parentTs: string };

export interface MessageSetting {
  regex: string | RegExp;
  /**
   * 파일이 첨부된 메시지도 받을지. 기본은 받지 않는다.
   * 파일 첨부 메시지를 모든 핸들러에 흘리면 스크린샷과 함께 쓴 `!질문` 같은 게
   * 갑자기 반응하기 시작한다. 파일이 필요한 명령어만 켠다.
   */
  acceptsFiles?: boolean;
  handler: (args: MessageHandlerParams) => Promise<void>;
}

export interface MentionMetadata {
  channel: string;
  thread_ts: string;
  user_id: string;
}
export interface GroupMentionMetadata {
  channel_id: string;
  thread_ts: string;
  user_id: string;
}
