/** 사용자에게 보여줄 오류 문구. Error가 아닌 값이 throw돼도 문구가 비지 않게 한다. */
export function errorMessage(error: unknown, fallback = '알 수 없는 오류입니다'): string {
  return error instanceof Error ? error.message : fallback;
}
