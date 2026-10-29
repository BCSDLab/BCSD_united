import { enabledWorkerEnvs, runDiningBatch } from '~/services/dining/worker';

export default defineTask({
  meta: {
    name: 'dining:deliver',
    description: 'Deliver a finite batch of claimed dining reports',
  },
  async run() {
    // Opt-in remains mandatory: local or stage workers must not claim production deliveries.
    const envs = enabledWorkerEnvs(process.env.DINING_WORKER_ENVS);
    const delivered: Record<string, number> = {};
    for (const env of envs) {
      delivered[env] = await runDiningBatch(env);
    }
    return { result: delivered };
  },
});
