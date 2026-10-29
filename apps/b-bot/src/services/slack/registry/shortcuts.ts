import { shortcuts as botMessageShortcuts } from '~/services/slack/features/botMessage';
import { shortcuts as mentionShortcuts } from '~/services/slack/features/mention';
import type { ShortcutSetting } from '~/services/slack/types';

/** 메시지·전역 숏컷 등록표. 구현은 각 기능 파일에 둔다. */
export const shortcuts: ShortcutSetting[] = [...botMessageShortcuts, ...mentionShortcuts];
