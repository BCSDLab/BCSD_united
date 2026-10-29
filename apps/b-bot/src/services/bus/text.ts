/** 원문 표기에 나오는 버스 지역. 앞에서부터 처음 맞는 지역을 쓴다. */
export const BUS_REGIONS = ['천안', '청주', '서울', '세종', '대전', '아산'] as const;

export function sourceRegion(text = ''): string | undefined {
  return BUS_REGIONS.find((region) => text.includes(region));
}

/** 셀 값의 줄바꿈과 겹친 공백을 한 칸으로 접는다. */
export const clean = (value: unknown) =>
  String(value ?? '')
    .replaceAll('\n', ' ')
    .replace(/\s+/g, ' ')
    .trim();
