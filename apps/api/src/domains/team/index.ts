import type { Context, Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { coordinateRequest } from '@api/coordination';
import type { ApiEnv } from '@api/runtime';
import { registerTeamChat, signalTeamNotifications } from '@api/domains/team/chat';
import {
  applicationDetail,
  closeRecruitment,
  createApplication,
  createRecruitment,
  decideApplication,
  detail,
  getProfile,
  listApplications,
  listRecruitments,
  updateRecruitment,
  upsertProfile,
} from '@api/domains/team/core';
import { fail } from '@api/domains/team/policy';
export { handleTeamJob, runTeamCron } from '@api/domains/team/jobs';

function id(c: Context<ApiEnv>, name = 'recruitmentId') {
  const input = c.req.param(name) ?? '';
  const value = Number(input);
  if (!/^-?\d+$/.test(input) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    fail('INVALID_REQUEST_BODY');
  return value;
}
function query(c: Context<ApiEnv>) {
  return {
    ...c.req.query(),
    categories: c.req.queries('categories')?.join(','),
    statuses: c.req.queries('statuses')?.join(','),
  };
}
export function registerTeam(app: Hono<ApiEnv>): void {
  registerTeamChat(app);
  app.get('/team-recruitment-profiles/me', async (c) =>
    c.json(await getProfile(c.get('db'), requirePrincipal(c, ['STUDENT']).id)),
  );
  app.put('/team-recruitment-profiles/me', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const coordinated = await coordinateRequest(c, `team-user:${userId}`);
    if (coordinated) return coordinated;
    return c.json(await upsertProfile(c.get('db'), userId, await c.req.json()));
  });
  app.get('/team-recruitments/me/created', async (c) =>
    c.json(await listRecruitments(c.get('db'), query(c), requirePrincipal(c, ['STUDENT']).id)),
  );
  app.get('/team-recruitments/me/applications', async (c) =>
    c.json(await listApplications(c.get('db'), query(c), requirePrincipal(c, ['STUDENT']).id)),
  );
  app.get('/team-recruitments', async (c) => c.json(await listRecruitments(c.get('db'), query(c))));
  app.post('/team-recruitments', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const coordinated = await coordinateRequest(c, `team-user:${userId}`);
    if (coordinated) return coordinated;
    const result = await createRecruitment(c.get('db'), userId, await c.req.json());
    c.executionCtx.waitUntil(signalTeamNotifications(c.env, result.id));
    return c.json(result, 201);
  });
  app.get('/team-recruitments/:recruitmentId', async (c) =>
    c.json(await detail(c.get('db'), id(c), c.get('principal')?.id ?? null)),
  );
  app.put('/team-recruitments/:recruitmentId', async (c) => {
    const coordinated = await coordinateRequest(c, `team:${id(c)}`);
    if (coordinated) return coordinated;
    const result = await updateRecruitment(c.get('db'), id(c), requirePrincipal(c, ['STUDENT']).id, await c.req.json());
    c.executionCtx.waitUntil(signalTeamNotifications(c.env, id(c)));
    return c.json(result);
  });
  app.delete('/team-recruitments/:recruitmentId', async (c) => {
    const coordinated = await coordinateRequest(c, `team:${id(c)}`);
    if (coordinated) return coordinated;
    await closeRecruitment(c.get('db'), id(c), requirePrincipal(c, ['STUDENT']).id, true);
    c.executionCtx.waitUntil(signalTeamNotifications(c.env, id(c)));
    return c.body(null, 204);
  });
  app.put('/team-recruitments/:recruitmentId/close', async (c) => {
    const coordinated = await coordinateRequest(c, `team:${id(c)}`);
    if (coordinated) return coordinated;
    await closeRecruitment(c.get('db'), id(c), requirePrincipal(c, ['STUDENT']).id);
    c.executionCtx.waitUntil(signalTeamNotifications(c.env, id(c)));
    return c.body(null, 204);
  });
  app.post('/team-recruitments/:recruitmentId/applications', async (c) => {
    const coordinated = await coordinateRequest(c, `team:${id(c)}`);
    if (coordinated) return coordinated;
    const result = await createApplication(c.get('db'), id(c), requirePrincipal(c, ['STUDENT']).id, await c.req.json());
    c.executionCtx.waitUntil(signalTeamNotifications(c.env, id(c)));
    return c.json(result, 201);
  });
  app.get('/team-recruitments/:recruitmentId/applications', async (c) =>
    c.json(await listApplications(c.get('db'), query(c), requirePrincipal(c, ['STUDENT']).id, id(c))),
  );
  app.get('/team-recruitments/:recruitmentId/applications/:applicationId', async (c) =>
    c.json(await applicationDetail(c.get('db'), id(c), id(c, 'applicationId'), requirePrincipal(c, ['STUDENT']).id)),
  );
  app.put('/team-recruitments/:recruitmentId/applications/:applicationId/status', async (c) => {
    const coordinated = await coordinateRequest(c, `team:${id(c)}`);
    if (coordinated) return coordinated;
    await decideApplication(
      c.get('db'),
      id(c),
      id(c, 'applicationId'),
      requirePrincipal(c, ['STUDENT']).id,
      await c.req.json(),
    );
    c.executionCtx.waitUntil(signalTeamNotifications(c.env, id(c)));
    return c.body(null, 204);
  });
}
