// 멤버 명단은 인터널(internal.bcsdlab.com)이 원본이다. 봇은 서비스 API로 읽기만 한다.
// 연락처·학번은 이 API로 오지 않는다.

export type Track =
  | 'FrontEnd'
  | 'BackEnd'
  | 'Android'
  | 'Design'
  | 'Game'
  | 'iOS'
  | 'PS'
  | 'DevOps'
  | 'Data'
  | 'PM'
  | 'Security'
  | 'client'
  | 'all';

export type MemberType = 'REGULAR' | 'MENTOR' | 'all';

/** 그룹 멘션 '구분' 선택값. 트랙장은 구분이 아니라 직책(*_LEAD)으로 거른다. */
export type MentionGroup = MemberType | 'TRACK_LEAD';

export type ActiveStatus = 'active' | 'inactive' | 'all';

export interface BcsdMember {
  name: string;
  slack_id: string;
  github_id: string | null;
  track_name: Track | null;
  member_type: Exclude<MemberType, 'all'>;
  is_active: boolean;
  is_track_lead: boolean;
}

interface ServiceMember {
  id: number;
  name: string;
  slackId: string | null;
  githubId: string | null;
  track: string | null;
  memberType: Exclude<MemberType, 'all'>;
  clubActive: boolean;
  academicStatus: string;
  positionCodes: string[];
}

// 인터널 트랙 코드 → 그룹 멘션 모달의 option value. 모달 값을 그대로 두려고 봇 쪽 이름으로 바꾼다.
const TRACK_BY_CODE: Record<string, Track> = {
  FRONTEND: 'FrontEnd',
  BACKEND: 'BackEnd',
  ANDROID: 'Android',
  DESIGN: 'Design',
  GAME: 'Game',
  IOS: 'iOS',
  PS: 'PS',
  DEVOPS: 'DevOps',
  DATA: 'Data',
  PM: 'PM',
  SECURITY: 'Security',
};

const CLIENT_TRACKS: Track[] = ['Android', 'FrontEnd', 'iOS'];

const CACHE_TTL_MS = 60_000;
// 그룹 멘션은 view_submission 응답 전에 명단을 읽는다. Slack의 3초 ack 안에 끝나야 한다.
const REQUEST_TIMEOUT_MS = 2_000;

let cache: { at: number; members: BcsdMember[] } | null = null;

export class MemberSourceError extends Error {}

// FRONTEND_LEAD 같은 트랙장. 교육장(*_EDUCATION_LEAD)은 넣지 않는다.
function isTrackLeadCode(code: string): boolean {
  return code.endsWith('_LEAD') && !code.endsWith('_EDUCATION_LEAD');
}

export function toBcsdMembers(members: ServiceMember[]): BcsdMember[] {
  return members
    .filter((member): member is ServiceMember & { slackId: string } => Boolean(member.slackId))
    .map((member) => ({
      name: member.name,
      slack_id: member.slackId,
      github_id: member.githubId,
      track_name: member.track ? (TRACK_BY_CODE[member.track] ?? null) : null,
      member_type: member.memberType,
      is_active: member.clubActive,
      is_track_lead: (member.positionCodes ?? []).some(isTrackLeadCode),
    }));
}

/** Slack ID가 있는 멤버만 돌려준다. 실패하면 MemberSourceError — 빈 명단으로 삼키지 않는다. */
export async function getAllMembers(): Promise<BcsdMember[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.members;
  }

  const baseUrl = process.env.INTERNAL_API_BASE_URL;
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    throw new MemberSourceError('INTERNAL_API_BASE_URL 또는 INTERNAL_SERVICE_TOKEN이 없습니다.');
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/service/members`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MemberSourceError(`인터널 멤버 조회 실패: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new MemberSourceError(`인터널 멤버 조회 실패: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { members: ServiceMember[] };
  const members = toBcsdMembers(body.members);
  cache = { at: Date.now(), members };
  return members;
}

/** 테스트용. */
export function clearMemberCache() {
  cache = null;
}

/** 웹훅 알림용. 명단을 못 읽어도 알림은 이름만으로 나가야 하므로 빈 배열로 대신한다. */
export async function getMembersOrEmpty(): Promise<BcsdMember[]> {
  try {
    return await getAllMembers();
  } catch (error) {
    console.error((error as Error).message);
    return [];
  }
}

/** 이름과 트랙으로 찾는다. 동명이인이 있으면 활동 중인 멤버를 고른다. */
export function findMemberByName(members: BcsdMember[], name: string, track: Track): BcsdMember | undefined {
  const matches = members.filter((member) => member.name === name && member.track_name === track);
  return matches.find((member) => member.is_active) ?? matches[0];
}

/** 찾으면 Slack 멘션, 못 찾으면 이름 그대로. */
export function mentionByName(members: BcsdMember[], name: string, track: Track): string {
  const member = findMemberByName(members, name, track);
  return member ? `<@${member.slack_id}>` : name;
}

interface MentionTargetFilter {
  track: Track;
  memberType: MentionGroup;
  isActive: ActiveStatus;
}

export function filterMentionTargets(
  members: BcsdMember[],
  { track, memberType, isActive }: MentionTargetFilter,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const member of members) {
    const trackMatches =
      track === 'all' ||
      (track === 'client'
        ? member.track_name !== null && CLIENT_TRACKS.includes(member.track_name)
        : member.track_name === track);
    const typeMatches =
      memberType === 'all' || (memberType === 'TRACK_LEAD' ? member.is_track_lead : member.member_type === memberType);
    const activeMatches = isActive === 'all' || (isActive === 'active') === member.is_active;
    if (!trackMatches || !typeMatches || !activeMatches || seen.has(member.slack_id)) {
      continue;
    }
    seen.add(member.slack_id);
    result.push(`<@${member.slack_id}>`);
  }
  return result;
}

export async function getMentionTargetMembers(filter: MentionTargetFilter): Promise<string[]> {
  return filterMentionTargets(await getAllMembers(), filter);
}
