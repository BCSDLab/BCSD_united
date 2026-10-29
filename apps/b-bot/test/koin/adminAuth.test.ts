import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKoinAdminAuth } from '~/services/koin/adminAuth';

describe('코인 관리자 인증', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('대상의 주소와 계정으로 로그인한다', async () => {
    const fetchMock = vi.fn(async () => ({ token: 'admin-token' }));
    vi.stubGlobal('$fetch', fetchMock);

    await expect(
      getKoinAdminAuth({
        env: 'stage',
        label: '스테이지',
        baseUrl: 'https://api.stage.example.com',
        email: 'admin@example.com',
        password: 'password',
      }),
    ).resolves.toEqual({
      baseUrl: 'https://api.stage.example.com',
      accessToken: 'admin-token',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'admin/user/login',
      expect.objectContaining({
        baseURL: 'https://api.stage.example.com',
        method: 'POST',
      }),
    );
  });

  it('토큰 없는 로그인 응답을 거절한다', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn(async () => ({})),
    );
    await expect(
      getKoinAdminAuth({
        env: 'stage',
        label: '스테이지',
        baseUrl: 'https://api.stage.example.com',
        email: 'admin@example.com',
        password: 'password',
      }),
    ).rejects.toThrow('액세스 토큰');
  });
});
