import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectNewestAttachments, downloadAttachment } from '~/services/koin/article';

describe('공지 첨부 공통 처리', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('같은 주소는 가장 최근 이름만 남기고 학교 주소가 아니면 버린다', () => {
    const files = collectNewestAttachments(
      [
        { name: '옛이름.xlsx(21 KB)', url: 'https://portal.koreatech.ac.kr/f/1', created_at: '2026-01-01' },
        { name: '새이름.xlsx(21 KB)', url: 'https://portal.koreatech.ac.kr/f/1', created_at: '2026-02-01' },
        { name: '남의파일.xlsx', url: 'https://example.com/f/2' },
      ],
      (name, url) => ({ name, url }),
    );
    expect(files).toEqual([{ name: '새이름.xlsx', url: 'https://portal.koreatech.ac.kr/f/1' }]);
  });

  it('받지 못하면 넘겨받은 이름으로 알린다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(downloadAttachment('https://portal.koreatech.ac.kr/f/1')).rejects.toThrow(
      '첨부 파일을 받지 못했습니다 (HTTP 404).',
    );
    await expect(downloadAttachment('https://portal.koreatech.ac.kr/f/1', '첨부 이미지를')).rejects.toThrow(
      '첨부 이미지를 받지 못했습니다 (HTTP 404).',
    );
  });
});
