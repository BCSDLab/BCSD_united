// Google Drive(Docs) 커넥터: 봇 Google 계정(Meet과 동일 OAuth, drive.readonly 스코프 추가)으로
// Google Docs를 마크다운 export → 청킹 → 임베딩 → pgvector. 스프레드시트·슬라이드 등은 제외(Docs만).
// 범위: GDRIVE_FOLDER_IDS(쉼표구분) 지정 시 그 폴더들 재귀, 없으면 계정이 접근 가능한 전체 Docs.
import { getPool, query } from '~/infra/postgres';
import { embed } from '@koin/b-bot-ai';
import { chunk } from './chunk';
import { classifyDocType } from './classify';
import { googleAccessToken } from '~/services/google/oauth';
import { GOOGLE_MEET_KEY } from '~/services/google/googleMeet';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_SCAN = 5000;

// 이미 한 번 색인됐는지(커서 존재). 배포 시점 최초 1회 자동 색인 가드.
export async function isGdriveIndexed(): Promise<boolean> {
  const r = await query(getPool(), `SELECT 1 FROM sync_cursor WHERE connector = 'gdrive'`);
  return r.rows.length > 0;
}

function roots(): string[] {
  return (process.env.GDRIVE_FOLDER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 봇 refresh token(KV, Meet과 공유) → access token.
async function accessToken(): Promise<string | null> {
  const storage = useStorage('kvStorage');
  const refreshToken = await storage.get<string>(GOOGLE_MEET_KEY);
  if (!refreshToken) return null;
  return googleAccessToken(refreshToken);
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

async function listFiles(token: string, q: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DRIVE}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await $fetch<{ files: DriveFile[]; nextPageToken?: string }>(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!res) break;
    out.push(...(res.files ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

// Doc을 마크다운으로 export(헤딩 보존 → 헤딩 인식 청킹과 궁합). 실패 시 text/plain.
async function exportDoc(token: string, id: string): Promise<string> {
  for (const mime of ['text/markdown', 'text/plain']) {
    const text = await $fetch<string>(`${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(mime)}`, {
      headers: { Authorization: `Bearer ${token}` },
      parseResponse: (t) => t,
    }).catch(() => null);
    if (typeof text === 'string' && text.trim()) return text;
  }
  return '';
}

// 지정 폴더(들) 재귀 수집. roots 없으면 전체 Docs 평면 수집.
async function collectDocs(token: string): Promise<DriveFile[]> {
  const folders = roots();
  if (folders.length === 0) {
    return await listFiles(token, `mimeType='${DOC_MIME}' and trashed=false`);
  }
  const docs: DriveFile[] = [];
  const seen = new Set<string>();
  const stack = [...folders];
  while (stack.length && docs.length < MAX_SCAN) {
    const folderId = stack.pop()!;
    if (seen.has(folderId)) continue;
    seen.add(folderId);
    const children = await listFiles(token, `'${folderId}' in parents and trashed=false`);
    for (const f of children) {
      if (f.mimeType === FOLDER_MIME) stack.push(f.id);
      else if (f.mimeType === DOC_MIME) docs.push(f);
    }
  }
  return docs;
}

// 봇 계정 Docs를 증분 색인. modifiedTime > 커서만 재임베딩, 사라진 문서는 정리.
export async function ingestGdrive(): Promise<{ docs: number; changed: number; chunks: number; removed: number }> {
  const token = await accessToken();
  if (!token) return { docs: 0, changed: 0, chunks: 0, removed: 0 };
  const pool = getPool();
  const runStart = new Date().toISOString();
  const cur = await query(pool, `SELECT last_edited_at FROM sync_cursor WHERE connector = 'gdrive'`);
  const cursor = cur.rows[0]?.last_edited_at ? new Date(cur.rows[0].last_edited_at).getTime() : 0;

  const files = await collectDocs(token);
  const seenUrls: string[] = [];
  let changed = 0;
  let totalChunks = 0;

  for (const f of files) {
    const url = f.webViewLink ?? `https://docs.google.com/document/d/${f.id}`;
    seenUrls.push(url);
    if (cursor && new Date(f.modifiedTime).getTime() <= cursor) continue;
    const md = await exportDoc(token, f.id);
    await query(pool, `DELETE FROM document_chunk WHERE source = 'gdrive' AND source_url = $1`, [url]);
    if (!md.trim()) continue;
    const docType = classifyDocType('gdrive', f.name);
    const prefix = `구글 문서 — ${f.name}\n`;
    for (const c of chunk(md)) {
      const body = prefix + c;
      const vec = await embed(body);
      await query(
        pool,
        `INSERT INTO document_chunk(source, source_url, project, title, content, embedding, doc_type, updated_at)
         VALUES('gdrive', $1, 'gdrive', $2, $3, $4::vector, $5, $6)`,
        [url, f.name, body, `[${vec.join(',')}]`, docType, f.modifiedTime],
      );
      totalChunks++;
    }
    changed++;
  }

  // 문서를 하나도 못 봤으면(스코프 미부여/재인증 전 등) 커서를 굳히지 않음 → 재인증 후 전체 색인되게.
  if (files.length === 0) return { docs: 0, changed, chunks: totalChunks, removed: 0 };

  let removed = 0;
  if (seenUrls.length > 0) {
    const del = await query(
      pool,
      `DELETE FROM document_chunk WHERE source = 'gdrive' AND source_url <> ALL($1) RETURNING 1`,
      [seenUrls],
    );
    removed = del.rows.length;
  }
  await query(
    pool,
    `INSERT INTO sync_cursor(connector, last_edited_at, updated_at)
     VALUES('gdrive', $1, now())
     ON CONFLICT (connector) DO UPDATE SET last_edited_at = $1, updated_at = now()`,
    [runStart],
  );
  return { docs: files.length, changed, chunks: totalChunks, removed };
}
