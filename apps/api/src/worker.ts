import { captureError } from '@koin/telemetry/runtime';
import { API_DISABLED_QUEUE_RETRY_DELAY_SECONDS, isApiEnabled } from '@api/api-gate';
import app from '@api/app';
import { handleCallvanJob, runCallvanCron } from '@api/domains/callvan';
import { handleClubsJob, runClubsCron } from '@api/domains/clubs';
import { handleCommerceJob, runCommerceCron } from '@api/domains/commerce';
import { handleCommunityJob, runCommunityCron } from '@api/domains/community';
import { handleDiningJob, runDiningCron } from '@api/domains/dining';
import { runExperimentsCron } from '@api/domains/experiments';
import { handleIdentityJob, runIdentityCron } from '@api/domains/identity';
import { handleMiscJob, runMiscCron } from '@api/domains/misc';
import { handleTeamJob, runTeamCron } from '@api/domains/team';
import { runTransportCron } from '@api/domains/transport';
import type { Job } from '@api/jobs';
import { tickCityBus } from '@api/koin-db/city-bus-realtime';
import gateway from '@api/koin-db/gateway';
import { syncDiningCache } from '@api/koin-db/dining';
import type { Bindings } from '@api/runtime';

// Worker 진입 핸들러. Durable Object 클래스 export는 index.ts가 맡는다(cloudflare:workers 의존 분리, Node 테스트 가능).
const jobHandlers = [
  handleIdentityJob,
  handleCommerceJob,
  handleTeamJob,
  handleCallvanJob,
  handleCommunityJob,
  handleDiningJob,
  handleClubsJob,
  handleMiscJob,
];
const schedules = [
  runIdentityCron,
  runCommerceCron,
  runTeamCron,
  runCallvanCron,
  runCommunityCron,
  runDiningCron,
  runClubsCron,
  runMiscCron,
  runExperimentsCron,
  runTransportCron,
];

const worker: ExportedHandler<Bindings, Job> = {
  fetch: (request, env, context) =>
    env.KOIN_DB_ENABLED === 'true' ? gateway.fetch(request, env, context) : app.fetch(request, env, context),
  async queue(batch, env) {
    if (!isApiEnabled(env)) {
      // 비활성: 어떤 메시지도 ack/drop하지 않고 전체를 최대 지연으로 재시도한다. 원격 큐 일시정지는 별도 운영.
      batch.retryAll({ delaySeconds: API_DISABLED_QUEUE_RETRY_DELAY_SECONDS });
      return;
    }
    for (const message of batch.messages) {
      try {
        let handled = false;
        for (const handler of jobHandlers) {
          if (await handler(env, message.body)) {
            handled = true;
            break;
          }
        }
        if (!handled) throw new Error('Unknown queued job kind: ' + message.body.kind);
        message.ack();
      } catch (error) {
        captureError(error);
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  async scheduled(event, env) {
    // 공유 DB 모드는 식단 KV 동기화와 시내버스 수집만 실행한다. 레거시 cron은 API_ENABLED 게이트로 막힌다.
    if (env.KOIN_DB_ENABLED === 'true') {
      const results = await Promise.allSettled([
        syncDiningCache(env, new Date(event.scheduledTime)),
        tickCityBus(env, event.scheduledTime),
      ]);
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (failures.length) throw new AggregateError(failures, 'Scheduled KOIN DB work failed');
      return;
    }
    if (!isApiEnabled(env)) return;
    const results = await Promise.allSettled(schedules.map((schedule) => schedule(env, event.scheduledTime)));
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, 'Scheduled API work failed');
  },
};

export default worker;
