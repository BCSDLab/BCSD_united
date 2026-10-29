import { WebClient } from '@slack/web-api';
import { runDueBusVersionUpdates } from '~/services/bus/versionSchedule';

export default defineTask({
  meta: {
    name: 'bus:versionUpdate',
    description: 'Apply due bus timetable version updates',
  },
  async run() {
    const signal = AbortSignal.timeout(240_000);

    console.warn('[bus:versionUpdate] 시작');
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    try {
      await runDueBusVersionUpdates(client, signal);
      console.warn('[bus:versionUpdate] 완료');
      return { result: 'ok' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[bus:versionUpdate] 실패:', message);
      return { result: 'error', message };
    }
  },
});
