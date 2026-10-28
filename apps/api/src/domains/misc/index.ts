import type { Hono } from 'hono';
import { coordinateRequest } from '@api/coordination';
import type { ApiEnv } from '@api/runtime';
import { registerBanners } from '@api/domains/misc/banners';
import { registerKakao } from '@api/domains/misc/kakao';
import { registerLands } from '@api/domains/misc/lands';
import { registerNotifications } from '@api/domains/misc/notifications';
import { registerVersions } from '@api/domains/misc/versions';

export { handleMiscJob, runMiscCron, deliverNotification } from '@api/domains/misc/notifications';

export function registerMisc(app: Hono<ApiEnv>): void {
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      let key: string | null = null;
      if (/^\/admin\/banners(?:\/|$)/.test(c.req.path)) key = 'catalog:banner';
      else if (/^\/admin\/version\//.test(c.req.path)) key = `catalog:version:${c.req.path.split('/')[3]?.toLowerCase()}`;
      else if (/^\/notification(?:\/|$)/.test(c.req.path) && c.get('principal')) key = `notification:user:${c.get('principal')!.id}`;
      if (key) {
        const response = await coordinateRequest(c, key);
        if (response) return response;
      }
    }
    await next();
  });
  registerLands(app);
  registerVersions(app);
  registerBanners(app);
  registerNotifications(app);
  registerKakao(app);
}
