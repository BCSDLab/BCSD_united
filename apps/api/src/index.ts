import { withSentry, captureException } from '@sentry/cloudflare';
import app from '@api/app';
import { handleCallvanJob, runCallvanCron } from '@api/domains/callvan';
import { handleClubsJob, runClubsCron } from '@api/domains/clubs';
import { handleCommerceJob, runCommerceCron } from '@api/domains/commerce';
import { handleCommunityJob, runCommunityCron } from '@api/domains/community';
import { handleDiningJob, runDiningCron } from '@api/domains/dining';
import { runExperimentsCron } from '@api/domains/experiments';
import { handleIdentityJob, runIdentityCron } from '@api/domains/identity';
import { handleMiscJob, runMiscCron } from '@api/domains/misc';
import { handleTeamJob, runTeamCron } from '@api/domains/team';
import { runTransportCron } from '@api/domains/transport';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';

export { Coordinator } from '@api/coordinator';
export { CommunityChatDurableObject } from '@api/domains/community';

const jobHandlers = [handleIdentityJob, handleCommerceJob, handleTeamJob, handleCallvanJob, handleCommunityJob, handleDiningJob, handleClubsJob, handleMiscJob];
const schedules = [runIdentityCron, runCommerceCron, runTeamCron, runCallvanCron, runCommunityCron, runDiningCron, runClubsCron, runMiscCron, runExperimentsCron, runTransportCron];

const worker: ExportedHandler<Bindings, Job> = {
  fetch: (request, env, context) => app.fetch(request, env, context),
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        let handled = false;
        for (const handler of jobHandlers) {
          if (await handler(env, message.body)) { handled = true; break; }
        }
        if (!handled) throw new Error('Unknown queued job kind: ' + message.body.kind);
        message.ack();
      } catch (error) {
        captureException(error);
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  async scheduled(event, env) {
    const results = await Promise.allSettled(schedules.map((schedule) => schedule(env, event.scheduledTime)));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Scheduled API work failed');
  },
};

export default withSentry((env: Bindings) => ({
  dsn: env.NEXT_PUBLIC_SENTRY_DSN,
  environment: env.ENVIRONMENT,
  release: env.NEXT_PUBLIC_SENTRY_RELEASE,
  tracesSampleRate: 1,
  dataCollection: {
    cookies: false,
    httpHeaders: { request: { deny: ['authorization', 'cookie', 'x-csrf-token'] }, response: { deny: ['set-cookie'] } },
  },
}), worker);
