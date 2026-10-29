import type { WebClient } from '@slack/web-api';

/** 변환 스레드가 아니거나 기록이 없을 때. 조용히 무시하면 왜 반응이 없는지 알 수 없다. */
export async function postEditHelp(
  { client, channel, ts }: { client: WebClient; channel: string; ts: string },
  { inThread }: { inThread: boolean },
): Promise<void> {
  await client.chat.postMessage({
    channel,
    thread_ts: ts,
    text: '변환 결과 스레드에서 사용해주세요.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            ':thread: *`!수정`은 변환 결과 스레드 안에서 써주세요.*',
            inThread
              ? '이 스레드의 검토 링크가 만료됐거나 변환 기록을 찾지 못했습니다.'
              : '`!강의반영`으로 만든 결과 메시지에 답글로 달아주세요.',
          ].join('\n'),
        },
      },
    ],
  });
}
