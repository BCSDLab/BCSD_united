import { createMeeting, removeMeeting, saveMeeting } from '~/services/google/googleMeet';
import { CommandSetting, MessageSetting } from '~/services/slack/types';
import { sendSlackText, updateSlack } from '~/utils/slackFunction';

export const messages: MessageSetting[] = [
  {
    regex: /(!회의생성|회의생성!|!회의 생성|회의 생성!|생성!)/,
    async handler({ client, ts, channel }) {
      const meetingInfo = await createMeeting();
      const result = await sendSlackText({
        client,
        threadTs: ts,
        channel,
        text: `회의를 생성하였습니다. ${meetingInfo.meetingUri} 확인해주세요!`,
        unfurlLinks: true,
      });
      await saveMeeting({
        meeting: meetingInfo.meetingCode,
        ts: ts || result.ts,
      });
    },
  },
  {
    regex: /(!회의종료|회의종료!|!회의 종료|회의 종료!|종료!)/,
    async handler({ client, channel, text }) {
      const meetingInfo = await removeMeeting({
        text,
      });
      await updateSlack({
        client,
        ts: meetingInfo.ts,
        channel: channel,
        text: '회의가 종료되었습니다. 다음에 만나요!',
      });
    },
  },
];

export const commands: CommandSetting[] = [
  {
    command: '/회의생성',
    execution: 'queue',
    async handler({ client, command }) {
      const meetingInfo = await createMeeting();
      const result = await sendSlackText({
        client,
        channel: command.channel_id,
        text: `회의를 생성하였습니다. ${meetingInfo.meetingUri} 확인해주세요!`,
      });
      await saveMeeting({
        meeting: meetingInfo.meetingCode,
        ts: result.ts,
      });
    },
  },
  {
    command: '/회의종료',
    execution: 'queue',
    async handler({ client, command }) {
      const meetingInfo = await removeMeeting({
        text: command.text,
      });

      await updateSlack({
        client,
        ts: meetingInfo.ts,
        channel: command.channel_id,
        text: '회의가 종료되었습니다. 다음에 만나요!',
      });
    },
  },
];
