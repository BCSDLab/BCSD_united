import { crawlerJobRequest, enqueueCrawlerJob, type CrawlerSchedulePayload } from '~/services/rag/crawlerClient';

// Notion 공유 페이지 색인은 Pi에 등록만 한다. nitro.config.ts scheduledTasks에서 호출.
export default defineTask({
  meta: {
    name: 'sync:notion',
    description: 'Notion 공유 페이지 색인 작업을 Pi에 등록',
  },
  async run(ctx) {
    const job = await enqueueCrawlerJob(crawlerJobRequest('notion', ctx?.payload as CrawlerSchedulePayload));
    console.warn(`[sync:notion] Pi job=${job.id} status=${job.status}`);
    return { result: job };
  },
});
