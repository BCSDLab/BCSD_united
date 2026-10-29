import { setTimeout as delay } from 'node:timers/promises';
import { WebClient } from '@slack/web-api';
import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import type { KoinEnv } from '~/services/koin/target';
import { deliver } from './deliver';
import {
  claimDelivery,
  DiningApiError,
  reportDeliveryResult,
  resolveDiningAuth,
  type DiningApiAuth,
} from './diningApi';
import type { DeliveryJob, DeliveryOutcome } from './types';

const TARGET: Record<KoinEnv, { channelId?: string; adminUrl?: string }> = {
  stage: {
    channelId: CHANNEL_ID.코인_품절제보알림_stage,
    adminUrl: 'https://admin.stage.koreatech.in/sold-out-report',
  },
  prod: {
    channelId: CHANNEL_ID.코인_품절제보알림,
    adminUrl: 'https://admin.koreatech.in/sold-out-report',
  },
};

export function envOfChannel(channelId: string): KoinEnv | undefined {
  return (Object.keys(TARGET) as KoinEnv[]).find((env) => TARGET[env].channelId === channelId);
}

export const DINING_BATCH_LIMIT = 5;
const ALERT_AFTER_FAILURES = 6;

export function enabledWorkerEnvs(value: string | undefined): KoinEnv[] {
  const names = (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return (['stage', 'prod'] as const).filter((env) => names.includes(env));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { data?: { error?: string } }).data?.error;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

async function report(job: DeliveryJob, outcome: DeliveryOutcome, auth: DiningApiAuth, env: KoinEnv) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await reportDeliveryResult(job.delivery_id, job.attempt_token, outcome, auth);
      return;
    } catch (error) {
      if (error instanceof DiningApiError) {
        console.error(`[dining:${env}] 결과 통보 거절 delivery=${job.delivery_id} ${outcome}`, describeError(error));
        return;
      }
      if (attempt === 3) {
        console.error(`[dining:${env}] 결과 통보 실패 delivery=${job.delivery_id} ${outcome}`, describeError(error));
        return;
      }
      await delay(1_000);
    }
  }
}

async function trackFailure(job: DeliveryJob, outcome: DeliveryOutcome, env: KoinEnv, logClient: WebClient) {
  const storage = useStorage('kvStorage');
  const key = `dining:failures:${env}:${job.delivery_id}`;
  if (outcome === 'SUCCEEDED') {
    await storage.removeItem(key);
    return;
  }
  const count = ((await storage.getItem<number>(key)) ?? 0) + 1;
  await storage.setItem(key, count);
  if (count !== ALERT_AFTER_FAILURES) return;

  await logClient.chat
    .postMessage({
      channel: CHANNEL_ID.삐봇_log,
      text: `:warning: [식단 품절 제보 · ${env}] 제보 #${job.report.report_id} 전송이 ${count}번 연속 실패했습니다. 서버 로그에서 delivery=${job.delivery_id}를 확인해주세요.`,
    })
    .catch((error: unknown) => console.error(`[dining:${env}] 실패 알림 전송 실패`, describeError(error)));
}

export async function runDiningBatch(env: KoinEnv): Promise<number> {
  const auth = resolveDiningAuth(env);
  if (!auth) {
    console.warn(`[dining:${env}] 주소나 서비스 토큰이 없어 배치를 실행하지 않습니다.`);
    return 0;
  }
  const { channelId, adminUrl } = TARGET[env];
  if (!channelId) {
    console.warn(`[dining:${env}] 전송할 채널이 정해지지 않아 배치를 실행하지 않습니다.`);
    return 0;
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn(`[dining:${env}] Slack 토큰이 없어 배치를 실행하지 않습니다.`);
    return 0;
  }
  const slack = new WebClient(token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000 });
  const logClient = new WebClient(token);
  let processed = 0;
  for (let index = 0; index < DINING_BATCH_LIMIT; index += 1) {
    let job: DeliveryJob | null;
    try {
      job = await claimDelivery(auth);
    } catch (error) {
      console.error(`[dining:${env}] claim 실패`, describeError(error));
      break;
    }
    if (!job) {
      break;
    }

    const outcome = await deliver(job, { env, channelId, adminUrl, slack: slack.chat }).catch((error: unknown) => {
      console.error(
        `[dining:${env}] 전송 실패 report=${job.report.report_id} delivery=${job.delivery_id}`,
        describeError(error),
      );
      return 'FAILED' as const;
    });

    await report(job, outcome, auth, env);
    processed += 1;
    await trackFailure(job, outcome, env, logClient).catch((error: unknown) =>
      console.error(`[dining:${env}] 실패 집계 오류`, describeError(error)),
    );
  }
  return processed;
}
