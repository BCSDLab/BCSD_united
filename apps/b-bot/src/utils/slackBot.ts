import type { WebClient } from '@slack/web-api';

// 봇 자신의 user id. auth.test는 매번 부를 필요가 없어 한 번만 받아둔다.
let cached: string | undefined | null = null;

export async function botUserId(client: WebClient): Promise<string | undefined> {
  if (cached !== null) {
    return cached;
  }
  try {
    cached = ((await client.auth.test()) as { user_id?: string }).user_id;
  } catch {
    cached = undefined;
  }
  return cached;
}
