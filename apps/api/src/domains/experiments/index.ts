import { sql } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { requirePrincipal } from '@api/auth';
import { coordinateRequest } from '@api/coordination';
import { schema } from '@api/db/schema';
import {
  integerParameter, kstTimestamp, pagination, parseExperimentRequest, requestObject, requestString, requiredInteger,
} from '@api/domains/experiments/algorithms';
import { registerHistory } from '@api/domains/experiments/audit';
import {
  assignExperiment, closeExperiment, createExperiment, deleteExperiment, experimentResponse, getExperiment,
  issueAccessHistory, moveExperiment, requireExistingUser, updateExperiment,
} from '@api/domains/experiments/service';
import { parseDeviceMetadata } from '@api/domains/experiments/user-agent';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';

export { adminActivityMiddleware, markAdminActivityDelegated, recordAdminActivity } from '@api/domains/experiments/audit';
export { runExperimentsCron } from '@api/domains/experiments/service';

async function requestBody(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  try { return requestObject(await c.req.json()); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'NOT_READABLE_HTTP_MESSAGE', 'JSON 요청 본문을 읽을 수 없습니다.');
  }
}

const coordinate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const response = await coordinateRequest(c, 'experiments');
  if (response) return response;
  await next();
};
const admin: MiddlewareHandler<ApiEnv> = async (c, next) => { requirePrincipal(c, ['ADMIN']); await next(); };

export function registerExperiments(app: Hono<ApiEnv>): void {
  registerHistory(app);

  app.post('/abtest', admin, coordinate, async (c) => c.json(await createExperiment(c.get('db'), parseExperimentRequest(await requestBody(c)))));
  app.put('/abtest/:id', admin, coordinate, async (c) => c.json(await updateExperiment(c.get('db'),
    requiredInteger(c.req.param('id'), 'id'), parseExperimentRequest(await requestBody(c)))));
  app.delete('/abtest/:id', admin, coordinate, async (c) => {
    await deleteExperiment(c.get('db'), requiredInteger(c.req.param('id'), 'id'));
    return c.body(null, 204);
  });
  app.post('/abtest/close/:id', admin, coordinate, async (c) => {
    const request = await requestBody(c);
    const name = requestString(request, 'winner_name', '승자 이름은 필수입니다.', '승자 이름은 1자 이상 255자 이하로 입력해주세요.');
    await closeExperiment(c.get('db'), requiredInteger(c.req.param('id'), 'id'), name);
    return c.body(null, 200);
  });
  app.post('/abtest/:id/move', admin, coordinate, async (c) => {
    const request = await requestBody(c);
    if (request.device_id === null || request.device_id === undefined) {
      throw new ApiError(400, 'INVALID_REQUEST_BODY', '디바이스 ID는 필수입니다.', [{ field: 'device_id', message: '디바이스 ID는 필수입니다.', constraint: 'NotNull' }]);
    }
    if (typeof request.device_id !== 'number' || !Number.isInteger(request.device_id)) {
      throw new ApiError(400, 'NOT_READABLE_HTTP_MESSAGE', '디바이스 ID는 정수여야 합니다.');
    }
    const deviceId = requiredInteger(String(request.device_id), 'device_id');
    const name = requestString(request, 'variable_name', '실험군 변수명은 필수입니다.', '실험군 변수명은 1자 이상 255자 이하로 입력해주세요.');
    await moveExperiment(c.get('db'), requiredInteger(c.req.param('id'), 'id'), deviceId, name);
    return c.body(null, 200);
  });
  app.post('/abtest/assign/token', coordinate, async (c) => {
    const id = await issueAccessHistory(c.get('db'), c.get('principal')?.id ?? null, parseDeviceMetadata(c.req.header('user-agent')));
    return c.json({ accessHistoryId: id });
  });
  app.post('/abtest/assign', coordinate, async (c) => {
    const request = await requestBody(c);
    const title = requestString(request, 'title', '실험 변수명은 필수입니다.', '실험 변수명은 1자 이상 255자 이하로 입력해주세요.');
    return c.json(await assignExperiment(c.get('db'), title, integerParameter(c.req.header('access_history_id'), 'access_history_id'),
      c.get('principal')?.id ?? null, parseDeviceMetadata(c.req.header('user-agent'))));
  });

  app.get('/abtest', admin, async (c) => {
    const db = c.get('db');
    const count = await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM ${schema.abtest}`);
    const total = count?.total ?? 0;
    const page = pagination(integerParameter(c.req.query('page'), 'page'), integerParameter(c.req.query('limit'), 'limit'), total);
    const rows = await db.all<typeof schema.abtest.$inferSelect>(sql`SELECT * FROM ${schema.abtest} ORDER BY id DESC LIMIT ${page.limit} OFFSET ${page.offset}`);
    return c.json({ tests: await Promise.all(rows.map((row) => experimentResponse(db, row, false))),
      total_count: total, current_count: rows.length, total_page: Math.ceil(total / page.limit), current_page: page.current_page });
  });
  app.get('/abtest/user', admin, async (c) => {
    const name = c.req.query('name');
    if (name === undefined) throw new ApiError(400, 'MISSING_REQUEST_PARAMETER', "Required request parameter 'name' is not present");
    const users = await c.get('db').all<{ id: number; name: string | null; detail: string | null }>(sql`
      SELECT id, name, CASE WHEN user_type = 'OWNER' THEN phone_number ELSE email END AS detail
      FROM ${schema.users} WHERE name = ${name} ORDER BY id`);
    return c.json({ users });
  });
  app.get('/abtest/user/:userId/device', admin, async (c) => {
    const db = c.get('db');
    const userId = requiredInteger(c.req.param('userId'), 'userId');
    await requireExistingUser(db, userId);
    const devices = await db.all<{ id: number; type: string | null; model: string | null; last_accessed_at: string | null }>(sql`
      SELECT d.id, d.type, d.model, a.last_accessed_at FROM ${schema.device} d
      LEFT JOIN ${schema.access_history} a ON a.device_id = d.id WHERE d.user_id = ${userId} ORDER BY d.id`);
    return c.json({ devices: devices.map((device) => ({ ...device, last_accessed_at: kstTimestamp(device.last_accessed_at)?.slice(0, 10) ?? null })) });
  });
  app.get('/abtest/:id', admin, async (c) => c.json(await experimentResponse(c.get('db'),
    await getExperiment(c.get('db'), requiredInteger(c.req.param('id'), 'id')))));
}
