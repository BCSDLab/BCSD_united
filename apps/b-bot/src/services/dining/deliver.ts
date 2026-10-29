import type { WebClient } from '@slack/web-api';
import type { KoinEnv } from '~/services/koin/target';
import * as messageStore from './messageStore';
import { renderReport, type RenderedMessage } from './render';
import type { DeliveryJob, DeliveryOutcome } from './types';

export type SlackChat = Pick<WebClient['chat'], 'postMessage' | 'update'>;
export type MessageStore = Pick<
  typeof messageStore,
  'findMessage' | 'saveMessage' | 'replaceMessage' | 'markDelivered'
>;

export interface DeliverContext {
  env: KoinEnv;
  channelId: string;
  adminUrl?: string;
  slack: SlackChat;
  store?: MessageStore;
  now?: () => number;
}

// 기한(60초)이 이만큼도 안 남았으면 슬랙 호출을 시작하지 않는다. 끝나기 전에 재배정되면 중복 전송된다.
// slack 호출(최대 10초) + 저장, 결과 통보 시간 감안
const START_MARGIN_MS = 15_000;

async function post(slack: SlackChat, channel: string, message: RenderedMessage) {
  const response = await slack.postMessage({ channel, ...message });
  if (!response.ok || !response.channel || !response.ts) {
    throw new Error(`슬랙 전송 응답에 channel/ts가 없습니다: ${response.error ?? 'unknown'}`);
  }
  return { channelId: response.channel, messageTs: response.ts };
}

interface SlackPlatformError {
  data?: { error?: string; response_metadata?: { messages?: string[] } };
}

function slackError(error: unknown): { code?: string; messages: string[] } {
  const data = (error as SlackPlatformError)?.data;
  return { code: data?.error, messages: data?.response_metadata?.messages ?? [] };
}

function isImageError(error: unknown): boolean {
  const { code, messages } = slackError(error);
  return code === 'invalid_blocks' && messages.some((message) => /image/i.test(message));
}

function isMessageGone(error: unknown): boolean {
  const { code } = slackError(error);
  return code === 'message_not_found' || code === 'cant_update_message';
}

export async function deliver(job: DeliveryJob, context: DeliverContext): Promise<DeliveryOutcome> {
  const { env, channelId, slack, store = messageStore, now = Date.now } = context;
  const reportId = job.report.report_id;

  const saved = await store.findMessage(env, reportId);
  if (saved?.last_delivery_id === job.delivery_id) {
    return 'SUCCEEDED';
  }
  if (now() > Date.parse(job.expires_at) - START_MARGIN_MS) {
    return 'FAILED';
  }

  const send = async (message: RenderedMessage) => {
    if (saved) {
      try {
        await slack.update({ channel: saved.channel_id, ts: saved.message_ts, ...message });
        await store.markDelivered(env, reportId, job.delivery_id);
        return;
      } catch (error) {
        if (!isMessageGone(error)) throw error;
      }
      const posted = await post(slack, channelId, message);
      await store.replaceMessage(env, reportId, posted, job.delivery_id);
      return;
    }
    const posted = await post(slack, channelId, message);
    await store.saveMessage(env, reportId, posted, job.delivery_id);
  };

  const options = { adminUrl: context.adminUrl };
  try {
    await send(renderReport(job.delivery_id, job.report, options));
  } catch (error) {
    if (!isImageError(error)) throw error;
    await send(renderReport(job.delivery_id, job.report, { ...options, imageUnavailable: true }));
  }
  return 'SUCCEEDED';
}
