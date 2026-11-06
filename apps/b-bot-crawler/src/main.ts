import { createCrawlerService } from './server.ts';
import { preflight, runIngest } from './runner.ts';

preflight(process.env);
const authToken = process.env.CRAWLER_AUTH_TOKEN ?? '';
const statePath = process.env.CRAWLER_STATE_PATH ?? './data/crawler.sqlite';
const service = createCrawlerService({ statePath, authToken, run: (job) => runIngest(job) });
const port = Number(process.env.CRAWLER_PORT ?? '8813');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CRAWLER_PORT must be 1..65535');
await service.listen(port);
console.info(`[b-bot-crawler] listening on 127.0.0.1:${port}`);

let shutdown: Promise<void> | undefined;
function stop() {
  shutdown ??= service.stop().catch(() => {
    process.exitCode = 1;
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
