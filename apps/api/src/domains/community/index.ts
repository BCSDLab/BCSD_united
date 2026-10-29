import type { Hono } from 'hono';
import type { ApiEnv, Bindings } from '@api/runtime';
import type { Job } from '@api/jobs';
import { registerCommunityArticles } from '@api/domains/community/articles';
import { registerCommunityLostItems } from '@api/domains/community/lost-items';
import { registerCommunityKeywords } from '@api/domains/community/keywords';
import { registerCommunityNotices } from '@api/domains/community/notices';
import { registerCommunityChat, handleCommunityChatJob, runCommunityChatCron } from '@api/domains/community/chat';
import {
  registerCommunitySummary,
  handleCommunitySummaryJob,
  runCommunitySummaryCron,
} from '@api/domains/community/summary';
import { handleCommunityOutboxJob, runCommunityMaintenanceCron } from '@api/domains/community/jobs';

export function registerCommunity(app: Hono<ApiEnv>): void {
  registerCommunityKeywords(app);
  registerCommunityLostItems(app);
  registerCommunityNotices(app);
  registerCommunitySummary(app);
  registerCommunityChat(app);
  registerCommunityArticles(app);
}
export async function handleCommunityJob(env: Bindings, job: Job): Promise<boolean> {
  return (
    (await handleCommunityOutboxJob(env, job)) ||
    (await handleCommunityChatJob(env, job)) ||
    (await handleCommunitySummaryJob(env, job))
  );
}
export async function runCommunityCron(env: Bindings, scheduledTime: number): Promise<void> {
  await Promise.all([
    runCommunityMaintenanceCron(env, scheduledTime),
    runCommunityChatCron(env, scheduledTime),
    runCommunitySummaryCron(env, scheduledTime),
  ]);
}
export { CommunityChatDurableObject } from '@api/domains/community/stomp';
