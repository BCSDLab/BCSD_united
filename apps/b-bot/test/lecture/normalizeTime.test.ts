import { describe, expect, it } from 'vitest';
import { normalizePeriodInput, normalizeRangeInput, parsePeriodFormat } from '~/services/lecture/classTime';

describe('사람이 말한 교시 → 엑셀 표기', () => {
  it('요일을 안 말하면 원래 값의 요일을 쓴다', () => {
    // "09~10으로 바꿔줘" — 요일은 그대로 두라는 뜻이다.
    expect(normalizePeriodInput('09~10', '수03A~04B')).toBe('수09A~10B');
  });

  it('교시만 말하면 그 교시 전체로 본다', () => {
    expect(normalizePeriodInput('9', '수03A~04B')).toBe('수09A~09B');
  });

  it('A/B를 콕 집으면 그대로 둔다', () => {
    expect(normalizePeriodInput('9A', '수03A~04B')).toBe('수09A');
    expect(normalizePeriodInput('9A~10A', '수03A~04B')).toBe('수09A~10A');
  });

  it('요일을 말하면 그걸 쓴다', () => {
    expect(normalizePeriodInput('월9~10', '수03A~04B')).toBe('월09A~10B');
  });

  it('여러 요일도 받는다', () => {
    expect(normalizePeriodInput('월6~6,화8~9', '수03A~04B')).toBe('월06A~06B,화08A~09B');
  });

  it('`교시`와 공백을 걷어낸다', () => {
    expect(normalizePeriodInput('9교시 ~ 10교시', '수03A~04B')).toBe('수09A~10B');
  });

  it('보정 결과가 실제로 파싱된다', () => {
    // 보정만 되고 파서가 거절하면 의미가 없다.
    const parsed = parsePeriodFormat(normalizePeriodInput('09~10', '수03A~04B'));
    expect(parsed).toEqual([{ day: 2, start_time: 216, end_time: 219 }]);
  });
});

describe('사람이 말한 시각 → 엑셀 표기', () => {
  it('정시만 말하면 분을 채운다', () => {
    expect(normalizeRangeInput('9~12')).toBe('09:00~12:00');
    expect(normalizeRangeInput('9시~12시')).toBe('09:00~12:00');
  });

  it('한 자리 시각을 두 자리로 맞춘다', () => {
    expect(normalizeRangeInput('9:00~12:00')).toBe('09:00~12:00');
  });

  it('하루 두 구간도 받는다', () => {
    expect(normalizeRangeInput('9~12/14~16')).toBe('09:00~12:00/14:00~16:00');
  });
});

describe('사람이 쓰는 요일 표기', () => {
  it('`수요일`도 요일로 읽는다', () => {
    expect(normalizePeriodInput('수요일 09~10', '수03A~04B')).toBe('수09A~10B');
  });

  it('원래 시간이 없는 강의는 요일을 지정해야 한다', () => {
    // `0`은 시간 없는 강의(K-MOOC·캡스톤 등)라 물려받을 요일이 없다.
    expect(normalizePeriodInput('09~10', '0')).toBe('09~10');
    expect(normalizePeriodInput('수요일 09~10', '0')).toBe('수09A~10B');
  });
});
