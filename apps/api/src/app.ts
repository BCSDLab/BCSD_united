import { captureError } from '@koin/telemetry/runtime';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { authenticate } from '@api/auth';
import { coordinateRequest } from '@api/coordination';
import { createDatabase } from '@api/db/client';
import { registerAcademic } from '@api/domains/academic';
import { registerCallvan } from '@api/domains/callvan';
import { registerClubs } from '@api/domains/clubs';
import { registerCommerce } from '@api/domains/commerce';
import { registerCommunity } from '@api/domains/community';
import { registerDining } from '@api/domains/dining';
import { adminActivityMiddleware, registerExperiments } from '@api/domains/experiments';
import { registerIdentity } from '@api/domains/identity';
import { registerMisc } from '@api/domains/misc';
import { registerTeam } from '@api/domains/team';
import { registerTransport } from '@api/domains/transport';
import { registerUploads } from '@api/domains/uploads';
import { ApiError, errorResponse } from '@api/errors';
import { registerOpenApi } from '@api/openapi';
import { registerSourceSync } from '@api/source-sync';
import type { ApiEnv } from '@api/runtime';

const app = new Hono<ApiEnv>();

function allowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  const origins: unknown = value.trim().startsWith('[') ? JSON.parse(value) : value.split(',');
  if (!Array.isArray(origins) || !origins.every((entry) => typeof entry === 'string')) {
    throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '허용 출처 설정이 올바르지 않습니다.');
  }

  return origins.map((entry: string) => entry.trim());
}

app.use(
  '*',
  cors({
    origin: (origin, c) => (allowedOrigins(c.env.AUTH_ALLOWED_ORIGINS).includes(origin) ? origin : undefined),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Access_History_Id', 'X-Koin-Service-Token'],
    exposeHeaders: ['Location'],
  }),
);

app.get('/health', (c) =>
  c.json(
    {
      status: 'ok',
      service: 'koin-api',
      environment: c.env.ENVIRONMENT,
      release: c.env.NEXT_PUBLIC_SENTRY_RELEASE ?? 'unknown',
    },
    200,
    { 'Cache-Control': 'no-store' },
  ),
);

registerOpenApi(app);
registerSourceSync(app);

app.use('*', async (c, next) => {
  c.set('db', createDatabase(c.env.DB));
  c.set('principal', await authenticate(c));
  await next();
});
app.use('*', adminActivityMiddleware);
app.use('*', async (c, next) => {
  const principal = c.get('principal');
  const path = c.req.path;
  const academic = /^\/(?:v[23]\/)?(?:timetables?|timetable-frames|timetable-lectures|graduation)(?:\/|$)/.test(path);
  const writes =
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) ||
    path === '/timetables' ||
    path === '/graduation/course/calculation';
  if (principal && academic && writes) {
    const response = await coordinateRequest(c, 'academic:' + principal.id);
    if (response) return response;
  }
  await next();
});

registerIdentity(app);
registerCommerce(app);
registerTeam(app);
registerCallvan(app);
registerCommunity(app);
registerAcademic(app);
registerTransport(app);
registerDining(app);
registerClubs(app);
registerMisc(app);
registerExperiments(app);
registerUploads(app);

app.notFound(() => errorResponse(new ApiError(404, 'NOT_FOUND', '요청한 경로를 찾을 수 없습니다.')));
app.onError((error) => {
  if (error instanceof ApiError) return errorResponse(error);
  if (error instanceof ZodError) {
    return errorResponse(
      new ApiError(
        400,
        'INVALID_REQUEST_BODY',
        '요청 값이 올바르지 않습니다.',
        error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message, constraint: issue.code })),
      ),
    );
  }
  if (error instanceof HTTPException) return error.getResponse();
  const unique = /UNIQUE constraint failed: users\.(user_id|email|phone_number|nickname)/.exec(error.message);
  if (unique) {
    const codes: Record<string, string> = {
      user_id: 'DUPLICATE_LOGIN_ID',
      email: 'DUPLICATE_EMAIL',
      phone_number: 'DUPLICATE_PHONE_NUMBER',
      nickname: 'DUPLICATE_NICKNAME',
    };
    return errorResponse(new ApiError(409, codes[unique[1]!]!, '이미 사용 중인 회원 정보입니다.'));
  }
  if (error.message.includes('identity_atomic_guards')) {
    return errorResponse(
      new ApiError(409, 'OPTIMISTIC_LOCKING_FAILURE', '다른 요청으로 정보가 변경되었습니다. 다시 시도해주세요.'),
    );
  }
  captureError(error);
  return errorResponse(new ApiError(500, 'INTERNAL_SERVER_ERROR', '서버 오류가 발생했습니다.'));
});

export default app;
