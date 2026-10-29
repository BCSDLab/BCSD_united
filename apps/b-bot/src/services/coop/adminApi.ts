export type { KoinAdminAuth as CoopAdminAuth } from '~/services/koin/adminAuth';
import type { KoinAdminAuth as CoopAdminAuth } from '~/services/koin/adminAuth';
import type { AdminUpdateSemesterRequest } from './types';
import { normalizeMealType } from './convert';
import { adminFetch, errorSnippet } from '~/services/koin/adminHttp';

export interface CoopSemesterCreateRequest {
  semester: string;
  from_date: string;
  to_date: string;
}

export interface CoopSemesterResponse extends CoopSemesterCreateRequest {
  id: number;
  is_applied: boolean;
}

export type CoopAdminStage = 'semester_create' | 'semester_lookup' | 'timetable';

export interface CoopTimetableApplyInput {
  semester: CoopSemesterCreateRequest;
  timetable: AdminUpdateSemesterRequest;
}

export class CoopAdminApiError extends Error {
  constructor(
    message: string,
    readonly stage: CoopAdminStage,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CoopAdminApiError';
  }
}

/** 기존 검수 데이터까지 포함해 Admin API에는 표준 식사 타입과 한글 요일만 전송한다. */
export function normalizeCoopTimetableRequest(request: AdminUpdateSemesterRequest): AdminUpdateSemesterRequest {
  return {
    coop_shops: request.coop_shops.map((shop) => ({
      ...shop,
      coop_shop_info: { ...shop.coop_shop_info },
      operation_hours: shop.operation_hours.map((hour) => ({
        ...hour,
        day_of_week: hour.day_of_week === 'FRIDAY' ? '금요일' : hour.day_of_week,
        ...(hour.type ? { type: normalizeMealType(hour.type) } : {}),
      })),
    })),
  };
}

function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { code?: string }).code;
  } catch {
    return undefined;
  }
}

/**
 * 생협 학기를 만든다.
 *
 * 반영 재시도에서는 앞선 시도가 학기만 만든 뒤 실패했을 수 있다. 이때 서버가 주는
 * DUPLICATE_SEMESTER만 정상 흐름으로 넘기고, 기간 중복 등 다른 409는 숨기지 않는다.
 */
export async function createCoopSemester(request: CoopSemesterCreateRequest, auth: CoopAdminAuth): Promise<void> {
  const response = await adminFetch(auth, '/admin/coopshop/semesters', { method: 'POST', body: request });

  if (response.ok) return;

  const body = await errorSnippet(response);
  if (response.status === 409 && errorCode(body) === 'DUPLICATE_SEMESTER') return;

  throw new CoopAdminApiError(
    `생협 학기 생성 실패 — POST /admin/coopshop/semesters (HTTP ${response.status})\n${body}`,
    'semester_create',
    response.status,
  );
}

export async function getCoopSemesters(auth: CoopAdminAuth): Promise<CoopSemesterResponse[]> {
  const response = await adminFetch(auth, '/admin/coopshop/semesters', { method: 'GET' });

  if (!response.ok) {
    const body = await errorSnippet(response);
    throw new CoopAdminApiError(
      `생협 학기 조회 실패 — GET /admin/coopshop/semesters (HTTP ${response.status})\n${body}`,
      'semester_lookup',
      response.status,
    );
  }

  return (await response.json()) as CoopSemesterResponse[];
}

export async function updateCoopTimetable(
  semesterId: number,
  request: AdminUpdateSemesterRequest,
  auth: CoopAdminAuth,
): Promise<void> {
  const normalized = normalizeCoopTimetableRequest(request);
  const response = await adminFetch(auth, `/admin/coopshop/timetable/${semesterId}`, {
    method: 'PUT',
    body: normalized,
  });

  if (response.ok) return;

  const body = await errorSnippet(response);
  throw new CoopAdminApiError(
    `생협 시간표 업데이트 실패 — PUT /admin/coopshop/timetable/${semesterId} (HTTP ${response.status})\n${body}`,
    'timetable',
    response.status,
  );
}

function findExactSemester(
  semesters: CoopSemesterResponse[],
  semester: CoopSemesterCreateRequest,
): CoopSemesterResponse {
  const matched = semesters.find((candidate) => candidate.semester === semester.semester);

  if (!matched) {
    throw new CoopAdminApiError(
      `생성한 생협 학기를 조회 결과에서 찾지 못했습니다: ${semester.semester}`,
      'semester_lookup',
      404,
    );
  }
  if (matched.from_date !== semester.from_date || matched.to_date !== semester.to_date) {
    throw new CoopAdminApiError(
      [
        `동일한 이름의 생협 학기 기간이 다릅니다: ${semester.semester}`,
        `요청 ${semester.from_date} - ${semester.to_date}`,
        `조회 ${matched.from_date} - ${matched.to_date}`,
      ].join('\n'),
      'semester_lookup',
      409,
    );
  }
  return matched;
}

export async function applyCoopTimetables(
  inputs: CoopTimetableApplyInput[],
  auth: CoopAdminAuth,
  onApplied?: (semesterId: number, index: number) => void,
): Promise<number[]> {
  if (inputs.length === 0) return [];
  for (const input of inputs) {
    await createCoopSemester(input.semester, auth);
  }
  const semesters = await getCoopSemesters(auth);
  const matched = inputs.map((input) => findExactSemester(semesters, input.semester));
  const appliedIds: number[] = [];
  for (const [index, input] of inputs.entries()) {
    const semesterId = matched[index].id;
    await updateCoopTimetable(semesterId, input.timetable, auth);
    appliedIds.push(semesterId);
    onApplied?.(semesterId, index);
  }
  return appliedIds;
}

export async function applyCoopTimetable(
  semester: CoopSemesterCreateRequest,
  timetable: AdminUpdateSemesterRequest,
  auth: CoopAdminAuth,
): Promise<number> {
  const [semesterId] = await applyCoopTimetables([{ semester, timetable }], auth);
  return semesterId;
}
