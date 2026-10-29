import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanBusFileName,
  collectBusSpreadsheets,
  downloadBusNoticeFile,
  fetchBusArticle,
  isAllowedBusFileUrl,
} from '~/services/bus/detected';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('버스 공지 첨부 파일명 정리', () => {
  it('괄호 안 용량 표기를 지운다', () => {
    expect(cleanBusFileName('2026학년도 하계 통학버스 시간표.xlsx (128.4KB)')).toBe(
      '2026학년도 하계 통학버스 시간표.xlsx',
    );
    expect(cleanBusFileName('시간표.xls')).toBe('시간표.xls');
  });
});

describe('버스 공지 첨부 주소 허용 목록', () => {
  it('학교 도메인만 허용한다', () => {
    expect(isAllowedBusFileUrl('https://koreatech.in/files/a.xlsx')).toBe(true);
    expect(isAllowedBusFileUrl('https://cdn.koreatech.ac.kr/files/a.xlsx')).toBe(true);
    expect(isAllowedBusFileUrl('https://evil.example.com/a.xlsx')).toBe(false);
    expect(isAllowedBusFileUrl('http://koreatech.in/files/a.xlsx')).toBe(false);
    expect(isAllowedBusFileUrl('not a url')).toBe(false);
  });
});

describe('버스 공지 첨부 중 시간표 파일만 고른다', () => {
  it('xls/xlsx만 남기고, 같은 주소는 최신 이름만 남긴다', () => {
    const files = collectBusSpreadsheets([
      { name: '시간표.xlsx', url: 'https://koreatech.in/f/1', created_at: '2026-01-01' },
      { name: '재업로드.xlsx', url: 'https://koreatech.in/f/1', created_at: '2026-01-02' },
      { name: '포스터.png', url: 'https://koreatech.in/f/2', created_at: '2026-01-01' },
      { name: '다른시간표.xls', url: 'https://evil.example.com/f/3', created_at: '2026-01-01' },
    ]);

    expect(files).toEqual([{ name: '재업로드.xlsx', url: 'https://koreatech.in/f/1' }]);
  });

  it('첨부가 없으면 빈 배열이다', () => {
    expect(collectBusSpreadsheets(undefined)).toEqual([]);
  });
});

describe('버스 공지 게시글 조회', () => {
  it('실패하면 이유를 담아 던진다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBusArticle(123)).rejects.toThrow(/게시글 123을 찾지 못했습니다/);
  });
});

describe('버스 공지 첨부 다운로드', () => {
  it('학교 주소가 아니면 받지 않는다', async () => {
    await expect(
      downloadBusNoticeFile({ name: '시간표.xlsx', url: 'https://evil.example.com/a.xlsx' }),
    ).rejects.toThrow(/학교 주소가 아닌/);
  });

  it('xlsx인데 zip 시그니처가 아니면 거절한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([0, 0, 0, 0]).buffer, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadBusNoticeFile({ name: '시간표.xlsx', url: 'https://koreatech.in/a.xlsx' })).rejects.toThrow(
      /엑셀 파일이 아닙니다/,
    );
  });
});
