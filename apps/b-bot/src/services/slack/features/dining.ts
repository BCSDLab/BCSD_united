import type { BlockAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { decideReport, type Decision } from '~/services/dining/decision';
import { resolveDiningAuth } from '~/services/dining/diningApi';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from '~/services/dining/render';
import { envOfChannel } from '~/services/dining/worker';
import type { BlockActionSetting } from '~/services/slack/types';

async function handleDiningDecision(
  decision: Decision,
  { client, body, action }: { client: WebClient; body: BlockAction; action: BlockAction['actions'][number] },
) {
  if (action.type !== 'button' || !body.channel) return;
  const channel = body.channel.id;

  const env = envOfChannel(channel);
  if (!env) return;

  const reply = (text: string) => client.chat.postEphemeral({ channel, user: body.user.id, text });

  const auth = resolveDiningAuth(env);
  if (!auth) {
    await reply('서버에 식단 품절 제보 연동 설정이 없어 처리할 수 없어요.');
    return;
  }

  const { report_id: reportId } = JSON.parse(action.value ?? '{}') as { report_id?: number };
  if (!reportId) return;

  const actor = {
    workspace_id: body.team?.id ?? body.user.team_id ?? '',
    user_id: body.user.id,
    display_name: await displayName(client, body.user),
  };
  const result = await decideReport(decision, reportId, actor, auth);
  await reply(result);
}

async function displayName(client: WebClient, user: BlockAction['user']): Promise<string> {
  const fallback = user.name || user.username || user.id;
  try {
    const { user: info } = await client.users.info({ user: user.id });
    return (info?.profile?.display_name || info?.profile?.real_name || fallback).slice(0, 80);
  } catch {
    return fallback.slice(0, 80);
  }
}

export const diningActions: BlockActionSetting[] = [
  { actionId: APPROVE_ACTION_ID, handler: (args) => handleDiningDecision('approve', args) },
  { actionId: REJECT_ACTION_ID, handler: (args) => handleDiningDecision('reject', args) },
];
