import { findBusTokenByThread } from '~/services/bus/reviewStore';
import { findCoopTokenByThread } from '~/services/coop/reviewStore';
import { findTokenByThread } from '~/services/lecture/reviewStore';
import { postEditHelp } from '~/services/slack/features/editHelp';
import { handleBusEdit } from '~/services/slack/features/bus/messages';
import { handleCoopEdit } from '~/services/slack/features/coop/messages';
import { handleLectureEdit } from '~/services/slack/features/lecture/messages';
import type { EditCommandParams, MessageSetting } from '~/services/slack/types';

/**
 * `!수정` 분배기. 강의·생협·버스가 같은 명령을 쓰므로 스레드 주인 하나에게만 넘긴다.
 *
 * 예전에는 세 핸들러가 모두 반응하고 각자 "내 스레드가 아니면 빠진다"를 판단해서,
 * 강의 핸들러가 버스·생협 저장소를 알아야 했고 등록 순서에도 기댔다.
 */
const OWNERS: Array<{
  findToken(channel: string, threadTs: string): Promise<string | null>;
  edit(args: EditCommandParams, token: string): Promise<void>;
}> = [
  { findToken: findTokenByThread, edit: handleLectureEdit },
  { findToken: findCoopTokenByThread, edit: handleCoopEdit },
  { findToken: findBusTokenByThread, edit: handleBusEdit },
];

export const messages: MessageSetting[] = [
  {
    regex: /^!수정/,
    async handler(args) {
      const { channel, parentTs } = args;
      if (parentTs) {
        for (const owner of OWNERS) {
          const token = await owner.findToken(channel, parentTs);
          if (token) {
            await owner.edit({ ...args, parentTs }, token);
            return;
          }
        }
      }
      await postEditHelp(args, { inThread: Boolean(parentTs) });
    },
  },
];
