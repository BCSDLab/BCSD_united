import { describe, expect, it } from 'vitest';
import { parseCoopShopBaseline } from '~/services/coop/baseline';

describe('기존 생협 매장 응답', () => {
  const shop = {
    id: 1,
    name: '학생식당',
    opens: [],
    phone: '041-560-1278',
    location: '학생회관 2층',
    remarks: null,
  };

  it('매장 배열을 기준 데이터로 받는다', () => {
    expect(
      parseCoopShopBaseline({
        semester: '26-1학기',
        from_date: '2026-03-03',
        to_date: '2026-06-19',
        coop_shops: [shop],
      }).coop_shops,
    ).toHaveLength(1);
  });

  it('비어 있거나 형식이 다른 응답을 거절한다', () => {
    expect(() => parseCoopShopBaseline({ coop_shops: [] })).toThrow('비어 있습니다');
    expect(() => parseCoopShopBaseline({ coop_shops: [{ name: '학생식당' }] })).toThrow('형식');
  });
});
