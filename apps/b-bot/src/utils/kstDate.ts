/**
 * 한국 시간 기준 날짜 키(`2026-03-09`). 하루 단위로 묶는 KV 키에 쓴다.
 * `sv-SE` 로캘이 ISO 형식(YYYY-MM-DD, 0 채움)으로 찍어 준다.
 */
export function kstDateKey(date = new Date()): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}
