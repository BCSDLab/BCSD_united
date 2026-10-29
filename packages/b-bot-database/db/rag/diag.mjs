// diag.mjs — 검색/라우팅 진단.
// pnpm --filter @koin/b-bot-database rag:diag "질문" [K]
// pnpm --filter @koin/b-bot-database rag:diag --route
import pg from 'pg';
import { embed, generate, runWithAi } from '@koin/b-bot-ai';
import { format as formatCliOutput } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { repos, desc, alias } = JSON.parse(readFileSync(join(ROOT, 'apps/b-bot/src/constant/RAG_REPOS.json'), 'utf8'));
const ROUTE_MIN_SCORE = 0.5;
const ROUTE_MIN_MARGIN = 0.03;
const CANDIDATES = 20; // index.ts와 동일 후보 풀
// index.ts의 recencyBonus 미러(반감기 180일, 최대 +0.05, null=중립)
const RECENCY_MAX = 0.05,
  RECENCY_HALFLIFE_DAYS = 180;
function recencyBonus(updatedAt) {
  if (!updatedAt) return 0;
  const t = new Date(updatedAt).getTime();
  if (!t || Number.isNaN(t)) return 0;
  const ageDays = (Date.now() - t) / 86_400_000;
  return ageDays <= 0 ? RECENCY_MAX : RECENCY_MAX * Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
}
// classify.ts의 TYPE_WEIGHT 미러(튜닝 시 함께 맞출 것)
const TYPE_WEIGHT = {
  readme: 0.1,
  guide: 0.1,
  handover: 0.08,
  doc: 0,
  meeting: -0.08,
  personal_work: -0.1,
  finance: -0.12,
};
const PG = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST ?? process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? process.env.PGPORT ?? 5544),
      user: process.env.DB_USER ?? process.env.PGUSER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? process.env.PGPASSWORD,
      database: process.env.DB_NAME ?? process.env.PGDATABASE ?? 'bbot',
    };
function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
let _rv;
async function repoVectors() {
  if (_rv) return _rv;
  _rv = [];
  for (const r of repos) _rv.push({ project: r, vec: await embed(`${r} ${desc?.[r] ?? ''} ${alias?.[r] ?? ''}`) });
  return _rv;
}
async function route(qVec) {
  const scored = (await repoVectors())
    .map((x) => ({ project: x.project, s: cosine(qVec, x.vec) }))
    .sort((a, b) => b.s - a.s);
  const [f, s] = scored;
  const decided =
    !f || f.s < ROUTE_MIN_SCORE
      ? null
      : s && f.s - s.s < ROUTE_MIN_MARGIN
        ? null
        : f.project === 'B_BOT'
          ? ['B_BOT', 'bbot']
          : [f.project];
  return { decided, top: scored.slice(0, 3) };
}

const NUM_PREDICT = Number(process.env.DIAG_NP ?? 280); // 측정 스윕용
const TRIM = Number(process.env.DIAG_TRIM ?? 0); // 청크 내용 상한(0=무제한)
function buildPrompt(question, chunks) {
  const ctx = chunks
    .map((r, i) => {
      const lbl = r.project === 'bbot' ? `B-BOT 봇 내부 기획/문서` : `프로젝트 ${r.project} (GitHub README)`;
      const content = TRIM > 0 ? r.content.slice(0, TRIM) : r.content;
      return `[출처 ${i + 1} — ${lbl}]\n${content}`;
    })
    .join('\n\n');
  return (
    `당신은 BCSD 동아리의 도우미 봇입니다. 아래 [문서]만 근거로 한국어로 답하세요.\n` +
    `규칙:\n- 질문이 특정 프로젝트/레포에 관한 것이면 그 프로젝트 출처만 사용하세요. 다른 프로젝트 내용을 절대 섞지 마세요.\n` +
    `- 서로 다른 출처의 내용을 합쳐 지어내지 마세요.\n- 구체적인 기술명·이름은 출처에 있는 그대로 쓰세요.\n` +
    `- 핵심 정보가 없으면 "문서에서 찾지 못했어요"라고 하세요.\n\n[문서]\n${ctx}\n\n[질문] ${question}\n\n[답변]`
  );
}

