// RAG: 질문 → 임베딩 → (레포 라우팅) → pgvector top-k 검색 → Luna 생성 → 답+출처
import { createHash } from 'node:crypto';
import { getPool, query } from '~/infra/postgres';
import { embed, generateStream } from '@koin/b-bot-ai';
import RAG_REPOS from '@/constant/RAG_REPOS.json';
import { TYPE_WEIGHT, type DocType } from './classify';

const SOURCE_MAX = 4; // 답변에 표시할 출처 최대 개수(노이즈 컷)
const CANDIDATES = 20; // 타입 재랭킹용 후보 풀(이후 TOP_K로 좁힘)

const TOP_K = 5; // 8→5: prefill(지연 지배 구간) ~36%↓. 타입 재랭킹이 상위 청크를 채워 recall 보전.
const NUM_PREDICT = 280; // 답변이 중간에 잘리지 않도록(스트리밍이라 체감 대기는 완화).

// 레포 라우팅 임계: 질문이 특정 레포를 충분히 강하게 가리킬 때만 그 레포로 한정.
// 다른 레포의 청크가 답변 근거에 섞이지 않도록 검색 범위를 제한한다.
const ROUTE_MIN_SCORE = 0.5; // 1위 레포와의 최소 유사도
const ROUTE_MIN_MARGIN = 0.03; // 1위-2위 유사도 차(모호하면 폴백)

// 레포 식별 문구("이름 + 설명")를 한 번 임베딩해 캐시 → 질문과의 유사도로 라우팅.
let _repoVecs: Array<{ project: string; vec: number[] }> | undefined;
async function repoVectors() {
  if (_repoVecs) return _repoVecs;
  const { repos, desc, alias } = RAG_REPOS as {
    repos: string[];
    desc: Record<string, string>;
    alias: Record<string, string>;
  };
  const out: Array<{ project: string; vec: number[] }> = [];
  for (const r of repos) {
    out.push({ project: r, vec: await embed(`${r} ${desc[r] ?? ''} ${alias?.[r] ?? ''}`) });
  }
  _repoVecs = out;
  return out;
}

