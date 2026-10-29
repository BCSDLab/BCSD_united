import type { KnownBlock } from '@slack/web-api';

/** 섹션 블록 한 장. 안내 문구가 대부분이라 매번 적지 않는다. */
export const notice = (mrkdwn: string): KnownBlock[] => [{ type: 'section', text: { type: 'mrkdwn', text: mrkdwn } }];

/** 버튼이 너무 많으면 읽히지 않는다. 넘치면 파일을 직접 올리는 편이 낫다. */
export const MAX_CHOICES = 4;

/** 버튼 글자가 길면 잘려서 무엇인지 알 수 없다. */
export function shorten(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

/**
 * 버튼이 달린 원본 메시지를 갈아끼운다.
 *
 * `chat.update`를 쓰지 않는 건 배치가 **웹훅으로** 올린 메시지이기 때문이다.
 * 작성자가 봇 토큰이 아니라 `cant_update_message`로 거절당한다.
 * 버튼 클릭에 딸려 오는 response_url은 그 제약이 없다.
 */
export async function replaceOriginal(responseUrl: string | undefined, text: string, blocks: KnownBlock[]) {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text, blocks }),
  });
}
