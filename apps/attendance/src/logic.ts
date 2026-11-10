export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** 한국 표준시는 DST가 없으므로 고정 오프셋으로 하루·주 경계를 계산합니다. */
export const KST_OFFSET_MS = 9 * HOUR_MS;
/** 퇴실 태그를 잊은 세션이 무한정 늘어나지 않도록 하는 세션 최대 길이입니다. */
export const MAX_SESSION_MS = 12 * HOUR_MS;
/** 같은 회원의 직전 이벤트 직후 재태그(카드 중복 인식)를 무시하는 시간입니다. */
export const DEBOUNCE_MS = 10_000;

export interface SessionRow {
  /** 회원 식별자는 카드 UID입니다. */
  memberId: string;
  checkIn: number;
  checkOut: number | null;
  autoClosed: boolean;
}

export type TapAction =
  | { kind: 'ignore' }
  | { kind: 'check-in' }
  | { kind: 'check-out' }
  /** 미퇴실로 남은 세션을 `closeAt`에 자동 종료하고 새 입실을 시작합니다. */
  | { kind: 'expire-and-check-in'; closeAt: number };

/**
 * 회원의 가장 최근 세션과 태그 시각으로 입실/퇴실을 정합니다.
 * 태그는 토글이며, 오프라인 재전송으로 직전 이벤트보다 이르거나 디바운스 안에 든 태그는 버립니다.
 */
export function decideTap(latest: SessionRow | null, at: number): TapAction {
  if (!latest) return { kind: 'check-in' };
  const lastEventAt = latest.checkOut ?? latest.checkIn;
  if (at - lastEventAt < DEBOUNCE_MS) return { kind: 'ignore' };
  if (latest.checkOut !== null) return { kind: 'check-in' };
  if (at - latest.checkIn >= MAX_SESSION_MS) {
    return { kind: 'expire-and-check-in', closeAt: latest.checkIn + MAX_SESSION_MS };
  }
  return { kind: 'check-out' };
}

/** `ts`가 속한 KST 날짜의 00:00(UTC epoch ms)입니다. */
export function kstDayStart(ts: number): number {
  return Math.floor((ts + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

/** `ts`가 속한 KST 주(월요일 시작)의 시작입니다. */
export function kstWeekStart(ts: number): number {
  const dayStart = kstDayStart(ts);
  // 1970-01-01(목)을 기준으로 월요일=0이 되도록 3일을 더합니다.
  const daysSinceMonday = (Math.floor((dayStart + KST_OFFSET_MS) / DAY_MS) + 3) % 7;
  return dayStart - daysSinceMonday * DAY_MS;
}

/** 세션이 실제로 인정되는 종료 시각입니다. 열린 세션은 현재 또는 최대 길이까지입니다. */
export function effectiveEnd(session: SessionRow, now: number): number {
  return session.checkOut ?? Math.min(now, session.checkIn + MAX_SESSION_MS);
}

export function isPresent(session: SessionRow, now: number): boolean {
  return session.checkOut === null && now - session.checkIn < MAX_SESSION_MS;
}

function overlapMs(session: SessionRow, from: number, to: number, now: number): number {
  const start = Math.max(session.checkIn, from);
  const end = Math.min(effectiveEnd(session, now), to);
  return Math.max(0, end - start);
}

export interface MemberSummary {
  id: string;
  name: string;
  present: boolean;
  /** 현재 입실 중일 때 입실 시각. */
  since: number | null;
  todayMs: number;
  weekMs: number;
  /** 오늘 처음 입실한 시각. 오늘 기록이 없으면 null. */
  firstInToday: number | null;
}

export function summarize(
  members: { id: string; name: string }[],
  sessions: SessionRow[],
  now: number,
): MemberSummary[] {
  const dayStart = kstDayStart(now);
  const weekStart = kstWeekStart(now);
  const byMember = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const list = byMember.get(session.memberId);
    if (list) list.push(session);
    else byMember.set(session.memberId, [session]);
  }

  const result = members.map((member): MemberSummary => {
    let todayMs = 0;
    let weekMs = 0;
    let since: number | null = null;
    let firstInToday: number | null = null;
    for (const session of byMember.get(member.id) ?? []) {
      todayMs += overlapMs(session, dayStart, dayStart + DAY_MS, now);
      weekMs += overlapMs(session, weekStart, weekStart + 7 * DAY_MS, now);
      if (isPresent(session, now)) since = session.checkIn;
      if (session.checkIn >= dayStart && (firstInToday === null || session.checkIn < firstInToday)) {
        firstInToday = session.checkIn;
      }
    }
    return { id: member.id, name: member.name, present: since !== null, since, todayMs, weekMs, firstInToday };
  });

  return result.sort((a, b) => {
    if (a.present !== b.present) return a.present ? -1 : 1;
    if (a.present && b.present) return (a.since ?? 0) - (b.since ?? 0);
    return b.weekMs - a.weekMs || a.name.localeCompare(b.name, 'ko');
  });
}

/** KV 키 접두사에 쓰는 KST 날짜(YYYYMMDD)입니다. */
export function kstDateKey(ts: number): string {
  return new Date(ts + KST_OFFSET_MS).toISOString().slice(0, 10).replaceAll('-', '');
}
