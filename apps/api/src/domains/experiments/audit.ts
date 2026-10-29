import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import {
  integerParameter,
  kstTimestamp,
  legacyError,
  pagination,
  requiredInteger,
} from '@api/domains/experiments/algorithms';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';

export const auditDomains = {
  MEMBERS: 'BCSDLAB 회원',
  TRACKS: '트랙',
  TECHSTACKS: '기술 스택',
  NOTICE: '코인 공지',
  VERSION: '버전관리',
  CATEGORIES: '카테고리',
  BENEFIT: '혜택',
  BENEFITCATEGORIES: '혜택 카테고리',
  SHOPS: '상점',
  SHOPSCATEGORIES: '상점 카테고리',
  MENUS: '메뉴',
  MENUSCATEGORIES: '메뉴 카테고리',
  REVIEWS: '리뷰',
  ABTEST: 'AB 테스트',
  LANDS: '복덕방',
  LECTURES: '강의',
  SEMESTER: '학기',
  COOP_SHOPS: '생협 매장',
  USERS: '회원',
  STUDENT: '학생',
  OWNER: '사장님',
  ADMIN: '어드민',
  BANNERS: '배너',
  BANNER_CATEGORIES: '배너 카테고리',
  CLUBS: '동아리',
  KEYWORDS: '키워드 알림',
  LOST_ITEMS: '분실물',
  COOP_SEMESTER: '생협 학기',
  SHUTTLE_BUS: '셔틀 버스',
  COMMUTING_BUS: '등하교 버스',
  NOTIFICATION: '알림',
} as const;

export type AuditDomain = keyof typeof auditDomains;
const auditMethods = { POST: '생성', PUT: '수정', DELETE: '삭제', PATCH: '수정' } as const;
type AuditMethod = keyof typeof auditMethods;
type AuditRoute = readonly [AuditMethod, string, AuditDomain, string?];

