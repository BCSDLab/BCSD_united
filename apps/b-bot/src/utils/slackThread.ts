/**
 * 스레드를 대표하는 ts.
 *
 * 답글의 `ts`는 그 답글 자신의 것이라 스레드 식별자로 쓸 수 없다.
 * 스레드 안에서 다시 변환했을 때 연결이 엉뚱한 키에 저장돼
 * 수정이 이전 변환에 적용되던 원인이 이것이었다.
 */
export function threadRootOf(ts: string, parentTs?: string): string {
  return parentTs ?? ts;
}

import type { WebClient } from '@slack/web-api';

/** 맥락으로 쓸 만큼만. 길어지면 모델이 옛 요청을 다시 꺼낼 위험이 커진다. */
const MAX_MESSAGES = 6;
const MAX_CHARS = 2000;

/**
 * 슬랙 메시지를 읽을 수 있는 한 줄로 만든다.
 * 블록으로 보낸 메시지는 text에 짧은 대체 문구만 있어서, 실제 내용은 블록에 있다.
 */
function flatten(message: { text?: string; blocks?: unknown[] }): string {
  const fromBlocks = (message.blocks ?? [])
    .map((block) => {
      const b = block as { type?: string; text?: { text?: string } };
      return b.type === 'section' ? (b.text?.text ?? '') : '';
    })
    .filter(Boolean)
    .join('\n');

  return (fromBlocks || message.text || '').trim();
}

/**
 * 스레드의 최근 대화. 되묻고 나서 온 답("시각으로 해줘")을 알아들으려면
 * 봇이 뭘 물었는지도 함께 봐야 한다.
 */
export async function readThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
  excludeTs: string,
): Promise<string> {
  try {
    const replies = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });

    const lines = (replies.messages ?? [])
      .filter((m) => m.ts !== excludeTs)
      .slice(-MAX_MESSAGES)
      .flatMap((m) => {
        const body = flatten(m);
        if (!body) return [];
        const speaker = m.bot_id ? '봇' : '사용자';
        return [`${speaker}: ${body}`];
      })
      .join('\n');

    return lines.slice(-MAX_CHARS);
  } catch {
    // 맥락은 있으면 좋은 것이지 없으면 못 도는 것이 아니다.
    return '';
  }
}