async function main() {
  const pc = new pg.Client(PG);
  await pc.connect();
  const args = process.argv.slice(2);
  const GEN = args.includes('--gen');
  const arg = args.filter((a) => a !== '--gen')[0];
  const ROUTE_ONLY = arg === '--route';
  const queries = ROUTE_ONLY
    ? [
        '코인 백엔드 v2 기술스택 알려줘',
        '코인 백엔드 작업에 참여한 사람들은 누가 있어',
        '코인 어드민 기술스택',
        '코인 안드로이드 만든 사람',
        '환경변수는 어디에 있나요',
        '삐봇 기능 뭐가 있어',
        '코인 기술스택',
      ]
    : [arg];
  const K = Number(args.filter((a) => a !== '--gen' && a !== '--route')[1] ?? 8);
  for (const q of queries) {
    const qVec = await embed(q);
    const { decided, top } = await route(qVec);
    process.stdout.write(formatCliOutput(`\nQ: ${q}`) + '\n');
    process.stdout.write(
      formatCliOutput(
        `   라우팅: ${decided ? decided.join('+') : '전체(폴백)'}  | 상위: ` +
          top.map((t) => `${t.project}=${t.s.toFixed(3)}`).join(', '),
      ) + '\n',
    );
    if (ROUTE_ONLY) continue;
    const vec = `[${qVec.join(',')}]`;
    const params = [vec];
    let where = '';
    if (decided) {
      params.push(decided);
      where = 'WHERE project = ANY($2)';
    }
    // index.ts와 동일: 후보 CANDIDATES개 → 타입 가중치 재랭킹 → 사후보정 → TOP_K
    const { rows } = await pc.query(
      `SELECT project, doc_type, updated_at, 1-(embedding<=>$1::vector) score, content, left(replace(content,E'\n',' '),70) prev
       FROM document_chunk ${where} ORDER BY embedding<=>$1::vector LIMIT ${CANDIDATES}`,
      params,
    );
    const adj = (r) => r.score + (TYPE_WEIGHT[r.doc_type] ?? 0) + recencyBonus(r.updated_at);
    let chunks = rows.map((r) => ({ ...r, vrank: 0 }));
    chunks.forEach((r, i) => {
      r.vrank = i + 1;
    }); // 유사도 순 원래 등수
    chunks.sort((a, b) => adj(b) - adj(a));
    if (!decided && chunks.length > 0) {
      const dom = chunks[0].project;
      const same = chunks.filter((c) => c.project === dom);
      if (same.length >= 2) {
        chunks = same;
        process.stdout.write(formatCliOutput(`   사후보정 → ${dom} (${same.length}개 장악)`) + '\n');
      }
    }
    chunks = chunks.slice(0, K);
    process.stdout.write(formatCliOutput('  재랭킹 후 (보정 | 원점수 | 타입(가중치) | 최신성 | v순위 | 내용)') + '\n');
    chunks.forEach((r, i) => {
      const w = TYPE_WEIGHT[r.doc_type] ?? 0;
      const rec = recencyBonus(r.updated_at);
      process.stdout.write(
        formatCliOutput(
          `  ${String(i + 1).padStart(2)}. ${adj(r).toFixed(3)} | ${r.score.toFixed(3)} | ${(r.doc_type || '?').padEnd(13)}(${w >= 0 ? '+' : ''}${w}) | rec+${rec.toFixed(3)} | v${r.vrank} | [${r.project}] ${r.prev}`,
        ) + '\n',
      );
    });
    if (GEN) {
      const started = Date.now();
      const text = await generate(buildPrompt(q, chunks), NUM_PREDICT);
      process.stdout.write(formatCliOutput(`⏱ 생성 ${Date.now() - started}ms`) + '\n');
      process.stdout.write(formatCliOutput(`  💬 ${text}\n`) + '\n');
    }
  }
  await pc.end();
}
runWithAi(process.env, async () => main()).catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
