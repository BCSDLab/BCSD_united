import { describe, expect, it } from 'vitest';
import {
  isRegularSemesterLabel,
  resolveExtractedCoopSemester,
  resolveRegularSemesterLabel,
} from '~/services/coop/vision';

describe('추출 이미지 학기 분류', () => {
  it('정규학기와 방학을 같은 추출 결과에서 분류한다', () => {
    expect(
      resolveExtractedCoopSemester({
        semesterLabel: '26-1학기',
        title: '시설물 운영시간',
      }),
    ).toMatchObject({ kind: 'regular', year: 2026, termName: '1학기' });
    expect(
      resolveExtractedCoopSemester({
        semesterLabel: '',
        title: '2026년 하계방학 생협 사업장 운영시간 안내',
      }),
    ).toMatchObject({ kind: 'vacation', year: 2026, termName: '하계방학', season: '하계' });
  });

  it('학기 표기가 없으면 분류하지 않는다', () => {
    expect(
      resolveExtractedCoopSemester({
        semesterLabel: '',
        title: '생협 사업장 운영시간 안내',
      }),
    ).toBeNull();
  });
});

describe('정규학기 판별', () => {
  it.each(['2026-1학기', '26-2학기', '26.1학기', '2026년 1학기', '26-1학기 시설물 운영 시간'])('%s', (label) => {
    expect(isRegularSemesterLabel(label)).toBe(true);
  });

  it.each(['2026 하계방학', '26-여름학기', '', '2026-3학기'])('%s 거부', (label) => {
    expect(isRegularSemesterLabel(label)).toBe(false);
  });

  it('학기 필드가 비어도 제목에서 정규학기를 찾는다', () => {
    expect(resolveRegularSemesterLabel('', '26-1학기 시설물 운영 시간')).toBe('26-1학기');
  });
});
