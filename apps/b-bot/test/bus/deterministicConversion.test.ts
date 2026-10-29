import { describe, expect, it } from 'vitest';
import { sourcePeriods } from '~/services/bus/deterministicConversion';

describe('버스 시간표 적용 기간', () => {
  it('요일 표기가 끼어 있는 Excel 기간을 읽는다', () => {
    expect(sourcePeriods('운행기간 : 2026.04.01.(수) ~ 6.19.(금)')).toEqual(['2026-04-01~2026-06-19']);
  });

  it('두 자리 연도 표기를 2000년대로 정규화한다', () => {
    expect(sourcePeriods('하계 계절학기(26.6.22.~26.7.10.)')).toEqual(['2026-06-22~2026-07-10']);
  });

  it('종료일에 연도가 명시되면 그 연도를 보존한다', () => {
    expect(sourcePeriods('2026-12-20 ~ 2027-01-15')).toEqual(['2026-12-20~2027-01-15']);
  });

  it('서로 다른 기간을 하나로 추정하지 않는다', () => {
    expect(sourcePeriods('2026.03.02.(월) ~ 6.19.(금) / 2026.03.07.(토) ~ 6.13.(토)')).toEqual([
      '2026-03-02~2026-06-19',
      '2026-03-07~2026-06-13',
    ]);
  });

  it('종료 연도가 없고 연말을 넘기면 종료 연도를 1 올린다', () => {
    expect(sourcePeriods('2026.12.20.(일) ~ 2.28.(일)')).toEqual(['2026-12-20~2027-02-28']);
    expect(sourcePeriods('2026.12.20 ~ 12.28')).toEqual(['2026-12-20~2026-12-28']);
  });
});
