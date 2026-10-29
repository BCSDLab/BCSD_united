import { messages as busMessages } from '~/services/slack/features/bus/messages';
import { messages as coopMessages } from '~/services/slack/features/coop/messages';
import { messages as editMessages } from '~/services/slack/features/editCommand';
import { messages as funMessages } from '~/services/slack/features/fun';
import { messages as googleMeetMessages } from '~/services/slack/features/googleMeet';
import { messages as lectureMessages } from '~/services/slack/features/lecture/messages';
import { messages as ragMessages } from '~/services/slack/features/rag';
import { messages as supersetMessages } from '~/services/slack/features/superset';
import type { MessageSetting } from '~/services/slack/types';

/**
 * 메시지 핸들러 등록표. **여기에는 구현을 두지 않는다.**
 *
 * 맞는 핸들러는 전부 이 순서대로 돈다. 같은 명령을 여러 도메인이 쓰면(`!수정`) 분배기
 * 하나만 등록하고 스레드 주인에게 넘긴다. 순서는 `test/slack/registry.test.ts`가 고정한다.
 */
export const messageFunctionList: MessageSetting[] = [
  ...ragMessages,
  ...funMessages,
  ...googleMeetMessages,
  ...lectureMessages,
  ...coopMessages,
  ...busMessages,
  ...editMessages,
  ...supersetMessages,
];
