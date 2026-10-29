import { ApiError } from '@api/errors';
import { z } from 'zod';

const errors = {
  INVALID_REQUEST_BODY: [400, '잘못된 입력값이 포함되어 있습니다.'],
  REQUEST_TOO_FAST: [409, '요청이 너무 빠릅니다. 다시 요청해주세요.'],
  INVALID_START_DATE_AFTER_END_DATE: [400, '시작일은 종료일 이전이여야 합니다.'],
  TEAM_RECRUITMENT_ACTIVITY_END_DATE_REQUIRED: [400, '진행 중인 활동이 아닌 경우, 활동 종료일은 필수입니다.'],
  TEAM_RECRUITMENT_ACTIVITY_END_DATE_MUST_BE_NULL: [400, '진행 중인 활동인 경우, 활동 종료일은 입력하면 안 됩니다.'],
  TEAM_RECRUITMENT_INVALID_ROLE_COMPOSITION: [400, '모집 유형에 맞지 않는 역할 또는 정원 구성입니다.'],
  TEAM_RECRUITMENT_FORBIDDEN: [403, '팀원 모집글에 대한 권한이 없습니다.'],
  TEAM_RECRUITMENT_NOT_FOUND: [404, '팀원 모집글이 존재하지 않습니다.'],
  TEAM_RECRUITMENT_PROFILE_NOT_FOUND: [404, '팀원 모집 프로필이 존재하지 않습니다.'],
  TEAM_RECRUITMENT_APPLICATION_NOT_FOUND: [404, '팀원 모집 지원서가 존재하지 않습니다.'],
  TEAM_RECRUITMENT_ROLE_NOT_FOUND: [404, '해당 모집글의 역할이 존재하지 않습니다.'],
  TEAM_RECRUITMENT_CLOSED: [409, '마감된 팀원 모집글입니다.'],
  TEAM_RECRUITMENT_ROLE_CLOSED: [409, '마감된 모집 역할입니다.'],
  TEAM_RECRUITMENT_CAPACITY_FULL: [409, '모집 인원이 가득 찼습니다.'],
  TEAM_RECRUITMENT_PROFILE_REQUIRED: [409, '팀원 모집 프로필 작성이 필요합니다.'],
  TEAM_RECRUITMENT_APPLICATION_DUPLICATE: [409, '이미 지원한 팀원 모집글입니다.'],
  TEAM_RECRUITMENT_APPLICATION_FINALIZED: [409, '이미 처리된 팀원 모집 지원서입니다.'],
  TEAM_RECRUITMENT_ROLE_UPDATE_NOT_ALLOWED: [409, '지원자가 있는 역할은 삭제, 이름 변경, 정원 축소를 할 수 없습니다.'],
  TEAM_RECRUITMENT_MAX_PARTICIPANTS_BELOW_ACCEPTED: [409, '승인된 인원보다 적은 정원으로 수정할 수 없습니다.'],
  TEAM_RECRUITMENT_TYPE_CHANGE_NOT_ALLOWED: [409, '지원자가 있으면 모집 유형을 변경할 수 없습니다.'],
} as const;
export type TeamError = keyof typeof errors;
export function fail(code: TeamError): never {
  const [status, message] = errors[code];
  throw new ApiError(status, code, message);
}
export const kstDay = (now = Date.now()) => new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
export const dDay = (status: string, deadline: string | null, today: string) =>
  status !== 'RECRUITING' || !deadline || deadline < today
    ? null
    : Math.round((Date.parse(deadline) - Date.parse(today)) / 86_400_000);
