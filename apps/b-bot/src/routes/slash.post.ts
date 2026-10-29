import { commands } from '~/services/slack/registry/commands';
import type { Command } from '~/services/slack/types';
import { enqueueSlackJob, withoutSlackCredentials } from '~/services/slack/jobs';
import { assertSlackRequest } from '~/utils/slackRequest';

export default defineEventHandler(async (event) => {
  await assertSlackRequest(event);
  if (!getHeader(event, 'content-type')?.includes('application/x-www-form-urlencoded')) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }
  const body = await readBody<Command>(event);
  const target = commands.find((command) => command.command === body.command);
  if (!target) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }
  if (target.execution === 'queue') {
    await enqueueSlackJob(event, { type: 'command', command: withoutSlackCredentials(body) });
    return;
  }
  await target.handler({
    client: event.context.slackWebClient,
    command: body,
    googleClient: event.context.googleClient,
  });
});
