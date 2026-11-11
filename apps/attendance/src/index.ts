import { DAY_MS, decideTap, isUnrecorded, kstDateKey, kstWeekStart, summarize, type SessionRow } from './logic';
import { DASHBOARD_HTML } from './dashboard';

interface Env {
  /**
   * 키 구성 (값은 비어 있고 데이터는 모두 메타데이터에 두어 list 한 번으로 읽습니다):
   * - `member:<uid>`                      메타 {name}
   * - `unknown:<uid>`                     메타 {firstSeen, lastSeen, count}
   * - `s:<KST 날짜>:<입실 시각 13자리>:<uid>`  메타 {checkOut, autoClosed} — 세션
   * - `latest:<uid>`                      값 JSON {checkIn, checkOut, autoClosed} — 회원의 최근 세션 포인터
   */
  ATTENDANCE: KVNamespace;
  /** 라즈베리파이가 태그 이벤트를 보낼 때 쓰는 Bearer 토큰. */
  DEVICE_TOKEN: string;
  /** 대시보드·회원 등록용 Basic 인증 비밀번호(사용자 이름은 무시). */
  DASHBOARD_PASSWORD: string;
}

interface MemberMeta {
  name: string;
}

interface UnknownMeta {
  firstSeen: number;
  lastSeen: number;
  count: number;
}

interface SessionMeta {
  checkOut: number | null;
  autoClosed: boolean;
}

interface LatestSession extends SessionMeta {
  checkIn: number;
}

const UID_PATTERN = /^[0-9A-Z]{4,32}$/;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_OFFLINE_REPLAY_MS = 7 * DAY_MS;
const RECENT_LIMIT = 15;
const UNKNOWN_TTL_SECONDS = 7 * 24 * 3600;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const UNAUTHORIZED = {
  status: 401,
  headers: { ...SECURITY_HEADERS, 'www-authenticate': 'Basic realm="BCSD attendance", charset="UTF-8"' },
} as const;
const encoder = new TextEncoder();

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

/** 길이·내용 모두 시간 차이 없이 비교하도록 SHA-256 다이제스트끼리 비교합니다. */
async function safeEqual(actual: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function deviceAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') && safeEqual(header.slice(7), env.DEVICE_TOKEN);
}

async function dashboardAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  return separator >= 0 && safeEqual(decoded.slice(separator + 1), env.DASHBOARD_PASSWORD);
}

