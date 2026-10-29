// fetch().json()을 unknown으로 받게 하는 전역 타입. 원래 이 모달 코드에 붙어 있던 것을 그대로 둔다.
import '@total-typescript/ts-reset/fetch';
import type { View } from '@slack/web-api';
import INTERACTION_MODAL from '@/constant/INTERACTION_MODAL.json';
import { getMentionTargetMembers, type ActiveStatus, type MentionGroup, type Track } from '~/services/member/members';
import type { CommandSetting, GroupMentionMetadata, ShortcutSetting, ViewActionSetting } from '~/services/slack/types';
import { sendSlackText } from '~/utils/slackFunction';

const MEMBER_TYPE_LABEL: Record<string, string> = {
  all: '',
  TRACK_LEAD: '트랙장',
};

/** 그룹 멘션(`/멘션`·메시지 숏컷·모달). 명단은 인터널 멤버 API에서 읽는다. */
export const commands: CommandSetting[] = [
  {
    command: '/멘션',
    async handler({ client, command }) {
      const {
        channel_id: channel,
        // 없음
        // message_ts,
        user_id: user,
      } = command;
      const rootTs = undefined;
      await client.views.open({
        trigger_id: command.trigger_id,
        view: {
          ...(INTERACTION_MODAL.그룹멘션.view as View),
          private_metadata: JSON.stringify({
            channel_id: channel,
            thread_ts: rootTs,
            user_id: user,
          } satisfies GroupMentionMetadata),
        },
      });
    },
  },
];

export const shortcuts: ShortcutSetting[] = [
  {
    key: 'thread_check_mention',
    execution: 'queue',
    async handler({ client, shortcut }) {
      if (shortcut.type !== 'message_action') return;
      const { channel, message, user } = shortcut;
      const { ts, thread_ts } = message;
      const triggeringUserId = user.id;
      const rootTs = thread_ts || ts;
      // 스레드 전체의 대화 목록을 가져옴
      const result = await client.conversations.replies({
        channel: channel.id,
        ts: rootTs, // 전체 스레드 탐색
      });
      const mentionedMembers = new Set<string>();
      const reactedUsers = new Set<string>();
      const commentingUsers = new Set<string>();

      if (result.messages) {
        for (const msg of result.messages) {
          // 멘션된 멤버 수집
          const mentions = msg.text?.match(/<@([A-Z0-9]+)>/g);
          if (mentions) {
            mentions.forEach((mention: string) => {
              const userId = mention.replace(/[<@>]/g, ''); // <@USER_ID> 형태에서 USER_ID 추출
              mentionedMembers.add(userId);
            });
          }

          // 댓글을 작성한 사용자 수집
          if (msg.user) {
            commentingUsers.add(msg.user);
          }

          // 이모지를 단 사람 수집
          if (msg.reactions) {
            for (const reaction of msg.reactions) {
              reaction.users.forEach((user: string) => {
                reactedUsers.add(user);
              });
            }
          }
        }
      }

      // 이모지 또는 댓글을 달지 않은 멤버 필터링
      const nonReactedMembers = Array.from(mentionedMembers).filter(
        (member) => !reactedUsers.has(member) && !commentingUsers.has(member) && member !== triggeringUserId,
      );

      // 이모지를 달지 않은 멤버들을 다시 멘션
      if (nonReactedMembers.length > 0) {
        const mentionText = nonReactedMembers.map((user) => `<@${user}>`).join(', ');

        await sendSlackText({
          client,
          channel: channel.id,
          text: `<@${user.name}>님의 리마인드!
메시지 확인 하셨나요? :meow_sad-rain: 
${mentionText}
메시지 확인 후 댓글이나 이모지를 남겨주세요 :dancing_toad:`,
          threadTs: rootTs,
        });
      } else {
        await sendSlackText({
          client,
          channel: channel.id,
          text: `<@${user.name}>님의 리마인드!
모든 멤버가 메시지를 확인했습니다. :blob_excited:`,
          threadTs: rootTs,
        });
      }
    },
  },
  {
    key: 'group_mention',
    async handler({ client, shortcut }) {
      if (shortcut.type !== 'message_action') return;
      const { channel, message, user } = shortcut;
      const { ts } = message;
      const rootTs = ts;
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: {
          ...(INTERACTION_MODAL.그룹멘션.view as View),
          private_metadata: JSON.stringify({
            channel_id: channel.id,
            thread_ts: rootTs,
            user_id: user.id,
          } satisfies GroupMentionMetadata),
        },
      });
    },
  },
];

export const viewActions: ViewActionSetting[] = [
  {
    actionId: INTERACTION_MODAL.그룹멘션.callback_id,
    async handler({ client, action: { view } }) {
      const track = view['state']['values']['track']['track_select']['selected_option']?.value as Track;
      const memberType = view['state']['values']['member_type']['member_type_select']['selected_option']
        ?.value as MentionGroup;
      const isActive = view['state']['values']['is_active']['is_active_select']['selected_option']
        ?.value as ActiveStatus;

      const {
        channel_id: channel,
        thread_ts: threadTs,
        user_id,
      } = JSON.parse(view['private_metadata']) as GroupMentionMetadata;

      let selectedMember: string[];
      try {
        selectedMember = await getMentionTargetMembers({
          track,
          memberType,
          isActive,
        });
      } catch (error) {
        // 명단을 못 읽은 것을 "해당 인원 없음"으로 보이면 안 된다.
        console.error((error as Error).message);
        await sendSlackText({
          client,
          channel: channel,
          text: '멤버 명단을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
          threadTs,
        });
        return;
      }

      if (selectedMember.length > 0) {
        const trackText = `${track === 'all' ? '' : `${track}트랙`} `;
        const memberTypeText = `${MEMBER_TYPE_LABEL[memberType] ?? memberType.toLowerCase()} `;
        await sendSlackText({
          client,
          channel: channel,
          text: `<@${user_id}>님의 ${trackText}${memberTypeText}단체멘션!\n${selectedMember.join(', ')}\n확인 부탁드립니다 :dancing_toad:`,
          threadTs,
        });
      } else {
        await sendSlackText({
          client,
          channel: channel,
          text: '해당하는 인원이 없습니다.',
          threadTs,
        });
      }
    },
  },
];
