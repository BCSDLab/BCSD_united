import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSlackFile, type SlackFile } from '~/utils/slackFile';

const file: SlackFile = {
  id: 'F1',
  name: 'timetable.xlsx',
  filetype: 'xlsx',
  size: 2,
  url_private_download: 'https://files.slack.com/source',
};

function spreadsheet(): Response {
  return new Response(new Uint8Array([0x50, 0x4b]));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Slack 파일 리디렉션 인증 범위', () => {
  it('허용된 Slack 목적지에만 인증 헤더를 전달한다', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'test-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://downloads.slack.com/timetable.xlsx' },
        }),
      )
      .mockResolvedValueOnce(spreadsheet());
    vi.stubGlobal('fetch', fetchMock);

    expect(new Uint8Array(await downloadSlackFile(file))).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://downloads.slack.com/timetable.xlsx', {
      headers: { Authorization: 'Bearer test-token' },
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    'https://example.com/download',
    'https://slack.com.example.com/download',
    'http://files.slack.com/download',
  ])('허용되지 않은 목적지에는 요청하지 않는다: %s', async (location) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadSlackFile(file)).rejects.toThrow('슬랙이 아닌 주소');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('같은 Slack 호스트의 상대 경로를 해석한다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/download' } }))
      .mockResolvedValueOnce(spreadsheet());
    vi.stubGlobal('fetch', fetchMock);

    await downloadSlackFile(file);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://files.slack.com/download', expect.any(Object));
  });

  it('반복 리디렉션을 제한한다', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: '/source' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadSlackFile(file)).rejects.toThrow('리디렉션이 너무 많습니다');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
