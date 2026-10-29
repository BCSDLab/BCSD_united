import { describe, expect, it } from 'vitest';
import { cleanFileName, guessSemester, isAllowedFileUrl, collectExcelAttachments } from '~/services/lecture/detected';

describe('첨부에서 엑셀 모으기', () => {
  const attach = (name: string, url = 'https://portal.koreatech.ac.kr/f?a=1') => ({ name, url });

  it('엑셀만 모은다', () => {
    const files = collectExcelAttachments([
      attach('안내문.pdf', 'https://portal.koreatech.ac.kr/f?a=1'),
      attach('붙임2. 개설교과목.xlsx(21 KB)', 'https://portal.koreatech.ac.kr/f?a=2'),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('붙임2. 개설교과목.xlsx');
  });

  it('엑셀이 여럿이면 전부 남긴다', () => {
    // 조용히 하나를 집으면 엉뚱한 파일을 변환하고도 아무도 모른다.
    const files = collectExcelAttachments([
      attach('붙임3. 폐강강좌.xlsx', 'https://portal.koreatech.ac.kr/f?a=3'),
      attach('붙임2. 개설교과목 편람.xlsx', 'https://portal.koreatech.ac.kr/f?a=2'),
    ]);
    expect(files).toHaveLength(2);
  });

  it('편람으로 보이는 걸 앞에 둔다', () => {
    const files = collectExcelAttachments([
      attach('붙임3. 폐강강좌.xlsx', 'https://portal.koreatech.ac.kr/f?a=3'),
      attach('붙임2. 개설교과목.xlsx', 'https://portal.koreatech.ac.kr/f?a=2'),
    ]);
    expect(files[0].name).toContain('개설교과목');
  });

  it('같은 자리의 파일이 갈렸으면 최신 이름을 쓴다', () => {
    // 학교가 편람을 새로 올리면 포털은 같은 fs를 갈아끼우고 코인은 두 행을 다 들고 있다.
    // 옛 이름을 잡으면 받는 파일은 최신인데 이름만 지난 날짜로 뜬다.
    const url = 'https://portal.koreatech.ac.kr/ctt/bb/bulletin?b=16&p=1601&a=fd&fs=5';
    const files = collectExcelAttachments([
      { name: '붙임4. 개설교과목 편람_260727.xlsx(122 KB)', url, created_at: '2026-07-27 06:01:45' },
      { name: '붙임4. 개설교과목 편람_260728.xlsx(124 KB)', url, created_at: '2026-07-28 03:01:12' },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toContain('260728');
  });

  it('같은 첨부가 여러 번 실려도 하나만 본다', () => {
    // 실제 게시글에 같은 파일이 네 번 들어 있는 경우가 있었다.
    const same = attach('편람.xlsx(21 KB)', 'https://portal.koreatech.ac.kr/f?a=9');
    expect(collectExcelAttachments([same, same, same, same])).toHaveLength(1);
  });

  it('학교 주소가 아니면 모으지 않는다', () => {
    expect(collectExcelAttachments([attach('편람.xlsx', 'https://evil.example.com/a.xlsx')])).toHaveLength(0);
  });

  it('엑셀이 없으면 빈 목록', () => {
    expect(collectExcelAttachments([attach('안내.pdf')])).toHaveLength(0);
    expect(collectExcelAttachments(undefined)).toHaveLength(0);
  });
});

describe('첨부 이름 정리', () => {
  it('뒤에 붙은 크기를 뗀다', () => {
    expect(cleanFileName('붙임2. 개설교과목.xlsx(21 KB)')).toBe('붙임2. 개설교과목.xlsx');
    expect(cleanFileName('편람.xlsx (1.2 MB)')).toBe('편람.xlsx');
    expect(cleanFileName('편람.xlsx')).toBe('편람.xlsx');
  });
});

describe('제목에서 학기 읽기', () => {
  it('실제 공지 제목을 읽는다', () => {
    expect(guessSemester('[수강신청] 2026학년도 2학기 정규 수강신청 안내')).toEqual({ year: 2026, term: '2학기' });
    expect(guessSemester('2026학년도 하계 계절학기 개설교과목 안내')).toEqual({ year: 2026, term: '여름학기' });
    expect(guessSemester('2025학년도 동계 계절학기 개설 교과목 내역')).toEqual({ year: 2025, term: '겨울학기' });
  });

  it('알아내지 못하면 추측하지 않는다', () => {
    // 엉뚱한 학기에 넣으면 되돌릴 수 없다. 모르면 사람에게 넘긴다.
    expect(guessSemester('수강신청 안내')).toBeNull();
    expect(guessSemester('2026학년도 수강신청 유의사항')).toBeNull();
    expect(guessSemester('')).toBeNull();
  });
});

describe('첨부 주소 확인', () => {
  it('학교 도메인만 통과한다', () => {
    expect(isAllowedFileUrl('https://portal.koreatech.ac.kr/a.xlsx')).toBe(true);
    expect(isAllowedFileUrl('https://api.koreatech.in/a.xlsx')).toBe(true);
  });

  it('접미사 위장을 막는다', () => {
    expect(isAllowedFileUrl('https://koreatech.ac.kr.evil.com/a.xlsx')).toBe(false);
    expect(isAllowedFileUrl('http://portal.koreatech.ac.kr/a.xlsx')).toBe(false);
  });
});
