import { viewActions as botMessageViewActions } from '~/services/slack/features/botMessage';
import { viewActions as lectureNoticeViewActions } from '~/services/slack/features/lectureNotice';
import { viewActions as mentionViewActions } from '~/services/slack/features/mention';
import type { ViewActionSetting } from '~/services/slack/types';

/** 모달 제출(view_submission) 등록표. 구현은 각 기능 파일에 둔다. */
export const viewActions: ViewActionSetting[] = [
  ...botMessageViewActions,
  ...mentionViewActions,
  ...lectureNoticeViewActions,
];
