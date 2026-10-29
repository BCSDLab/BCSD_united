import { describe, expect, it } from 'vitest';
import {
  collectCoopImages,
  guessCoopSemester,
  guessRegularCoopSemester,
  hasImageSignature,
} from '~/services/coop/detected';

describe('생협 공지 이미지 첨부', () => {
  const attach = (name: string, url = 'https://portal.koreatech.ac.kr/file?id=1') => ({ name, url });

  it('지원 이미지 형식만 모은다', () => {
    const images = collectCoopImages([
      attach('운영시간.pdf'),
      attach('26-1학기 시설물 운영시간.png(1.2 MB)', 'https://portal.koreatech.ac.kr/file?id=2'),
      attach('참고.jpg', 'https://portal.koreatech.ac.kr/file?id=3'),
    ]);
    expect(images).toEqual([
      expect.objectContaining({ name: '26-1학기 시설물 운영시간.png', mimeType: 'image/png' }),
      expect.objectContaining({ name: '참고.jpg', mimeType: 'image/jpeg' }),
    ]);
  });

  it('학교 외 주소와 중복 첨부를 제거하고 최신 이름을 남긴다', () => {
    const url = 'https://portal.koreatech.ac.kr/file?id=9';
    const images = collectCoopImages([
      { name: '이전.png', url, created_at: '2026-08-01 10:00:00' },
      { name: '최신.png', url, created_at: '2026-08-02 10:00:00' },
      attach('위장.png', 'https://koreatech.ac.kr.evil.com/a.png'),
    ]);
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe('최신.png');
  });
});

describe('생협 공지 정규학기 판별', () => {
  it('연도와 1·2학기를 읽는다', () => {
    expect(guessRegularCoopSemester('2026년 1학기 시설물 운영 시간')).toEqual({ year: 2026, termName: '1학기' });
    expect(guessRegularCoopSemester('2026-2학기 생협 운영시간 안내')).toEqual({ year: 2026, termName: '2학기' });
    expect(guessRegularCoopSemester('2026학년도 1학기 생협 운영시간 안내')).toEqual({ year: 2026, termName: '1학기' });
  });

  it('계절학기·방학과 학기 없는 제목은 거절한다', () => {
    expect(guessRegularCoopSemester('2026년 1학기 하계방학 운영 시간')).toBeNull();
    expect(guessRegularCoopSemester('2026학년도 하계 계절학기 운영 시간')).toBeNull();
    expect(guessRegularCoopSemester('생협 운영시간 안내')).toBeNull();
  });
});

describe('생협 공지 방학 판별', () => {
  it('하계·동계방학 제목을 읽는다', () => {
    expect(guessCoopSemester('2026년 하계방학 생협 운영시간 안내')).toEqual({ year: 2026, termName: '하계방학' });
    expect(guessCoopSemester('2026년 동계 계절학기 및 방학 운영시간')).toEqual({ year: 2026, termName: '동계방학' });
  });
});

describe('생협 공지 이미지 내용 확인', () => {
  it('확장자에 맞는 매직 바이트를 확인한다', () => {
    expect(hasImageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBe(true);
    expect(hasImageSignature(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toBe(true);
    expect(hasImageSignature(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), 'image/png')).toBe(false);
  });
});
