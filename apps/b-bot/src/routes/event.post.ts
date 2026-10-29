import type { SlackEvent } from '@slack/web-api';
import { readUserMessage } from '~/services/slack/incomingMessage';
import { enqueueSlackJob } from '~/services/slack/jobs';
import { assertSlackRequest } from '~/utils/slackRequest';

type Body =
  | {
      type: 'event_callback';
      event: SlackEvent;
    }
  | {
      type: 'url_verification';
      challenge?: string;
    };

export default defineEventHandler(async (event) => {
  await assertSlackRequest(event);
  const body = await readBody<Body>(event);
  if (body.type === 'url_verification') {
    return body.challenge ? { challenge: body.challenge } : undefined;
  }

  if (body.event.type === 'reaction_added' || body.event.type === 'reaction_removed') {
    await enqueueSlackJob(event, { type: 'reaction', event: body.event });
    return { ok: true };
  }
  if (body.event.type !== 'message' || body.event.channel_type !== 'channel') {
    return 'not Implemented';
  }
  const message = readUserMessage(body.event);
  if (message?.text) {
    await enqueueSlackJob(event, { type: 'message', message });
  }
  return { ok: true };
});