function cosine(a: number[], b: number[]): number {
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

// 질문이 특정 레포를 강하게 가리키면 검색을 한정할 project 집합 반환(아니면 null=전체).
// B_BOT(봇 자신)으로 라우팅되면 manual 내부 문서(project='bbot')까지 포함.
async function routeProjects(queryVec: number[]): Promise<string[] | null> {
  const scored = (await repoVectors())
    .map((x) => ({ project: x.project, s: cosine(queryVec, x.vec) }))
    .sort((a, b) => b.s - a.s);
  const [first, second] = scored;
  if (!first || first.s < ROUTE_MIN_SCORE) return null;
  if (second && first.s - second.s < ROUTE_MIN_MARGIN) return null;
  return first.project === 'B_BOT' ? ['B_BOT', 'bbot'] : [first.project];
}

export interface RagSource {
  title: string;
  source_url: string;
  score: number;
}
export interface RagAnswer {
  text: string;
  sources: RagSource[];
}

type Chunk = {
  source: string;
  project: string;
  title: string;
  source_url: string;
  content: string;
  score: number;
  doc_type: DocType | null;
  updated_at: string | null;
};

// 최신성 보너스(보조 신호): 같은 타입·유사도면 최신 문서 우선. 의미·타입을 뒤집지 않게 작게.
// 반감기 180일, 최대 +0.05(타입 가중치 ≤0.1보다 작음). updated_at 없으면 0(중립, 페널티 아님).
const RECENCY_MAX = 0.05;
const RECENCY_HALFLIFE_DAYS = 180;
function recencyBonus(updatedAt: string | null): number {
  if (!updatedAt) return 0;
  const t = new Date(updatedAt).getTime();
  if (!t || Number.isNaN(t)) return 0;
  const ageDays = (Date.now() - t) / 86_400_000;
  if (ageDays <= 0) return RECENCY_MAX;
  return RECENCY_MAX * Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
}

// 질문 임베딩 → (1) desc 기반 사전 라우팅 → 없으면 (2) 전체 검색 후 사후 보정
// → (3) 문서 타입 가중치로 재랭킹(회의록·재무 down-rank, 가이드·readme 우선).
async function retrieve(question: string): Promise<Chunk[]> {
  const vec = await embed(question);
  const vecLiteral = `[${vec.join(',')}]`;
  const projects = await routeProjects(vec);

  const params: unknown[] = [vecLiteral];
  let where = '';
  if (projects) {
    params.push(projects);
    where = `WHERE project = ANY($2)`;
  }
  // 타입 재랭킹이 하위 후보를 끌어올릴 수 있게 넉넉한 후보 풀을 가져옴.
  const { rows } = await query(
    getPool(),
    `SELECT source, project, title, source_url, content, doc_type, updated_at,
            1 - (embedding <=> $1::vector) AS score
     FROM document_chunk
     ${where}
     ORDER BY embedding <=> $1::vector
     LIMIT ${CANDIDATES}`,
    params,
  );
  let chunks = rows as Chunk[];

  // (3) 재랭킹: 유사도 + TYPE_WEIGHT[doc_type] + 최신성 보너스로 정렬.
  const adj = (c: Chunk) =>
    Number(c.score) + (c.doc_type ? (TYPE_WEIGHT[c.doc_type] ?? 0) : 0) + recencyBonus(c.updated_at);
  chunks.sort((a, b) => adj(b) - adj(a));

  // 사후 보정: 사전 라우팅이 폴백된 경우, 1위 청크의 레포가 상위 결과를 장악하면(≥2개)
  // 그 레포로 한정 → "코인 백엔드 참여자"처럼 라우팅은 모호하나 청크는 한 레포에 쏠린 질문 처리.
  if (!projects && chunks.length > 0) {
    const dom = chunks[0].project;
    const same = chunks.filter((c) => c.project === dom);
    if (same.length >= 2) chunks = same;
  }
  return chunks.slice(0, TOP_K);
}

// 출처를 사람이 읽을 수 있는 라벨로(프로젝트·종류 명시 → 모델이 도메인 구분).
function label(r: Awaited<ReturnType<typeof retrieve>>[number]): string {
  if (r.source === 'github') return `프로젝트 ${r.project} (GitHub README)`;
  if (r.source === 'notion') return `노션 문서: ${r.title}`;
  if (r.source === 'gdrive') return `구글 문서: ${r.title}`;
  return `B-BOT 봇 내부 기획/문서: ${r.title}`;
}

function buildPrompt(question: string, rows: Awaited<ReturnType<typeof retrieve>>) {
  const context = rows.map((r, i) => `[출처 ${i + 1} — ${label(r)}]\n${r.content}`).join('\n\n');
  return (
    `당신은 BCSD 동아리의 도우미 봇입니다. 아래 [문서]만 근거로 한국어로 답하세요.\n` +
    `규칙:\n` +
    `- 질문이 특정 프로젝트/레포에 관한 것이면 **그 프로젝트 출처만** 사용하세요. 다른 프로젝트나 B-BOT 봇 내부 문서의 내용을 절대 섞지 마세요.\n` +
    `- 서로 다른 출처의 내용을 합쳐 하나의 답으로 지어내지 마세요.\n` +
    `- 어느 프로젝트를 묻는지 출처에서 확신할 수 없으면, 추측하지 말고 "어느 프로젝트(레포)를 말하는지 알려주세요"라고 되물으세요.\n` +
    `- 구체적인 기술명·명령어·경로는 출처에 있는 그대로 쓰세요.\n` +
    `- 해당 프로젝트 출처에 핵심 정보가 없으면 "문서에서 찾지 못했어요"라고 하세요.\n` +
    `- **핵심만 간결히**, 불필요한 미사여구 없이 답하고 **반드시 문장을 완결해서 끝맺으세요**(중간에 끊지 말 것).\n` +
    `- **답변 본문에 URL·링크를 지어내지 마세요.** 출처는 답변 하단에 자동으로 표시됩니다. 문서를 가리킬 땐 제목만 쓰세요.\n\n` +
    `[문서]\n${context}\n\n[질문] ${question}\n\n[답변]`
  );
}

// source_url 기준 중복 제거(상위 점수 유지)
function dedupSources(rows: Awaited<ReturnType<typeof retrieve>>): RagSource[] {
  const seen = new Set<string>();
  const out: RagSource[] = [];
  for (const r of rows) {
    if (seen.has(r.source_url)) continue;
    seen.add(r.source_url);
    out.push({ title: r.title, source_url: r.source_url, score: Number(r.score) });
  }
  return out.slice(0, SOURCE_MAX); // 상위 출처만(노이즈 컷)
}

const EMPTY: RagAnswer = {
  text: '아직 학습된 문서가 없어요. 관리자에게 문서 색인을 요청해주세요.',
  sources: [],
};

// 질의 로그(실사용량·응답시간·해결률 측정). 로깅 실패가 사용자 답변을 막지 않도록 자체 흡수.
// user는 해시만 저장(PII 비보관). 표시용이 아니라 집계용.
export interface QueryLogEntry {
  channel: string;
  msgTs: string;
  user: string;
  question: string;
  answer: string;
  found: boolean;
  sourceUrls: string[];
  latencyMs: number;
}
export async function logQuery(entry: QueryLogEntry): Promise<void> {
  try {
    const userHash = createHash('sha256').update(entry.user).digest('hex').slice(0, 16);
    await query(
      getPool(),
      `INSERT INTO rag_query_log
         (channel, msg_ts, user_hash, question, answer, found, source_urls, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.channel,
        entry.msgTs,
        userHash,
        entry.question,
        entry.answer,
        entry.found,
        entry.sourceUrls,
        entry.latencyMs,
      ],
    );
  } catch (e) {
    console.error('[rag] 질의 로그 기록 실패:', e);
  }
}

// 👍/👎 만족도. msg_ts로 질의 로그 행을 찾아 feedback 갱신(+1/−1/null=취소).
// 매칭 행이 없으면 no-op이라, RAG 답변 메시지에만 자연스럽게 스코프됨.
export async function setFeedback(msgTs: string, value: number | null): Promise<void> {
  try {
    await query(getPool(), `UPDATE rag_query_log SET feedback = $1 WHERE msg_ts = $2`, [value, msgTs]);
  } catch (e) {
    console.error('[rag] 피드백 기록 실패:', e);
  }
}

// 스트리밍: 생성 토큰이 쌓일 때마다 onText(누적 텍스트) 호출. 반환은 최종 답+출처.
export async function answerStream(question: string, onText: (full: string) => void): Promise<RagAnswer> {
  const rows = await retrieve(question);
  if (rows.length === 0) return EMPTY;
  const text = await generateStream(buildPrompt(question, rows), onText, NUM_PREDICT);
  return { text, sources: dedupSources(rows) };
}
