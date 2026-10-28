import type { Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import { registerDiningCatalog } from '@api/domains/dining/catalog';
import { registerDiningReports } from '@api/domains/dining/reports';
import { registerCoopShop } from '@api/domains/dining/coopshop';

export function registerDining(app: Hono<ApiEnv>): void {
  registerDiningReports(app);
  registerDiningCatalog(app);
  registerCoopShop(app);
}
export { handleDiningJob, runDiningCron } from '@api/domains/dining/jobs';
