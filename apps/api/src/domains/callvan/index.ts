import type { Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import { registerMessages } from '@api/domains/callvan/messages';
import { registerPosts } from '@api/domains/callvan/posts';
import { registerReports } from '@api/domains/callvan/reports';

export { handleCallvanJob, runCallvanCron } from '@api/domains/callvan/jobs';

export function registerCallvan(app: Hono<ApiEnv>): void {
  registerPosts(app);
  registerMessages(app);
  registerReports(app);
}
