import type { SlackAction, SlackShortcut, ViewSubmitAction } from '@slack/bolt';
import { blockActions } from '~/services/slack/registry/blockActions';
import { shortcuts } from '~/services/slack/registry/shortcuts';
import { viewActions } from '~/services/slack/registry/viewActions';
import { enqueueSlackJob, withoutSlackCredentials } from '~/services/slack/jobs';
import { assertSlackRequest } from '~/utils/slackRequest';

type Interaction = SlackAction | SlackShortcut | ViewSubmitAction;

export default defineEventHandler(async (event) => {
  await assertSlackRequest(event);
  if (!getHeader(event, 'content-type')?.includes('application/x-www-form-urlencoded')) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }
  const form = await readBody<{ payload: string }>(event);
  const body = JSON.parse(form.payload) as Interaction;
  if (body.type === 'block_actions') {
    if (body.actions.some((action) => blockActions.some((setting) => setting.actionId === action.action_id))) {
      await enqueueSlackJob(event, { type: 'block_actions', body: withoutSlackCredentials(body) });
    }
    return { ok: true };
  }
  if (body.type === 'message_action') {
    const target = shortcuts.find((shortcut) => shortcut.key === body.callback_id);
    if (!target) {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
    }
    if (target.execution === 'queue') {
      await enqueueSlackJob(event, { type: 'shortcut', body: withoutSlackCredentials(body) });
    } else {
      // Modal triggers expire after three seconds and cannot wait for queue delivery.
      await target.handler({ client: event.context.slackWebClient, shortcut: body, context: event.context });
    }
  } else if (body.type === 'view_submission') {
    const target = viewActions.find((setting) => setting.actionId === body.view.callback_id);
    if (!target) {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
    }
    await enqueueSlackJob(event, { type: 'view_submission', body: withoutSlackCredentials(body) });
  }
});
