import { commands as googleMeetCommands } from '~/services/slack/features/googleMeet';
import { commands as healthCheckCommands } from '~/services/slack/features/healthCheck';
import { commands as lectureNoticeCommands } from '~/services/slack/features/lectureNotice';
import { commands as mentionCommands } from '~/services/slack/features/mention';
import type { CommandSetting } from '~/services/slack/types';

/** 슬래시 명령 등록표. 구현은 각 기능 파일에 둔다. */
export const commands: CommandSetting[] = [
  ...lectureNoticeCommands,
  ...healthCheckCommands,
  ...mentionCommands,
  ...googleMeetCommands,
];
