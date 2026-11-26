import { waitUntil } from 'cloudflare:workers';

import { getMessages } from 'api/language';
import type { MessagesResponse } from 'api/language/entity';

// 사전은 배포 사이에 거의 바뀌지 않으므로 Worker 인스턴스 안에서 잠시 재사용한다
const CACHE_TTL_MS = 10 * 60 * 1000;
// 사전 API가 실패하거나 늦으면 이 시간 동안은 다시 요청하지 않고 바로 한국어 문구로 그린다
const FAILURE_BACKOFF_MS = 60 * 1000;
// 사전이 없어도 한국어 문구로 그릴 수 있으므로 서버 렌더 응답을 이보다 오래 붙잡지 않는다
const MAX_WAIT_MS = 1000;

// 요청 사이에는 받은 데이터만 공유한다. Workers는 다른 요청이 시작한 I/O(Promise)를 이어받지 못한다.
const cache = new Map<string, { messages: MessagesResponse; expiresAt: number }>();
const failedAt = new Map<string, number>();

async function fetchWithTimeout(language: string): Promise<MessagesResponse | null> {
  const request = getMessages(language).then(
    (messages) => {
      cache.set(language, { messages, expiresAt: Date.now() + CACHE_TTL_MS });
      failedAt.delete(language);

      return messages;
    },
    () => {
      failedAt.set(language, Date.now());

      return null;
    },
  );
  // Worker는 응답을 보낸 뒤 남은 요청을 끊으므로, `MAX_WAIT_MS`를 넘겨 도착한 사전도 캐시에 저장되게 붙잡아 둔다
  waitUntil(request);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      failedAt.set(language, Date.now());
      resolve(null);
    }, MAX_WAIT_MS);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 서버 렌더에 쓸 표시 문구 사전. 유효한 캐시가 있으면 바로 돌려준다.
 * 없으면 `MAX_WAIT_MS`까지만 기다린다. 받지 못하면 만료된 캐시를, 그것도 없으면 `null`을 돌려준다.
 * `null`이면 화면은 한국어 문구로 그려지고 브라우저가 사전을 다시 받는다.
 */
export async function getServerMessages(language: string): Promise<MessagesResponse | null> {
  const now = Date.now();
  const cached = cache.get(language);
  if (cached && cached.expiresAt > now) return cached.messages;
  if (now - (failedAt.get(language) ?? 0) < FAILURE_BACKOFF_MS) return cached?.messages ?? null;

  return (await fetchWithTimeout(language)) ?? cached?.messages ?? null;
}
