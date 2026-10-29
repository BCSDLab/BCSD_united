import { describe, expect, it } from 'vitest';
import { sourceDays } from '~/services/bus/days';

describe('sourceDays', () => {
  it('월~금 범위와 주중 키워드를 평일로 읽는다', () => {
    expect(sourceDays('월~금')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expect(sourceDays('월 ~ 금요일')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expect(sourceDays('주중')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expect(sourceDays('평일 운행')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
  });

  it('임의의 범위를 정규 순서로 펼친다', () => {
    expect(sourceDays('수~금')).toEqual(['WED', 'THU', 'FRI']);
    expect(sourceDays('화~금')).toEqual(['TUE', 'WED', 'THU', 'FRI']);
  });

  it('나열된 요일을 언급 순서와 무관하게 정규 순서로 돌려준다', () => {
    expect(sourceDays('금,일요일')).toEqual(['FRI', 'SUN']);
    expect(sourceDays('월,수,금')).toEqual(['MON', 'WED', 'FRI']);
    expect(sourceDays('월·수·금')).toEqual(['MON', 'WED', 'FRI']);
    expect(sourceDays('수 (1대)')).toEqual(['WED']);
    expect(sourceDays('월,화,수,목,금')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
  });

  it('구분자 없이 연속된 요일도 읽는다', () => {
    expect(sourceDays('월화수목금')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expect(sourceDays('월수금')).toEqual(['MON', 'WED', 'FRI']);
    expect(sourceDays('토일')).toEqual(['SAT', 'SUN']);
    expect(sourceDays('운행요일을월화수목금으로')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
  });

  it('주말·매일 키워드를 읽는다', () => {
    expect(sourceDays('주말')).toEqual(['SAT', 'SUN']);
    expect(sourceDays('매일')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
  });

  it('요일이 없으면 undefined를 돌려준다', () => {
    expect(sourceDays('등교')).toBeUndefined();
    expect(sourceDays('08:30')).toBeUndefined();
  });

  it('숫자 뒤의 월·일을 요일로 오인하지 않는다', () => {
    expect(sourceDays('2026.6.22~7.10')).toBeUndefined();
    expect(sourceDays('6월22일~7월10일')).toBeUndefined();
    expect(sourceDays('2026.12.20.(일) ~ 2.28.(일)')).toEqual(['SUN']);
  });

  it("날짜 옆 '월~금'은 요일 범위로 읽는다", () => {
    expect(sourceDays('6/22~7/12 월~금')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expect(sourceDays('천안 하계 계절학기 등하교(6/22~7/12 월~금)')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
  });

  it("'일학습' 같은 고유명사의 일(日)을 일요일로 오인하지 않는다", () => {
    expect(sourceDays('일학습병행대학 토요일 통학 셔틀버스')).toEqual(['SAT']);
    expect(
      sourceDays('동계계절학기 일학습병행대학 토요일 통학버스(6/20, 6/27, 7/4, 7/11, 7/18 - 토요일 5주간)'),
    ).toEqual(['SAT']);
  });
});