const auditRoutes: readonly AuditRoute[] = [
  ['POST', '/abtest', 'ABTEST'],
  ['PUT', '/abtest/:id', 'ABTEST', 'id'],
  ['DELETE', '/abtest/:id', 'ABTEST', 'id'],
  ['POST', '/abtest/close/:id', 'ABTEST', 'id'],
  ['POST', '/abtest/:id/move', 'ABTEST', 'id'],
  ['POST', '/admin/banners', 'BANNERS'],
  ['DELETE', '/admin/banners/:id', 'BANNERS', 'id'],
  ['PATCH', '/admin/banners/:id/priority', 'BANNERS', 'id'],
  ['PATCH', '/admin/banners/:id/active', 'BANNERS', 'id'],
  ['PUT', '/admin/banners/:id', 'BANNERS', 'id'],
  ['PATCH', '/admin/banner-categories/:id', 'BANNER_CATEGORIES', 'id'],
  ['POST', '/admin/benefit/categories', 'BENEFITCATEGORIES'],
  ['PUT', '/admin/benefit/categories/:id', 'BENEFITCATEGORIES', 'id'],
  ['DELETE', '/admin/benefit/categories/:id', 'BENEFITCATEGORIES', 'id'],
  ['POST', '/admin/benefit/:id/shops', 'BENEFIT', 'id'],
  ['PUT', '/admin/benefit', 'BENEFIT'],
  ['DELETE', '/admin/benefit/:id/shops', 'BENEFIT', 'id'],
  ['POST', '/admin/bus/commuting/timetable/excel', 'COMMUTING_BUS'],
  ['PUT', '/admin/bus/commuting/timetable', 'COMMUTING_BUS'],
  ['POST', '/admin/bus/shuttle/timetable/excel', 'SHUTTLE_BUS'],
  ['PUT', '/admin/bus/shuttle/timetable', 'SHUTTLE_BUS'],
  ['POST', '/admin/clubs', 'CLUBS'],
  ['PUT', '/admin/clubs/:clubId', 'CLUBS', 'clubId'],
  ['PATCH', '/admin/clubs/:clubId/active', 'CLUBS', 'clubId'],
  ['POST', '/admin/clubs/pending', 'CLUBS'],
  ['POST', '/admin/clubs/decision', 'CLUBS'],
  ['POST', '/admin/coopshop/timetable/excel', 'COOP_SHOPS'],
  ['PUT', '/admin/coopshop/timetable/:semesterId', 'COOP_SHOPS', 'semesterId'],
  ['POST', '/admin/articles/keyword/filter', 'KEYWORDS'],
  ['POST', '/admin/lands', 'LANDS'],
  ['PUT', '/admin/lands/:id', 'LANDS', 'id'],
  ['DELETE', '/admin/lands/:id', 'LANDS', 'id'],
  ['POST', '/admin/lands/:id/undelete', 'LANDS', 'id'],
  ['POST', '/admin/lectures', 'LECTURES'],
  ['PUT', '/admin/articles/lost-item/reports/:id', 'LOST_ITEMS', 'id'],
  ['DELETE', '/admin/articles/lost-item/:id', 'LOST_ITEMS', 'id'],
  ['PUT', '/admin/:id/authed', 'ADMIN', 'id'],
  ['PUT', '/admin/:id', 'ADMIN', 'id'],
  ['PUT', '/admin/:id/permission', 'ADMIN', 'id'],
  ['POST', '/admin/notice', 'NOTICE'],
  ['DELETE', '/admin/notice/:id', 'NOTICE', 'id'],
  ['PUT', '/admin/notice/:id', 'NOTICE', 'id'],
  ['POST', '/admin/notification/send', 'NOTIFICATION'],
  ['PUT', '/admin/owner/:id/authed', 'OWNER', 'id'],
  ['POST', '/admin/semesters', 'SEMESTER'],
  ['POST', '/admin/coopshop/semesters', 'COOP_SEMESTER'],
  ['POST', '/admin/shops', 'SHOPS'],
  ['POST', '/admin/shops/categories', 'SHOPSCATEGORIES'],
  ['PUT', '/admin/shops/:id', 'SHOPS', 'id'],
  ['PUT', '/admin/shops/categories/:id', 'SHOPSCATEGORIES', 'id'],
  ['PUT', '/admin/shops/categories/order', 'SHOPSCATEGORIES'],
  ['POST', '/admin/shops/:id/undelete', 'SHOPS', 'id'],
  ['DELETE', '/admin/shops/:id', 'SHOPS', 'id'],
  ['DELETE', '/admin/shops/categories/:id', 'SHOPSCATEGORIES', 'id'],
  ['PUT', '/admin/shops/:shopId/menus/categories', 'MENUSCATEGORIES'],
  ['PUT', '/admin/shops/:shopId/menus/:menuId', 'MENUS', 'menuId'],
  ['POST', '/admin/shops/:id/menus', 'MENUS'],
  ['POST', '/admin/shops/:id/menus/categories', 'MENUSCATEGORIES'],
  ['DELETE', '/admin/shops/:shopId/menus/categories/:categoryId', 'MENUSCATEGORIES', 'categoryId'],
  ['DELETE', '/admin/shops/:shopId/menus/:menuId', 'MENUS', 'menuId'],
  ['PUT', '/admin/shops/reviews/:id', 'REVIEWS', 'id'],
  ['DELETE', '/admin/shops/reviews/:id', 'REVIEWS', 'id'],
  ['DELETE', '/admin/users/:id', 'USERS', 'id'],
  ['POST', '/admin/users/:id/undelete', 'USERS', 'id'],
  ['POST', '/admin/version/:type', 'VERSION'],
];

const policies = auditRoutes.map(([method, path, domain, idParam]) => {
  const parameters: string[] = [];
  const pattern = path
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return part;
      parameters.push(part.slice(1));
      return part === ':type' ? '([^/]+)' : '([+-]?\\d+)';
    })
    .join('/');
  return {
    method,
    domain,
    expression: new RegExp(`^${pattern}$`),
    idGroup: idParam ? parameters.indexOf(idParam) + 1 : 0,
  };
});

export function matchAdminActivity(
  method: string,
  path: string,
): { domain: AuditDomain; domainId: number | null } | null {
  for (const policy of policies) {
    if (policy.method !== method) continue;
    const match = policy.expression.exec(path);
    if (match) return { domain: policy.domain, domainId: policy.idGroup ? Number(match[policy.idGroup]) : null };
  }
  return null;
}

const delegatedRequests = new WeakSet<Context<ApiEnv>>();
const recordedRequests = new WeakSet<Context<ApiEnv>>();
const requestBodies = new WeakMap<Context<ApiEnv>, string>();

/** Coordinator로 위임한 외부 요청은 내부 요청이 기록하므로 중복 기록하지 않는다. */
export function markAdminActivityDelegated(c: Context<ApiEnv>): void {
  delegatedRequests.add(c);
}

export async function recordAdminActivity(
  c: Context<ApiEnv>,
  domain: AuditDomain,
  domainId: number | null = null,
  requestMessage?: string,
): Promise<void> {
  if (recordedRequests.has(c) || delegatedRequests.has(c)) return;
  const admin = requirePrincipal(c, ['ADMIN']);
  const method = c.req.method as AuditMethod;
  if (!(method in auditMethods)) throw new TypeError(`Unsupported admin activity method: ${method}`);
  await c
    .get('db')
    .insert(schema.admins_activity_history)
    .values({
      admin_id: admin.id,
      domain_id: domainId,
      domain_name: domain,
      request_method: method,
      request_message: requestMessage ?? requestBodies.get(c) ?? (await c.req.text()),
    });
  recordedRequests.add(c);
}

