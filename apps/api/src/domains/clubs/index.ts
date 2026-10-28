import type { Hono } from 'hono';
import { coordinateRequest } from '@api/coordination';
import type { ApiEnv } from '@api/runtime';
import { registerAdminClubs } from '@api/domains/clubs/admin';
import { registerCatalog } from '@api/domains/clubs/catalog';
import { registerEvents } from '@api/domains/clubs/events';
import { registerQna } from '@api/domains/clubs/qna';
import { registerRecruitment } from '@api/domains/clubs/recruitment';

export { handleClubsJob, runClubsCron } from '@api/domains/clubs/jobs';

export function registerClubs(app: Hono<ApiEnv>): void {
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && /^\/(?:admin\/)?clubs(?:\/|$)/.test(c.req.path)) {
      const response = await coordinateRequest(c, 'clubs');
      if (response) return response;
    }
    await next();
  });
  registerCatalog(app);
  registerQna(app);
  registerRecruitment(app);
  registerEvents(app);
  registerAdminClubs(app);
}
