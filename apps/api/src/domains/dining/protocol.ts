import { ApiError } from '@api/errors';

export type DiningType = 'BREAKFAST' | 'LUNCH' | 'DINNER';
export type ReportStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ProcessingType = 'MANUAL' | 'SAME_DINING_APPROVED' | 'COOP_PREPROCESSED';
export type Outcome = 'SUCCEEDED' | 'FAILED';
export interface Actor {
  workspace_id: string;
  user_id: string;
  display_name: string;
}
export interface DiningRow {
  id: number;
  date: string;
  type: DiningType;
  place: string;
  price_card: number | null;
  price_cash: number | null;
  kcal: number | null;
  menu: string;
  image_url: string | null;
  created_at: string;
  updated_at: string;
  sold_out: string | null;
  sold_out_source: string | null;
  is_changed: string | null;
  likes: number | null;
}
export interface ReportRow {
  id: number;
  dining_id: number;
  reporter_id: number | null;
  image_url: string;
  status: ReportStatus;
  processing_type: ProcessingType | null;
  processing_id: string | null;
  source_report_id: number | null;
  processor_workspace_id: string | null;
  processor_user_id: string | null;
  processor_name: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ChangeRow {
  sequence: string;
  report_id: number;
  delivery_id: string | null;
  report_snapshot: string | null;
  delivery_state: 'QUEUED' | 'IN_PROGRESS' | 'DELIVERED';
  attempt_token: string | null;
  expires_at: string | null;
  next_attempt_at: string | null;
  accepted_outcome: Outcome | null;
}
const errors = {
  DINING_REPORT_DATE_NOT_ALLOWED: [400, '오늘 식단만 제보할 수 있습니다.'],
  INVALID_REPORT_IMAGE: [400, '제보 사진이 올바르지 않습니다.'],
  BOT_AUTHENTICATION_FAILED: [401, '삐봇 서비스 인증에 실패했습니다.'],
  NOT_FOUND_DINING: [404, '식단을 찾을 수 없습니다.'],
  NOT_FOUND_DINING_REPORT: [404, '품절 제보를 찾을 수 없습니다.'],
  NOT_FOUND_DINING_REPORT_DELIVERY: [404, '배정된 작업을 찾을 수 없습니다.'],
  DINING_ALREADY_SOLD_OUT: [409, '이미 품절된 식단입니다.'],
  DINING_REPORT_ALREADY_SUBMITTED: [409, '이미 제보한 식단입니다.'],
  DINING_REPORT_ALREADY_PROCESSED: [409, '이미 다른 결과로 처리된 제보입니다.'],
  DINING_REPORT_DELIVERY_CONFLICT: [409, '현재 작업 시도 또는 이미 접수한 결과와 일치하지 않습니다.'],
  IMAGE_STORAGE_UNAVAILABLE: [503, '이미지 저장소에 연결할 수 없습니다.'],
  INVALID_REQUEST_BODY: [400, '잘못된 입력값이 포함되어 있습니다.'],
  NOT_READABLE_HTTP_MESSAGE: [400, '잘못된 입력 형식이거나, 값이 허용된 범위를 초과했습니다.'],
  ILLEGAL_ARGUMENT: [400, '잘못된 인자가 전달되었습니다.'],
} as const;
export function fail(code: keyof typeof errors): never {
  const [status, message] = errors[code];
  throw new ApiError(status, code, message);
}
export function utcSql(now: Date, micros = false): string {
  return (
    now
      .toISOString()
      .replace('T', ' ')
      .slice(0, micros ? 23 : 19) + (micros ? '000' : '')
  );
}
export function asInstant(value: string): Date {
  return new Date(value.includes('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}
export function kstDate(now: Date): string {
  return new Date(now.getTime() + 32_400_000).toISOString().slice(0, 10);
}
export function kstTimestamp(value: string | null): string | null {
  return value === null
    ? null
    : new Date(asInstant(value).getTime() + 32_400_000).toISOString().slice(0, 19).replace('T', ' ');
}
export function offsetTimestamp(value: string): string {
  const shifted = new Date(asInstant(value).getTime() + 32_400_000).toISOString();
  return shifted.slice(0, 23) + '+09:00';
}
export function parseDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    fail('ILLEGAL_ARGUMENT');
  return value;
}
export function integer(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') fail('ILLEGAL_ARGUMENT');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail('ILLEGAL_ARGUMENT');
  return number;
}
export function requestObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST_BODY');
  return value as Record<string, unknown>;
}
export function pageWindow(page: number, limit: number, total: number) {
  const size = Math.max(1, Math.min(limit, 50));
  const totalPage = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.max(1, Math.min(page, totalPage));
  return { size, totalPage, currentPage, offset: (currentPage - 1) * size };
}
export function menuItems(menu: string): string[] {
  if (!menu.trim()) throw new ApiError(400, 'ILLEGAL_STATE', '메뉴가 잘못된 형태로 저장되어있습니다.');
  return Array.from(menu.matchAll(/"([^"]*)"/g), (match) => match[1]!);
}
export interface ReportResponse {
  report_id: number;
  dining: { id: number; date: string; type: DiningType; place: string };
  status: ReportStatus;
  processing_type: ProcessingType | null;
  reason: string | null;
  created_at: string | null;
  processed_at: string | null;
  processor: { workspace_id: string | null; user_id: string | null; display_name: string | null } | null;
  image_url: string;
  processing_id: string | null;
  source_report_id: number | null;
  updated_at: string | null;
}
export function reportResponse(report: ReportRow, dining: DiningRow, encoded = false): ReportResponse {
  const manual = report.processing_type === 'MANUAL';
  const reason =
    report.processing_type === 'MANUAL'
      ? report.status === 'APPROVED'
        ? '담당자 승인'
        : '담당자 반려'
      : report.processing_type === 'SAME_DINING_APPROVED'
        ? '동일 코스 제보 승인에 따른 자동 처리'
        : report.processing_type === 'COOP_PREPROCESSED'
          ? '영양사 선처리로 제보 확인 없이 종료'
          : null;
  return {
    report_id: report.id,
    dining: { id: dining.id, date: dining.date, type: dining.type, place: dining.place },
    status: report.status,
    processing_type: report.processing_type,
    reason,
    created_at: kstTimestamp(report.created_at),
    processed_at: manual ? kstTimestamp(report.processed_at) : null,
    processor: manual
      ? {
          workspace_id: report.processor_workspace_id,
          user_id: report.processor_user_id,
          display_name: report.processor_name,
        }
      : null,
    image_url: encoded ? encodeImagePath(report.image_url) : report.image_url,
    processing_id: report.processing_id,
    source_report_id: report.source_report_id,
    updated_at: kstTimestamp(report.updated_at),
  };
}
export function encodeImagePath(value: string): string {
  return encodeURI(value).replace(/[?#[\]+]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
export function claimable(change: ChangeRow, earlier: readonly ChangeRow[], now: string): boolean {
  const due =
    change.delivery_state === 'QUEUED'
      ? change.next_attempt_at === null || change.next_attempt_at <= now
      : change.delivery_state === 'IN_PROGRESS' && change.expires_at !== null && change.expires_at <= now;
  return (
    due &&
    !earlier.some(
      (row) =>
        row.report_id === change.report_id &&
        BigInt(row.sequence) < BigInt(change.sequence) &&
        row.delivery_state !== 'DELIVERED',
    )
  );
}
export function checkResult(change: ChangeRow, token: string, outcome: Outcome, belongsElsewhere: boolean): boolean {
  if (token !== change.attempt_token)
    fail(belongsElsewhere ? 'NOT_FOUND_DINING_REPORT_DELIVERY' : 'DINING_REPORT_DELIVERY_CONFLICT');
  if (change.accepted_outcome !== null) {
    if (change.accepted_outcome !== outcome) fail('DINING_REPORT_DELIVERY_CONFLICT');
    return true;
  }
  if (change.delivery_state !== 'IN_PROGRESS') fail('DINING_REPORT_DELIVERY_CONFLICT');
  return false;
}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resultBody(body: unknown): { attempt_token: string; outcome: Outcome } {
  if (body === null) fail('INVALID_REQUEST_BODY');
  if (typeof body !== 'object' || Array.isArray(body)) fail('NOT_READABLE_HTTP_MESSAGE');
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'attempt_token' && key !== 'outcome')) fail('INVALID_REQUEST_BODY');
  for (const key of ['attempt_token', 'outcome']) {
    if (fields[key] == null || fields[key] === '') fail('INVALID_REQUEST_BODY');
    if (typeof fields[key] !== 'string') fail('NOT_READABLE_HTTP_MESSAGE');
  }
  if (!uuidPattern.test(fields.attempt_token as string) || !['SUCCEEDED', 'FAILED'].includes(fields.outcome as string))
    fail('NOT_READABLE_HTTP_MESSAGE');
  return { attempt_token: (fields.attempt_token as string).toLowerCase(), outcome: fields.outcome as Outcome };
}
export function actorBody(body: unknown): Actor {
  if (!body || typeof body !== 'object' || !('actor' in body) || !body.actor || typeof body.actor !== 'object')
    fail('INVALID_REQUEST_BODY');
  const actor = body.actor as Record<string, unknown>;
  for (const [key, max] of [
    ['workspace_id', 64],
    ['user_id', 64],
    ['display_name', 80],
  ] as const) {
    if (typeof actor[key] !== 'string' || !actor[key].trim() || actor[key].length > max) fail('INVALID_REQUEST_BODY');
  }
  return actor as unknown as Actor;
}
