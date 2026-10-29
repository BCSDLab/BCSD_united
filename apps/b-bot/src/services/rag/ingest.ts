// 지식 소스 색인: 문서 upsert(소스·프로젝트 단위 갱신) + GitHub README 커넥터.
import { getPool, query } from '~/infra/postgres';
import { embed } from '@koin/b-bot-ai';
import { chunk } from './chunk';
import { classifyDocType } from './classify';
import RAG_REPOS from '@/constant/RAG_REPOS.json';

// (source, project) 단위로 기존 청크 삭제 후 새로 적재 → 재동기화 시 중복/stale 방지.
// prefix: 각 청크 앞에 붙는 식별 문구(예: "프로젝트 X — 설명"). 검색 라우팅·LLM 맥락에 사용.
// extraChunks: 청킹 없이 그대로 적재할 합성 청크(예: 언어 구성).
export async function upsertDocument(opts: {
  source: string;
  sourceUrl: string;
  project: string;
  title: string;
  content: string;
  prefix?: string;
  extraChunks?: string[];
}): Promise<number> {
  const pool = getPool();
  await query(pool, `DELETE FROM document_chunk WHERE source = $1 AND project = $2`, [opts.source, opts.project]);
  const pre = opts.prefix ? opts.prefix + '\n' : '';
  const docType = classifyDocType(opts.source, opts.title);
  const pieces = [...chunk(opts.content), ...(opts.extraChunks ?? [])];
  for (const c of pieces) {
    const body = pre + c;
    const vec = await embed(body);
    await query(
      pool,
      `INSERT INTO document_chunk(source, source_url, project, title, content, embedding, doc_type)
       VALUES($1, $2, $3, $4, $5, $6::vector, $7)`,
      [opts.source, opts.sourceUrl, opts.project, opts.title, body, `[${vec.join(',')}]`, docType],
    );
  }
  return pieces.length;
}

async function fetchReadme(owner: string, repo: string): Promise<{ text: string; url: string } | null> {
  const res = await $fetch<{ content: string; html_url: string }>(
    `https://api.github.com/repos/${owner}/${repo}/readme`,
    { headers: { 'User-Agent': 'b-bot', Accept: 'application/vnd.github+json' } },
  ).catch(() => null);
  if (!res?.content) return null;
  const text = Buffer.from(res.content, 'base64').toString('utf8');
  return { text, url: res.html_url };
}

// 레포의 언어 구성(바이트 기준)을 "기술스택" 텍스트 청크로. README의 기술스택이
// 이미지라 검색 불가한 경우의 보강(무인증 공개 API).
async function fetchLanguages(owner: string, repo: string): Promise<Record<string, number> | null> {
  return await $fetch<Record<string, number>>(`https://api.github.com/repos/${owner}/${repo}/languages`, {
    headers: { 'User-Agent': 'b-bot', Accept: 'application/vnd.github+json' },
  }).catch(() => null);
}

function languageChunk(langs: Record<string, number> | null): string | null {
  if (!langs) return null;
  const entries = Object.entries(langs).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const list = entries.map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`).join(', ');
  // prefix(프로젝트 X — desc)는 upsertDocument에서 붙이므로 여기선 본문만.
  return `기술스택 / 사용 언어 구성(GitHub 기준): ${list}`;
}

// 설정된 공개 레포들의 README + 언어 구성을 가져와 색인. 무인증(공개 레포).
export async function ingestGithub(): Promise<{ repos: number; chunks: number; skipped: string[] }> {
  const { owner, repos, desc } = RAG_REPOS as {
    owner: string;
    repos: string[];
    desc: Record<string, string>;
  };
  let okRepos = 0;
  let totalChunks = 0;
  const skipped: string[] = [];
  for (const repo of repos) {
    const r = await fetchReadme(owner, repo);
    if (!r || !r.text.trim()) {
      skipped.push(repo);
      continue;
    }
    const d = desc[repo] ?? repo;
    const langChunk = languageChunk(await fetchLanguages(owner, repo));
    const n = await upsertDocument({
      source: 'github',
      sourceUrl: r.url,
      project: repo,
      title: `${repo} README`,
      content: r.text,
      prefix: `프로젝트 ${repo} — ${d}`,
      extraChunks: langChunk ? [langChunk] : [],
    });
    okRepos++;
    totalChunks += n;
  }
  await query(
    getPool(),
    `INSERT INTO sync_cursor(connector, last_edited_at, updated_at)
     VALUES('github', now(), now())
     ON CONFLICT (connector) DO UPDATE SET last_edited_at = now(), updated_at = now()`,
  );
  return { repos: okRepos, chunks: totalChunks, skipped };
}
