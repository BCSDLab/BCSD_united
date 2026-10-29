// 질문을 임베딩해 pgvector로 검색하고 Workers AI Luna로 답변과 출처를 생성한다.
// CLOUDFLARE_ACCOUNT_ID와 CLOUDFLARE_API_TOKEN 및 PostgreSQL 접속 설정이 필요하다.
// pnpm --filter @koin/b-bot-database rag:ask "환경변수는 어디에 있나요?"
import pg from 'pg';
import { embed, generate, runWithAi } from '@koin/b-bot-ai';
import { format as formatCliOutput } from 'node:util';

const TOP_K = 5;

const PG = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST ?? process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? process.env.PGPORT ?? 5544),
      user: process.env.DB_USER ?? process.env.PGUSER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? process.env.PGPASSWORD,
      database: process.env.DB_NAME ?? process.env.PGDATABASE ?? 'bbot',
    };

async function main() {
  const question = process.argv[2];
  if (!question) {
    console.error('질문을 인자로 주세요: node ask.mjs "..."');
    process.exit(1);
  }

  const pc = new pg.Client(PG);
  await pc.connect();

  const t0 = Date.now();
  const qvec = await embed(question);
  const { rows } = await pc.query(
    `SELECT title, source_url, content, 1 - (embedding <=> $1::vector) AS score
     FROM document_chunk ORDER BY embedding <=> $1::vector LIMIT ${TOP_K}`,
    [`[${qvec.join(',')}]`],
  );
  const tSearch = Date.now() - t0;

  const context = rows.map((r, i) => `[${i + 1}] (출처: ${r.source_url})\n${r.content}`).join('\n\n');
  const prompt =
    `당신은 BCSD 동아리의 봇입니다. 아래 [문서]만 근거로 질문에 한국어로 답하세요.\n` +
    `- 구체적인 명령어·경로·파일명이 문서에 있으면 그대로 포함하세요.\n` +
    `- 문서에 단서가 조금이라도 있으면 그것으로 답하고, 정말 없을 때만 "문서에 없음"이라고 하세요.\n\n` +
    `[문서]\n${context}\n\n[질문] ${question}\n\n[답변]`;

  const t1 = Date.now();
  const text = await generate(prompt, 256);
  const tGen = Date.now() - t1;

  process.stdout.write(formatCliOutput(`\n❓ ${question}\n`) + '\n');
  process.stdout.write(formatCliOutput(`💬 ${text}\n`) + '\n');
  process.stdout.write(formatCliOutput(`📎 출처:`) + '\n');
  rows.forEach((r) =>
    process.stdout.write(formatCliOutput(`   - ${r.source_url} (유사도 ${r.score.toFixed(3)})`) + '\n'),
  );
  process.stdout.write(formatCliOutput(`\n⏱ 검색 ${tSearch}ms / 생성 ${tGen}ms`) + '\n');
  await pc.end();
}

runWithAi(process.env, async () => main()).catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
