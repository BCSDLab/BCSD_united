import { crawlerJobRequest, enqueueCrawlerJob, type CrawlerSchedulePayload } from '~/services/rag/crawlerClient';

// GitHub README 색인은 Pi에 등록만 한다. nitro.config.ts scheduledTasks에서 호출.
export default defineTask({
  meta: {
    name: 'sync:github',
    description: 'GitHub 공개 레포 README 색인 작업을 Pi에 등록',
  },
  async run(ctx) {
    const job = await enqueueCrawlerJob(crawlerJobRequest('github', ctx?.payload as CrawlerSchedulePayload));
    console.warn(`[sync:github] Pi job=${job.id} status=${job.status}`);
    return { result: job };
  },
});
