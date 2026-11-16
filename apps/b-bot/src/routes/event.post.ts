import type { SlackEvent } from '@slack/web-api';
import { forwardAutofixMention, isAutofixMention, type AutomationBinding } from '~/services/slack/autofix';
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

  if (body.event.type === 'app_mention') {
    if (!isAutofixMention(body.event.text)) return { ok: true };
    const binding = event.context.cloudflare?.env?.ERROR_AUTOMATION as AutomationBinding | undefined;
    await forwardAutofixMention(
      binding,
      (await readRawBody(event, 'utf-8')) ?? '',
      getHeader(event, 'x-slack-signature'),
      getHeader(event, 'x-slack-request-timestamp'),
    );
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
