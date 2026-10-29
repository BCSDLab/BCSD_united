// 봇 운영 문서를 `manual` 출처로 다시 색인한다.
// 다른 커넥터의 문서는 유지한다.
// CLOUDFLARE_ACCOUNT_ID와 CLOUDFLARE_API_TOKEN 및 PostgreSQL 접속 설정이 필요하다.
// pnpm --filter @koin/b-bot-database rag:ingest
import pg from 'pg';
import { embed, runWithAi } from '@koin/b-bot-ai';
import { format as formatCliOutput } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'apps', 'b-bot');

// 다른 앱의 설정이 답변에 섞이지 않도록 봇 문서만 수집한다.
const FILES = ['README.md', 'docs/계획서.md', 'docs/기능명세서.md'];

const PG = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST ?? process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? process.env.PGPORT ?? 5544),
      user: process.env.DB_USER ?? process.env.PGUSER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? process.env.PGPASSWORD,
      database: process.env.DB_NAME ?? process.env.PGDATABASE ?? 'bbot',
    };

// chunk.ts와 동일 로직(헤딩 breadcrumb 인식)
function cleanMarkdown(md) {
  return md
    .replace(/<summary[^>]*>\s*<h([1-6])[^>]*>([\s\S]*?)<\/h\1>\s*<\/summary>/gi, '\n### $2\n')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, '\n### $2\n')
    .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, '\n### $1\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) =>
      /^(image|img|screenshot|배너|이미지)?$/i.test((alt || '').trim()) ? ' ' : ` ${alt} `,
    )
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/`{1,3}/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

// 긴 세그먼트를 size 창으로 오버랩 분할
function windows(s, size, overlap) {
  if (s.length <= size) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size - overlap) out.push(s.slice(i, i + size));
  return out;
}

// 헤딩 경로를 추적하며 청크 앞에 breadcrumb를 붙임
function chunk(text, size = 350, overlap = 80) {
  const lines = cleanMarkdown(text).split('\n');
  const out = [];
  const crumb = [];
  let buf = [];
  let head = '';
  const breadcrumb = () => crumb.filter(Boolean).join(' › ');
  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    if (!body) return;
    const prefix = head ? head + '\n' : '';
    let cur = '';
    for (const seg of body
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      for (const piece of windows(seg, size, overlap)) {
        if (cur && (cur + '\n' + piece).length > size) {
          out.push(prefix + cur);
          cur = piece;
        } else cur = cur ? cur + '\n' + piece : piece;
      }
    }
    if (cur) out.push(prefix + cur);
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (m) {
      flush();
      const lvl = m[1].length;
      crumb.length = lvl - 1;
      crumb[lvl - 1] = m[2].trim();
      head = breadcrumb();
      continue;
    }
    if (buf.length === 0) head = breadcrumb();
    buf.push(line);
  }
  flush();
  return out.map((c) => c.trim()).filter((c) => c.length > 15);
}

// 문서 분류는 `apps/b-bot/src/services/rag/classify.ts`와 일치시킨다.
const DATE_RE = /(^|\s)\d{2,4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/;
function classifyDocType(source, title) {
  if (source === 'github') return 'readme';
  const t = (title || '').trim();
  if (/인수인계/.test(t)) return 'handover';
  if (/영수증|결제|서버비|사용비|지원|회비|거래내역|사업자|환급|정산|과금|비용|납부|결산/.test(t)) return 'finance';
  if (/역기획서|기획서|차시|주차|보고서|과제|제출|템플릿/.test(t)) return 'personal_work';
  if (/커리큘럼|온보딩|가이드|시작하기|문서화|컨벤션|규칙|회칙|셋업|setup|환경\s*설정|아키텍처|명세/i.test(t))
    return 'guide';
  if (DATE_RE.test(t) || /회의|주간\s*공유|월간\s*공유|미팅|회고|standup|스크럼|monthly|weekly/i.test(t))
    return 'meeting';
  return 'doc';
}

async function main() {
  const pc = new pg.Client(PG);
  await pc.connect();
  // ⚠️ 자기 출처(manual)만 정리 — 다른 커넥터(notion/gdrive/github) 코퍼스는 보존.
  await pc.query("DELETE FROM document_chunk WHERE source = 'manual'");
  let total = 0;
  for (const rel of FILES) {
    const abs = join(ROOT, rel);
    let raw, mtime;
    try {
      raw = readFileSync(abs, 'utf8');
      mtime = statSync(abs).mtime;
    } catch {
      process.stdout.write(formatCliOutput(`(건너뜀: ${rel} 없음)`) + '\n');
      continue;
    }
    const docType = classifyDocType('manual', rel);
    const chunks = chunk(raw);
    for (const c of chunks) {
      const vec = await embed(c);
      await pc.query(
        `INSERT INTO document_chunk(source, source_url, project, title, content, embedding, doc_type, updated_at)
         VALUES('manual', $1, 'bbot', $2, $3, $4::vector, $5, $6)`,
        [`repo:${rel}`, rel, c, `[${vec.join(',')}]`, docType, mtime],
      );
      total++;
    }
    process.stdout.write(formatCliOutput(`✓ ${rel}: ${chunks.length} 청크 (${docType})`) + '\n');
  }
  const { rows } = await pc.query('SELECT COUNT(*)::int n FROM document_chunk');
  process.stdout.write(formatCliOutput(`적재 완료: ${rows[0].n} 청크`) + '\n');
  await pc.end();
}

runWithAi(process.env, async () => main()).catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