/** DB·인증 미들웨어 다음, 도메인 라우트 이전에 등록한다. 성공한 변경 요청만 기록한다. */
export const adminActivityMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const policy = matchAdminActivity(c.req.method, c.req.path);
  if (!policy) {
    await next();
    return;
  }
  const body = c.req.header('content-type')?.startsWith('multipart/form-data') ? '' : await c.req.raw.clone().text();
  requestBodies.set(c, body);
  await next();
  if (!c.error && c.res.status < 400) await recordAdminActivity(c, policy.domain, policy.domainId, body);
};

function enumParameter<T extends Record<string, string>>(
  value: string | undefined,
  values: T,
  name: string,
): keyof T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!Object.hasOwn(values, value))
    throw new ApiError(400, 'ILLEGAL_ARGUMENT', `Failed to convert value '${value}' for parameter '${name}'`);
  return value;
}

const historySelection = {
  id: schema.admins_activity_history.id,
  domain_id: schema.admins_activity_history.domain_id,
  name: schema.users.name,
  domain_name: schema.admins_activity_history.domain_name,
  request_method: schema.admins_activity_history.request_method,
  request_message: schema.admins_activity_history.request_message,
  created_at: schema.admins_activity_history.created_at,
};

type HistoryRow = {
  id: number;
  domain_id: number | null;
  name: string | null;
  domain_name: string;
  request_method: string;
  request_message: string | null;
  created_at: string;
};

function historyResponse(row: HistoryRow) {
  return {
    ...row,
    domain_name: auditDomains[row.domain_name as AuditDomain],
    request_method: auditMethods[row.request_method as AuditMethod],
    created_at: kstTimestamp(row.created_at),
  };
}

export function registerHistory(app: Hono<ApiEnv>): void {
  app.get('/admin/histories', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const method = enumParameter(c.req.query('requestMethod'), auditMethods, 'requestMethod');
    const domain = enumParameter(c.req.query('domainName'), auditDomains, 'domainName');
    const domainId = integerParameter(c.req.query('domainId'), 'domainId');
    const sort = enumParameter(c.req.query('sort'), { CREATED_AT_ASC: 'ASC', CREATED_AT_DESC: 'DESC' }, 'sort');
    const filter = and(
      method === undefined ? undefined : eq(schema.admins_activity_history.request_method, method),
      domain === undefined ? undefined : eq(schema.admins_activity_history.domain_name, domain),
      domainId === undefined ? undefined : eq(schema.admins_activity_history.domain_id, domainId),
    );
    const [{ total: globalTotal }] = await db.select({ total: count() }).from(schema.admins_activity_history);
    const paging = pagination(
      integerParameter(c.req.query('page'), 'page'),
      integerParameter(c.req.query('limit'), 'limit'),
      globalTotal!,
    );
    const [{ total }] = await db.select({ total: count() }).from(schema.admins_activity_history).where(filter);
    const rows = await db
      .select(historySelection)
      .from(schema.admins_activity_history)
      .innerJoin(schema.admins, eq(schema.admins_activity_history.admin_id, schema.admins.user_id))
      .innerJoin(schema.users, eq(schema.admins.user_id, schema.users.id))
      .where(filter)
      .orderBy(
        sort === 'CREATED_AT_ASC'
          ? asc(schema.admins_activity_history.created_at)
          : desc(schema.admins_activity_history.created_at),
      )
      .limit(paging.limit)
      .offset(paging.offset);
    return c.json({
      total_count: total,
      current_count: rows.length,
      total_page: Math.ceil(total! / paging.limit),
      current_page: paging.current_page,
      histories: rows.map(historyResponse),
    });
  });
  app.get('/admin/history/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = requiredInteger(c.req.param('id'), 'id');
    const [row] = await c
      .get('db')
      .select(historySelection)
      .from(schema.admins_activity_history)
      .innerJoin(schema.admins, eq(schema.admins_activity_history.admin_id, schema.admins.user_id))
      .innerJoin(schema.users, eq(schema.admins.user_id, schema.users.id))
      .where(eq(schema.admins_activity_history.id, id))
      .limit(1);
    if (!row) throw legacyError(404, `admin_activity_history id: ${id}`, 'null');
    return c.json(historyResponse(row));
  });
}