export const categoryNames = {
  CONTEST: '공모전',
  EXTERNAL_ACTIVITY: '대외활동',
  STUDY: '스터디',
  PROJECT: '프로젝트',
  OTHER: '기타',
};
export const meetingNames = { ONLINE: '온라인', OFFLINE: '오프라인', MIXED: '온/오프라인' };
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
export const recruitmentInput = z.object({
  category: z.enum(['CONTEST', 'EXTERNAL_ACTIVITY', 'STUDY', 'PROJECT', 'OTHER']),
  title: text(50),
  meeting_type: z.enum(['ONLINE', 'OFFLINE', 'MIXED']),
  activity_start_date: date,
  activity_end_date: date,
  deadline_date: date,
  recruitment_type: z.enum(['GENERAL', 'ROLE_BASED']),
  max_participants: z.number().int().nullable().optional(),
  roles: z.array(
    z.object({
      id: z.number().int().positive().nullable().optional(),
      name: z
        .string()
        .transform((value) => value.trim())
        .pipe(text(10)),
      max_participants: z.number().int().min(1).max(10),
    }),
  ),
  description: text(1000),
  related_url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/.*/)
    .nullable()
    .optional(),
  qualification: z.string().min(1).max(500).nullable().optional(),
});
export type RecruitmentInput = z.infer<typeof recruitmentInput>;
export function validateRecruitment(input: unknown): RecruitmentInput & { max_participants: number } {
  const value = parse(recruitmentInput, input);
  if (value.activity_end_date < value.activity_start_date) fail('INVALID_START_DATE_AFTER_END_DATE');
  if (
    value.recruitment_type === 'GENERAL'
      ? value.roles.length !== 0 || !value.max_participants || value.max_participants < 1 || value.max_participants > 10
      : value.roles.length < 1 || value.roles.length > 5
  )
    fail('TEAM_RECRUITMENT_INVALID_ROLE_COMPOSITION');
  const names = value.roles.map((role) =>
    role.name
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase(),
  );
  const ids = value.roles.flatMap((role) => (role.id == null ? [] : [role.id]));
  if (new Set(names).size !== names.length || new Set(ids).size !== ids.length) fail('INVALID_REQUEST_BODY');
  const capacity =
    value.recruitment_type === 'GENERAL'
      ? value.max_participants!
      : value.roles.reduce((sum, role) => sum + role.max_participants, 0);
  if (capacity > 10) fail('INVALID_REQUEST_BODY');
  return { ...value, max_participants: capacity };
}
export const profileInput = z.object({
  profile_nickname: text(20),
  preferred_role: text(20),
  self_introduction: text(1000),
  skills: z.array(text(20)),
  activities: z.array(
    z.object({
      title: text(50),
      started_at: date,
      ended_at: date.nullable(),
      is_ongoing: z.boolean(),
      description: text(1000),
    }),
  ),
});
export function validateProfile(input: unknown) {
  const value = parse(profileInput, input);
  for (const activity of value.activities) {
    if (activity.is_ongoing && activity.ended_at !== null) fail('TEAM_RECRUITMENT_ACTIVITY_END_DATE_MUST_BE_NULL');
    if (!activity.is_ongoing && activity.ended_at === null) fail('TEAM_RECRUITMENT_ACTIVITY_END_DATE_REQUIRED');
    if (activity.ended_at !== null && activity.ended_at < activity.started_at)
      fail('INVALID_START_DATE_AFTER_END_DATE');
  }
  return value;
}
export const applicationInput = z.object({
  role_id: z.number().int().nullable(),
  motivation: text(1000),
  availability: text(100),
});
export function parse<T>(validator: z.ZodType<T>, input: unknown): T {
  const result = validator.safeParse(input);
  if (!result.success) fail('INVALID_REQUEST_BODY');
  return result.data;
}
export function criteria(page: string | undefined, limit: string | undefined, total: number) {
  if ((page !== undefined && !/^-?\d+$/.test(page)) || (limit !== undefined && !/^-?\d+$/.test(limit)))
    fail('INVALID_REQUEST_BODY');
  const size = Math.min(50, Math.max(1, Number(limit ?? 10)));
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page ?? 1)));
  return {
    limit: size,
    page: current,
    offset: (current - 1) * size,
    total_count: total,
    total_page: pages,
    current_page: current,
  };
}
export function applyBlockReason(
  input: {
    deleted: boolean;
    userId: number | null;
    isAuthor: boolean;
    applied: boolean;
    status: string;
    deadline: string;
    full: boolean;
    hasProfile: boolean;
  },
  today: string,
) {
  if (input.deleted) return 'RECRUITMENT_DELETED';
  if (input.userId === null) return 'LOGIN_REQUIRED';
  if (input.isAuthor) return 'OWN_RECRUITMENT';
  if (input.applied) return 'ALREADY_APPLIED';
  if (input.status !== 'RECRUITING') return 'RECRUITMENT_CLOSED';
  if (input.deadline < today) return 'DEADLINE_PASSED';
  if (input.full) return 'ROLE_CLOSED';
  return input.hasProfile ? null : 'PROFILE_REQUIRED';
}
