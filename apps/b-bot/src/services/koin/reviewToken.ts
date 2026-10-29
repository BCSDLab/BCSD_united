import { randomBytes } from 'node:crypto';

/**
 * 검토 페이지는 로그인 없이 링크만으로 열린다. 슬랙에서 바로 눌러야 하기 때문이다.
 * 대신 토큰을 추측할 수 없게 만들고 기한을 둔다.
 *
 * **이건 인증이 아니다.** 링크를 아는 사람은 누구나 볼 수 있다.
 * 담기는 값이 학교가 공개한 자료라 이 수준으로 두지만,
 * 개인정보가 들어가게 되면 인증을 붙여야 한다.
 *
 * 강의·버스·생협이 같은 규칙을 쓴다. 토큰 길이나 기한이 도메인마다 달라질 이유가
 * 없고, 달라지면 그 도메인만 링크 수명이 어긋난다.
 */
const TOKEN_BYTES = 16;
const EXPIRE_DAYS = 7;

export function createReviewToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** 경로 조작이나 오타로 엉뚱한 키를 읽지 않도록 형식을 먼저 본다. */
export function isValidToken(token: string): boolean {
  return new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(token);
}

export function isExpired(createdAt: string, now: Date): boolean {
  const age = now.getTime() - new Date(createdAt).getTime();
  return !Number.isFinite(age) || age > EXPIRE_DAYS * 24 * 60 * 60 * 1000;
}

/** `review` · `bus-review` · `coop-review` 처럼 라우트 경로를 받는다. */
export function buildReviewUrl(routePath: string, token: string): string {
  const base = process.env.APP_BASE_URL ?? '';
  // 슬랙 버튼의 url은 절대 주소여야 한다. 비어 있으면 변환을 다 마친 뒤
  // 메시지를 올리는 단계에서 invalid_blocks로 실패해 원인이 보이지 않는다.
  if (!/^https?:\/\//.test(base)) {
    throw new Error('APP_BASE_URL이 절대 주소로 설정되어 있지 않습니다.');
  }
  return `${base.endsWith('/') ? base : `${base}/`}${routePath}/${token}`;
}

/**
 * 검토 결과를 KV에 넣고 빼는 일. 도메인마다 담는 값이 달라 제네릭으로 받는다.
 *
 * 만료 판정을 읽는 쪽에 두는 게 핵심이다. KV에 TTL이 없어서, 지우는 걸 잊으면
 * 만료된 링크가 계속 열린다.
 */
export function createReviewStore<T extends { meta: { createdAt: string } }>(prefix: string) {
  const key = (token: string) => `${prefix}-review:${token}`;
  /** 스레드에 답장한 수정 요청이 어느 변환 건인지 찾으려면 필요하다. */
  const threadKey = (channel: string, threadTs: string) => `${prefix}-thread:${channel}:${threadTs}`;

  return {
    async save(review: T): Promise<string> {
      const token = createReviewToken();
      await useStorage('kvStorage').setItem(key(token), review);
      return token;
    },

    /** 수정을 적용한 뒤 같은 토큰에 덮어쓴다. 링크가 바뀌지 않아 새로고침만 하면 된다. */
    async update(token: string, review: T): Promise<void> {
      await useStorage('kvStorage').setItem(key(token), review);
    },

    async load(token: string): Promise<T | null> {
      if (!isValidToken(token)) {
        return null;
      }
      const stored = await useStorage('kvStorage').getItem<T>(key(token));
      if (!stored) {
        return null;
      }
      if (isExpired(stored.meta.createdAt, new Date())) {
        await useStorage('kvStorage').removeItem(key(token));
        return null;
      }
      return stored;
    },

    async linkThread(channel: string, threadTs: string, token: string): Promise<void> {
      await useStorage('kvStorage').setItem(threadKey(channel, threadTs), { token });
    },

    async findTokenByThread(channel: string, threadTs: string): Promise<string | null> {
      const stored = await useStorage('kvStorage').getItem<{ token: string }>(threadKey(channel, threadTs));
      return stored?.token ?? null;
    },
  };
}

/**
 * 적용 버튼을 누를 때까지 들고 있을 수정 계획. 버튼 value에 담기엔 크다.
 *
 * 적용됐거나 취소된 계획은 남겨두지 않는다. 두 번 눌러 두 번 적용되면 안 된다.
 */
export function createPlanStore<T extends { createdAt: string }>(prefix: string) {
  const key = (token: string) => `${prefix}-patch:${token}`;

  return {
    async save(plan: Omit<T, 'createdAt'>): Promise<string> {
      const token = createReviewToken();
      await useStorage('kvStorage').setItem(key(token), {
        ...plan,
        createdAt: new Date().toISOString(),
      });
      return token;
    },

    async load(token: string): Promise<T | null> {
      if (!isValidToken(token)) {
        return null;
      }
      const stored = await useStorage('kvStorage').getItem<T>(key(token));
      if (!stored || isExpired(stored.createdAt, new Date())) {
        return null;
      }
      return stored;
    },

    async drop(token: string): Promise<void> {
      await useStorage('kvStorage').removeItem(key(token));
    },
  };
}
