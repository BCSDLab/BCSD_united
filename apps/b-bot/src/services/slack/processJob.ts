import type { BlockAction, SlackShortcut, ViewSubmitAction } from '@slack/bolt';
import type { ReactionAddedEvent, ReactionRemovedEvent, WebClient } from '@slack/web-api';
import { setFeedback } from '~/services/rag';
import { matchesText, type IncomingMessage } from '~/services/slack/incomingMessage';
import type { SlackJob } from '~/services/slack/jobs';
import { blockActions } from '~/services/slack/registry/blockActions';
import { commands } from '~/services/slack/registry/commands';
import { messageFunctionList } from '~/services/slack/registry/messages';
import { shortcuts } from '~/services/slack/registry/shortcuts';
import { viewActions } from '~/services/slack/registry/viewActions';
import type { Command } from '~/services/slack/types';
import { botUserId } from '~/utils/slackBot';
import { errorMessage } from '~/utils/errorMessage';
import { sendSlackText } from '~/utils/slackFunction';

export async function processSlackJob(job: SlackJob, client: WebClient): Promise<void> {
  const context = { slackWebClient: client };
  switch (job.type) {
    case 'message':
      await processMessage(job.message, client);
      return;
    case 'reaction':
      await handleReaction(client, job.event);
      return;
    case 'block_actions': {
      // Queue-safe handlers never read the ingress-only Slack credentials or modal trigger.
      const body = job.body as BlockAction;
      for (const action of body.actions) {
        const target = blockActions.find((setting) => setting.actionId === action.action_id);
        if (!target) continue;
        try {
          await target.handler({ client, body, action, context });
        } catch (error) {
          console.error('Block action handler error:', error);
          if (body.channel?.id) {
            await client.chat
              .postEphemeral({
                channel: body.channel.id,
                user: body.user.id,
                text: `오류가 발생했어요: ${errorMessage(error)}`,
              })
              .catch(console.error);
          }
        }
      }
      return;
    }
    case 'command': {
      const target = commands.find(
        (setting) => setting.command === job.command.command && setting.execution === 'queue',
      );
      if (!target) throw new Error(`Unknown queued Slack command: ${job.command.command}`);
      try {
        await target.handler({ client, command: job.command as Command });
      } catch (error) {
        console.error('Slash command handler error:', error);
        await client.chat
          .postEphemeral({
            channel: job.command.channel_id,
            user: job.command.user_id,
            text: `오류가 발생했어요: ${errorMessage(error)}`,
          })
          .catch(console.error);
      }
      return;
    }
    case 'shortcut': {
      const target = shortcuts.find((setting) => setting.key === job.body.callback_id && setting.execution === 'queue');
      if (!target) throw new Error(`Unknown queued Slack shortcut: ${job.body.callback_id}`);
      try {
        await target.handler({ client, shortcut: job.body as SlackShortcut, context });
      } catch (error) {
        console.error('Shortcut handler error:', error);
        if ('channel' in job.body && job.body.channel) {
          await client.chat
            .postEphemeral({
              channel: job.body.channel.id,
              user: job.body.user.id,
              text: `오류가 발생했어요: ${errorMessage(error)}`,
            })
            .catch(console.error);
        }
      }
      return;
    }
    case 'view_submission': {
      const target = viewActions.find((setting) => setting.actionId === job.body.view.callback_id);
      if (!target) throw new Error(`Unknown queued Slack view: ${job.body.view.callback_id}`);
      try {
        await target.handler({ client, action: job.body as ViewSubmitAction, context });
      } catch (error) {
        console.error('View submission handler error:', error);
      }
      return;
    }
    default:
      throw new Error('Unknown Slack queue job type');
  }
}

const FEEDBACK: Record<string, number> = { '+1': 1, '-1': -1 };

async function handleReaction(client: WebClient, event: ReactionAddedEvent | ReactionRemovedEvent) {
  const value = FEEDBACK[event.reaction];
  if (value === undefined || event.item.type !== 'message') return;
  const me = await botUserId(client);
  if (me && event.user === me) return;
  await setFeedback(event.item.ts, event.type === 'reaction_added' ? value : null);
}

async function processMessage(message: IncomingMessage, client: WebClient): Promise<void> {
  const hasFiles = (message.files?.length ?? 0) > 0;
  const handlers = messageFunctionList.filter(
    (setting) => (!hasFiles || setting.acceptsFiles) && matchesText(setting, message.text),
  );
  for (const handler of handlers) {
    try {
      await handler.handler({ client, ...message });
    } catch (error) {
      console.error('Handler error:', error);
      // A domain failure is handled once: failed error notifications must not replay mutations.
      await sendSlackText({
        client,
        channel: message.channel,
        threadTs: message.ts,
        text: `오류가 발생했어요: ${errorMessage(error)}`,
      }).catch(console.error);
    }
  }
}