/** 브라우저가 Basic 자격증명을 자동 첨부하므로 mutation은 같은 출처의 JSON 요청만 받습니다. */
function sameOriginJson(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== url.origin) return false;
  return (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sessionKey(uid: string, checkIn: number): string {
  return `s:${kstDateKey(checkIn)}:${String(checkIn).padStart(13, '0')}:${uid}`;
}

/** 접두사 아래 모든 키를 메타데이터와 함께 읽습니다(list는 페이지당 최대 1000개). */
async function listAll<TMeta>(kv: KVNamespace, prefix: string): Promise<{ name: string; metadata: TMeta }[]> {
  const result: { name: string; metadata: TMeta }[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list<TMeta>({ prefix, cursor });
    for (const key of page.keys) if (key.metadata) result.push({ name: key.name, metadata: key.metadata });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result;
}

async function handleTap(request: Request, env: Env): Promise<Response> {
  if (!(await deviceAuthorized(request, env))) return json({ error: 'unauthorized' }, 401);
  const body = await readJson(request);
  if (!body || typeof body.uid !== 'string') return json({ error: 'invalid_body' }, 400);

  const uid = body.uid.trim().toUpperCase();
  if (!UID_PATTERN.test(uid)) return json({ error: 'invalid_uid' }, 400);

  const now = Date.now();
  const at = body.at === undefined ? now : body.at;
  if (
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    at > now + MAX_CLOCK_SKEW_MS ||
    at < now - MAX_OFFLINE_REPLAY_MS
  ) {
    return json({ error: 'invalid_time' }, 400);
  }

  const kv = env.ATTENDANCE;
  const [{ metadata: member }, latest] = await Promise.all([
    kv.getWithMetadata<MemberMeta>(`member:${uid}`),
    kv.get<LatestSession>(`latest:${uid}`, 'json'),
  ]);
  if (!member) {
    const { metadata: seen } = await kv.getWithMetadata<UnknownMeta>(`unknown:${uid}`);
    const next: UnknownMeta = {
      firstSeen: seen?.firstSeen ?? at,
      lastSeen: Math.max(seen?.lastSeen ?? at, at),
      count: (seen?.count ?? 0) + 1,
    };
    // 등록 전 학번·UID는 개인정보이므로 일정 기간 뒤 자동으로 지웁니다.
    await kv.put(`unknown:${uid}`, '', { metadata: next, expirationTtl: UNKNOWN_TTL_SECONDS });
    return json({ status: 'unknown' }, 202);
  }

  const action = decideTap(latest ? { memberId: uid, ...latest } : null, at);
  if (action.kind === 'ignore') return json({ status: 'ignored', name: member.name });

  const open = (checkIn: number) =>
    kv.put(sessionKey(uid, checkIn), '', { metadata: { checkOut: null, autoClosed: false } satisfies SessionMeta });
  const close = (checkIn: number, checkOut: number, autoClosed: boolean) =>
    kv.put(sessionKey(uid, checkIn), '', { metadata: { checkOut, autoClosed } satisfies SessionMeta });
  // 세션을 먼저 쓰고 포인터를 마지막에 갱신합니다. 중간에 실패하면 포인터가 옛 값이라 다음 태그가 다시 판단합니다.
  const point = (value: LatestSession) => kv.put(`latest:${uid}`, JSON.stringify(value));

  switch (action.kind) {
    case 'check-in':
      await open(at);
      await point({ checkIn: at, checkOut: null, autoClosed: false });
      return json({ status: 'check-in', name: member.name, at });
    case 'check-out':
      await close(latest!.checkIn, at, false);
      await point({ checkIn: latest!.checkIn, checkOut: at, autoClosed: false });
      return json({ status: 'check-out', name: member.name, at, durationMs: at - latest!.checkIn });
    case 'expire-and-check-in':
      await close(latest!.checkIn, action.closeAt, true);
      await open(at);
      await point({ checkIn: at, checkOut: null, autoClosed: false });
      return json({ status: 'check-in', name: member.name, at, previousAutoClosed: true });
  }
}

async function handleState(env: Env): Promise<Response> {
  const now = Date.now();
  // 이번 주와, 자정을 걸쳐 주 경계 전날에 시작한 세션(최대 길이 6시간)까지 날짜별 접두사로 읽습니다.
  const days: string[] = [];
  for (let day = kstWeekStart(now) - DAY_MS; day <= now; day += DAY_MS) days.push(kstDateKey(day));
  const kv = env.ATTENDANCE;
  const [members, unknown, ...sessionDays] = await Promise.all([
    listAll<MemberMeta>(kv, 'member:'),
    listAll<UnknownMeta>(kv, 'unknown:'),
    ...days.map((day) => listAll<SessionMeta>(kv, `s:${day}:`)),
  ]);

  const names = new Map(members.map((member) => [member.name.slice('member:'.length), member.metadata.name]));
  const sessions: SessionRow[] = sessionDays.flat().map(({ name, metadata }) => {
    const [, , checkIn, uid] = name.split(':');
    return { memberId: uid, checkIn: Number(checkIn), checkOut: metadata.checkOut, autoClosed: metadata.autoClosed };
  });
  const recent = sessions
    .filter((session) => names.has(session.memberId))
    .sort((a, b) => b.checkIn - a.checkIn)
    .slice(0, RECENT_LIMIT)
    .map((session) => ({
      name: names.get(session.memberId),
      checkIn: session.checkIn,
      checkOut: session.checkOut,
      // 퇴근 태그가 없어 시간 합계에서 빠진 세션(자동 종료 또는 최대 길이 초과).
      unrecorded: isUnrecorded(session, now),
    }));

  return json({
    now,
    // 카드 UID는 화면에 필요 없으므로 내보내지 않습니다.
    members: summarize(
      members.map((member) => ({ id: member.name.slice('member:'.length), name: member.metadata.name })),
      sessions,
      now,
    ).map(({ id: _id, ...summary }) => summary),
    unknownCards: unknown
      .map(({ name, metadata }) => ({ uid: name.slice('unknown:'.length), ...metadata }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 20),
    recent,
  });
}

async function handleMember(request: Request, url: URL, env: Env): Promise<Response> {
  if (!sameOriginJson(request, url)) return json({ error: 'invalid_request' }, 400);
  const body = await readJson(request);
  if (!body || typeof body.uid !== 'string' || typeof body.name !== 'string')
    return json({ error: 'invalid_body' }, 400);

  const uid = body.uid.trim().toUpperCase();
  const name = body.name.trim();
  if (!UID_PATTERN.test(uid)) return json({ error: 'invalid_uid' }, 400);
  if (name.length < 1 || name.length > 30) return json({ error: 'invalid_name' }, 400);

  // 같은 카드로 다시 등록하면 이름만 고칩니다.
  await env.ATTENDANCE.put(`member:${uid}`, '', { metadata: { name } satisfies MemberMeta });
  await env.ATTENDANCE.delete(`unknown:${uid}`);
  return json({ status: 'saved' });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/taps') {
      return request.method === 'POST'
        ? handleTap(request, env)
        : json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
    }

    const isDashboardRoute = url.pathname === '/' || url.pathname === '/api/state' || url.pathname === '/api/members';
    if (!isDashboardRoute) return json({ error: 'not_found' }, 404);
    if (!(await dashboardAuthorized(request, env))) return new Response('Unauthorized', UNAUTHORIZED);

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(DASHBOARD_HTML, {
        headers: {
          ...SECURITY_HEADERS,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname === '/api/state' && request.method === 'GET') return handleState(env);
    if (url.pathname === '/api/members' && request.method === 'POST') return handleMember(request, url, env);
    return json({ error: 'method_not_allowed' }, 405);
  },
} satisfies ExportedHandler<Env>;
