import type { BlockAction, SlackShortcut, ViewSubmitAction } from '@slack/bolt';
import type { ReactionAddedEvent, ReactionRemovedEvent } from '@slack/web-api';
import type { H3Event } from 'h3';
import type { IncomingMessage } from '~/services/slack/incomingMessage';
import type { Command } from '~/services/slack/types';

type WithoutSlackCredentials<T> = T extends unknown
  ? Omit<T, 'token' | 'response_url' | 'response_urls' | 'trigger_id'>
  : never;

export type SlackJob =
  | { type: 'message'; message: IncomingMessage }
  | { type: 'reaction'; event: ReactionAddedEvent | ReactionRemovedEvent }
  | { type: 'block_actions'; body: WithoutSlackCredentials<BlockAction> }
  | { type: 'command'; command: WithoutSlackCredentials<Command> }
  | { type: 'shortcut'; body: WithoutSlackCredentials<SlackShortcut> }
  | { type: 'view_submission'; body: WithoutSlackCredentials<ViewSubmitAction> };

export interface SlackQueueBinding {
  send(job: SlackJob, options?: { contentType: 'json' }): Promise<void>;
}

export function withoutSlackCredentials<T extends object>(payload: T): WithoutSlackCredentials<T> {
  const body = { ...payload } as T & {
    token?: string;
    response_url?: string;
    response_urls?: unknown;
    trigger_id?: string;
  };
  delete body.token;
  delete body.response_url;
  delete body.response_urls;
  delete body.trigger_id;
  return body as unknown as WithoutSlackCredentials<T>;
}

export async function enqueueSlackJob(event: H3Event, job: SlackJob): Promise<void> {
  const queue = event.context.cloudflare?.env?.SLACK_JOBS as SlackQueueBinding | undefined;
  if (!queue) {
    throw createError({ statusCode: 503, statusMessage: 'Slack queue unavailable' });
  }
  // Only acknowledge Slack after its job is durable. A failed send must remain retryable.
  await queue.send(job, { contentType: 'json' });
}
