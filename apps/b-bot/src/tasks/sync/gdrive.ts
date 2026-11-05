import { crawlerJobRequest, enqueueCrawlerJob, type CrawlerSchedulePayload } from '~/services/rag/crawlerClient';

// Google Drive Docs 색인은 Pi에 등록만 한다. nitro.config.ts scheduledTasks에서 호출.
export default defineTask({
  meta: {
    name: 'sync:gdrive',
    description: 'Google Docs 색인 작업을 Pi에 등록',
  },
  async run(ctx) {
    const job = await enqueueCrawlerJob(crawlerJobRequest('gdrive', ctx?.payload as CrawlerSchedulePayload));
    console.warn(`[sync:gdrive] Pi job=${job.id} status=${job.status}`);
    return { result: job };
  },
});
