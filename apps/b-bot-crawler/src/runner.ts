import { createDatabaseScope } from '@koin/b-bot-database';
import { runWithAi } from '@koin/b-bot-ai';
import { ingestGithub } from '../../b-bot/src/services/rag/ingest.ts';
import { ingestNotion } from '../../b-bot/src/services/rag/notion.ts';
import { ingestGdrive } from '../../b-bot/src/services/rag/gdrive.ts';
import type { Connector, JobResult } from './store.ts';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/** 리스너를 열기 전에 공통 설정을 검증하고, 커넥터별 자격 증명은 작업마다 검증한다. */
export function preflight(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_URL?.trim()) {
    for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) required(env, key);
  }
  required(env, 'CLOUDFLARE_ACCOUNT_ID');
  required(env, 'CLOUDFLARE_API_TOKEN');
}

export async function runIngest(
  job: { connector: Connector; full: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<JobResult> {
  preflight(env);
  if (job.connector === 'notion') required(env, 'NOTION_TOKEN');
  if (job.connector === 'gdrive') {
    required(env, 'GOOGLE_REFRESH_TOKEN');
    required(env, 'GOOGLE_CLIENT_ID');
    required(env, 'GOOGLE_CLIENT_SECRET');
  }
  const scope = createDatabaseScope(env);
  try {
    return await scope.run(() =>
      runWithAi(env, async (): Promise<JobResult> => {
        if (job.connector === 'github') {
          const { repos, chunks } = await ingestGithub();
          return { repos, chunks };
        }
        if (job.connector === 'notion') return await ingestNotion({ full: job.full });
        const { docs, changed, chunks, removed } = await ingestGdrive(env.GOOGLE_REFRESH_TOKEN!);
        return { docs, changed, chunks, removed };
      }),
    );
  } finally {
    await scope.close();
  }
}
