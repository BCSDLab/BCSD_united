import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminFetch } from '~/services/koin/adminHttp';

const auth = { baseUrl: 'https://api.stage.example.com/', accessToken: 'token' };

describe('코인 Admin API 호출', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('인증 헤더와 JSON 본문, 시한을 붙인다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await adminFetch(auth, '/admin/semesters', { method: 'POST', body: { year: 2026 } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stage.example.com/admin/semesters');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer token' });
    expect(JSON.parse(init.body)).toEqual({ year: 2026 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('본문이 없으면 body를 보내지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);

    await adminFetch(auth, '/admin/coopshop/semesters', { method: 'GET' });

    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body');
  });
});

describe('코인 Admin API 시한 초과', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('시한 초과는 무엇이 멈췄는지 한국어로 알린다', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

    await expect(adminFetch(auth, '/admin/lectures', { method: 'POST', timeoutMs: 120_000 })).rejects.toThrow(
      /120초 안에 응답하지 않았습니다 — POST \/admin\/lectures/,
    );
  });
});
