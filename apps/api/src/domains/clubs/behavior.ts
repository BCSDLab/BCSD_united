import { ApiError } from '@api/errors';

const DAY = 86_400_000;
const KST = 9 * 3_600_000;

export function sqlNow(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 19).replace('T', ' ');
}

export function kstDate(time = Date.now()): string {
  return new Date(time + KST).toISOString().slice(0, 10);
}

export function localDateTime(utc: string): string {
  return new Date(utcMillis(utc) + KST).toISOString().slice(0, 19);
}

export function utcMillis(utc: string): number {
  return Date.parse(`${utc.replace(' ', 'T').replace(/Z$/, '')}Z`);
}

export function localToUtc(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(value)) invalid('date', '올바른 날짜 형식이 아닙니다.');
  const time = Date.parse(`${value}+09:00`);
  if (!Number.isFinite(time) || new Date(time + KST).toISOString().slice(0, 16) !== value.slice(0, 16)) invalid('date', '올바른 날짜 형식이 아닙니다.');
  return sqlNow(time);
}

export function normalizeName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

export function invalid(field: string, message: string): never {
  throw new ApiError(400, 'INVALID_REQUEST_BODY', message, [{ field, message }]);
}

export function text(body: Record<string, unknown>, field: string, max = Infinity, required = false, allowWhitespace = false): string | null {
  const value = body[field];
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.length > max || (required && !(allowWhitespace ? value.length : value.trim().length))) invalid(field, `${field} 입력값이 올바르지 않습니다.`);
  return value;
}

export function integer(value: unknown, field: string): number {
  const result = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < -2147483648 || result > 2147483647) invalid(field, `${field} 정수를 입력해주세요.`);
  return result;
}

export function bool(body: Record<string, unknown>, field: string): boolean {
  if (typeof body[field] !== 'boolean') invalid(field, `${field} 값은 필수입니다.`);
  return body[field];
}

export function calendar(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid(field, '올바른 날짜 형식이 아닙니다.');
  return value;
}

export function recruitmentInfo(always: boolean | null, start: string | null, end: string | null, today = kstDate()): { status: string; dday: number | null } {
  const status = always == null ? 'NONE' : always ? 'ALWAYS' : start && today < start ? 'BEFORE' : end && today > end ? 'CLOSED' : 'RECRUITING';
  return { status, dday: status === 'RECRUITING' && end ? Math.round((Date.parse(end) - Date.parse(today)) / DAY) : null };
}

export function validateRecruitment(body: Record<string, unknown>) {
  const is_always_recruiting = bool(body, 'is_always_recruiting');
  const start_date = calendar(body.start_date, 'start_date');
  const end_date = calendar(body.end_date, 'end_date');
  if (is_always_recruiting && (start_date || end_date)) throw new ApiError(400, 'MUST_BE_NULL_RECRUITMENT_PERIOD', '상시 모집일 경우, 모집 시작일과 종료일은 입력하면 안 됩니다.');
  if (!is_always_recruiting && (!start_date || !end_date)) throw new ApiError(400, 'REQUIRED_RECRUITMENT_PERIOD', '상시 모집이 아닌 경우, 모집 시작일과 종료일은 필수입니다.');
  if (start_date && end_date && end_date < start_date) throw new ApiError(400, 'INVALID_RECRUITMENT_PERIOD', '모집 마감일은 모집 시작일 이후여야 합니다.');
  return { is_always_recruiting, start_date, end_date, image_url: text(body, 'image_url', 255), content: text(body, 'content') };
}

export type EventStatus = 'UPCOMING' | 'SOON' | 'ONGOING' | 'ENDED';
export function eventStatus(start: string, end: string, time = Date.now()): EventStatus {
  const begins = utcMillis(start);
  if (time < begins - 3_600_000) return 'UPCOMING';
  if (time < begins) return 'SOON';
  if (time < utcMillis(end) + 60_000) return 'ONGOING';
  return 'ENDED';
}

export function canCreateQna(isManager: boolean, parentId: number | null): boolean {
  return (parentId === null) !== isManager;
}

export function canDeleteQna(authorId: number | null, userId: number, isManager: boolean): boolean {
  return authorId === userId || isManager;
}

export function selectHotClub<T extends { hits: number; last_week_hits: number }>(clubs: readonly T[]): T | undefined {
  let winner: T | undefined;
  for (const club of clubs) if (!winner || club.hits - club.last_week_hits > winner.hits - winner.last_week_hits) winner = club;
  return winner;
}

export function lastWeek(time: number): { start: string; end: string } {
  const date = new Date(`${kstDate(time)}T00:00:00Z`);
  const day = (date.getUTCDay() + 6) % 7;
  const monday = date.getTime() - (day + 7) * DAY;
  return { start: new Date(monday).toISOString().slice(0, 10), end: new Date(monday + 6 * DAY).toISOString().slice(0, 10) };
}

export function compareEvents(a: { start_date: string; end_date: string; created_at: string }, b: { start_date: string; end_date: string; created_at: string }, type: string, time: number): number {
  const first = eventStatus(a.start_date, a.end_date, time);
  const second = eventStatus(b.start_date, b.end_date, time);
  const priority = { SOON: 1, ONGOING: 1, UPCOMING: 2, ENDED: 3 };
  const difference = type === 'RECENT' ? Number(first === 'ENDED') - Number(second === 'ENDED') : priority[first] - priority[second];
  return difference || b.created_at.localeCompare(a.created_at);
}

export function validateClub(body: Record<string, unknown>, mode: 'request' | 'update' | 'admin-create' | 'admin-update') {
  const name = text(body, 'name', 20, true, mode === 'update')!;
  const image_url = text(body, 'image_url', 255, true)!;
  const club_category_id = integer(body.club_category_id, 'club_category_id');
  const location = text(body, 'location', 20, true)!;
  const description = text(body, 'description', 40);
  const phone_number = text(body, 'phone_number', 255, true)!;
  if (!/^\d{11}$/.test(phone_number)) invalid('phone_number', '전화번호 형식이 올바르지 않습니다. 11자리 숫자로 입력해 주세요.');
  const contacts = { instagram: text(body, 'instagram', 255), google_form: text(body, 'google_form', 255), open_chat: text(body, 'open_chat', 255), phone_number };
  const is_like_hidden = mode === 'request' || mode === 'update' ? bool(body, 'is_like_hidden') : false;
  if (mode === 'request') text(body, 'role', Infinity, true);
  if (mode !== 'update' && (!Array.isArray(body.club_managers) || !body.club_managers.length)) invalid('club_managers', '동아리 관리자는 필수 입력 사항입니다.');
  return { name, normalized_name: normalizeName(name), image_url, club_category_id, location, description, is_like_hidden, contacts };
}

export function validateEvent(body: Record<string, unknown>) {
  const name = text(body, 'name', 30, true)!;
  const introduce = text(body, 'introduce', 70, true)!;
  const start_date = localToUtc(text(body, 'start_date', Infinity, true)!);
  const end_date = localToUtc(text(body, 'end_date', Infinity, true)!);
  if (end_date <= start_date) throw new ApiError(400, 'INVALID_CLUB_EVENT_PERIOD', '행사 마감일은 행사 시작일 이후여야 합니다.');
  const image_urls = body.image_urls == null ? [] : body.image_urls;
  if (!Array.isArray(image_urls) || image_urls.some(url => typeof url !== 'string' || url.length > 255) || new Set(image_urls).size !== image_urls.length) invalid('image_urls', '이미지 URL은 중복될 수 없습니다.');
  return { name, introduce, start_date, end_date, content: text(body, 'content'), image_urls: image_urls as string[] };
}
