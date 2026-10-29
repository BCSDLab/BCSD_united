import { WebClient } from '@slack/web-api';
import type { SlackJob } from '~/services/slack/jobs';
import { processSlackJob } from '~/services/slack/processJob';

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch, env }) => {
    if (
      !env ||
      typeof env !== 'object' ||
      !('SLACK_BOT_TOKEN' in env) ||
      typeof env.SLACK_BOT_TOKEN !== 'string' ||
      !env.SLACK_BOT_TOKEN
    ) {
      throw new Error('SLACK_BOT_TOKEN is required for Slack jobs');
    }
    const client = new WebClient(env.SLACK_BOT_TOKEN);
    for (const message of batch.messages) {
      try {
        await processSlackJob(message.body as SlackJob, client);
        message.ack();
      } catch (error) {
        console.error('Slack queue dispatch failed:', error);
        message.retry();
      }
    }
  });
});
