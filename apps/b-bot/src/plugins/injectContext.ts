import { WebClient } from '@slack/web-api';
import { getPool } from '~/infra/postgres';

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    event.context.slackWebClient = new WebClient(process.env.SLACK_BOT_TOKEN, {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 10_000,
    });
    Object.defineProperty(event.context, 'sqlPool', {
      configurable: true,
      get: getPool,
    });
  });
});
