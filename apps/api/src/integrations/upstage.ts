import { sql } from 'drizzle-orm';
import type { Bindings } from '@api/runtime';
import { createDatabase } from '@api/db/client';
import { schema } from '@api/db/schema';
import { IntegrationError, request, retryAfter, retryableStatus } from '@api/integrations/http';
import { extractFileKey, getFile } from '@api/integrations/storage';

export class UpstageError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly retryAfterMs: number | null, public readonly status: number | null = null) {
    super(message);
    this.name = 'UpstageError';
  }
}

const ICONS = ['CALENDAR', 'TARGET', 'LOCATION', 'ACTION', 'MONEY', 'NOTICE', 'DOCUMENT', 'DEFAULT'];
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_LENGTH = 8000;

export interface SummaryInput { systemMessage: string; userMessage: string; maxItems: number; model?: string; timeoutSeconds?: number }
export interface SummaryResult { items: { icon_key: string; text: string }[] }
export interface ParseDocumentInput {
  url: string;
  fileName?: string;
  maxDocumentBytes?: number;
  downloadTimeoutSeconds?: number;
  parseTimeoutSeconds?: number;
  ocrMode?: string;
  minIntervalMillis?: number;
  allowedUrlPrefixes?: string[];
}

function requireApiKey(env: Bindings): string {
  const apiKey = env.UPSTAGE_API_KEY;
  if (!apiKey?.trim()) throw new UpstageError('Upstage API key가 설정되지 않았습니다.', false, null);
  return apiKey;
}

async function upstageRequest(url: string, init: RequestInit, timeoutSeconds: number): Promise<Response> {
  let response: Response;
  try {
    response = await request('Upstage', url, init, timeoutSeconds * 1000);
  } catch (error) {
    if (error instanceof IntegrationError) {
      throw new UpstageError('Upstage 요청 연결 또는 응답 시간이 초과되었습니다.', true, error.timeout ? null : 60_000);
    }
    throw error;
  }
  if (!response.ok) {
    throw new UpstageError(`Upstage API 호출에 실패했습니다. status=${response.status}`, retryableStatus(response.status), retryAfter(response), response.status);
  }
  return response;
}

function summarySchema(maxItems: number) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'article_summary',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 0,
            maxItems,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['icon_key', 'text'],
              properties: { icon_key: { type: 'string', enum: ICONS }, text: { type: 'string', maxLength: 200 } },
            },
          },
        },
      },
    },
  };
}

interface RawSummaryItem { icon_key?: string | null; text: string }

export async function summarizeArticle(env: Bindings, input: SummaryInput): Promise<SummaryResult> {
  const apiKey = requireApiKey(env);
  const response = await upstageRequest('https://api.upstage.ai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model ?? 'solar-pro4',
      messages: [{ role: 'system', content: input.systemMessage }, { role: 'user', content: input.userMessage }],
      temperature: 0.2,
      top_p: 0.9,
      reasoning_effort: 'low',
      response_format: summarySchema(input.maxItems),
    }),
  }, input.timeoutSeconds ?? 600);
  try {
    const result = await response.json<{ choices?: { message?: { content?: string } }[] }>();
    const content = result.choices?.[0]?.message?.content?.trim();
    if (!content) throw new UpstageError('Upstage 요약 본문이 비어 있습니다.', true, null);
    const unfenced = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const summary = JSON.parse(unfenced) as { items?: RawSummaryItem[] | null };
    const items = summary.items ?? [];
    const wellFormed = Array.isArray(items)
      && items.every((item) => item && typeof item.text === 'string' && (item.icon_key == null || typeof item.icon_key === 'string'));
    if (!wellFormed) throw new UpstageError('Upstage 요약 JSON 형식이 올바르지 않습니다.', true, null);
    return {
      items: items.map((item) => {
        const icon = item.icon_key?.trim().toUpperCase() ?? 'DEFAULT';
        return { icon_key: ICONS.includes(icon) ? icon : 'DEFAULT', text: item.text };
      }),
    };
  } catch (error) {
    if (error instanceof UpstageError) throw error;
    throw new UpstageError('Upstage 요약 JSON 파싱에 실패했습니다.', true, null);
  }
}

export function allowedDocumentUrl(value: string, prefixes = ['https://*.koreatech.in/', 'https://*.koreatech.ac.kr/']): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || /[\s\\]/.test(value)) return false;
  return prefixes.some((prefix) => {
    const wildcard = prefix.startsWith('https://*.');
    let allowed: URL;
    try {
      allowed = new URL(prefix.replace('https://*.', 'https://'));
    } catch {
      return false;
    }
    const hostMatches = url.hostname === allowed.hostname || (wildcard && url.hostname.endsWith(`.${allowed.hostname}`));
    return allowed.protocol === 'https:' && hostMatches && url.pathname.startsWith(allowed.pathname);
  });
}

function tooLarge(): UpstageError {
  return new UpstageError('문서 크기가 허용 범위를 초과했습니다.', false, null);
}

function emptyDownload(): UpstageError {
  return new UpstageError('문서 다운로드 결과가 비어 있습니다.', false, null);
}

async function limitedBytes(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw emptyDownload();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      throw new UpstageError('문서 다운로드 연결이 종료되었거나 응답 시간이 초과되었습니다.', true, 60_000);
    }
    if (result.done) break;
    length += result.value.byteLength;
    if (length > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(result.value);
  }
  if (!length) throw emptyDownload();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 마크다운이 있으면 마크다운을, 없으면 일반 텍스트를 돌려준다. 둘 다 없으면 빈 문자열이다. */
function preferredText(value: unknown): string {
  if (!isObject(value)) return '';
  if (typeof value.markdown === 'string' && value.markdown.trim()) return value.markdown.trim();
  return typeof value.text === 'string' ? value.text.trim() : '';
}

/**
 * Upstage document-parse 응답에서 본문 텍스트를 뽑는다.
 * 최상위 `content`가 있으면 그것만 쓰고, 없으면 `elements`/`pages` 트리를, 그것도 비어 있으면
 * 응답 전체에서 `text`/`markdown` 문자열을 모두 모은다. 결과는 8000자로 자른다.
 */
export function extractDocumentText(root: unknown): string {
  if (!isObject(root)) return '';
  const content = preferredText(root.content);
  if (content) return content.slice(0, MAX_TEXT_LENGTH);
  const texts = new Set<string>();
  const walkElements = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walkElements);
      return;
    }
    if (!isObject(value)) return;
    for (const text of [preferredText(value.content), preferredText(value)]) if (text) texts.add(text);
    walkElements(value.elements);
    walkElements(value.children);
  };
  walkElements(root.elements);
  walkElements(root.pages);
  const collectStrings = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectStrings);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'text' || key === 'markdown') && typeof child === 'string') {
        if (child.trim()) texts.add(child.trim());
      } else {
        collectStrings(child);
      }
    }
  };
  if (!texts.size) collectStrings(root);
  return [...texts].join('\n').trim().slice(0, MAX_TEXT_LENGTH);
}

/** R2에 있는 문서는 키로 직접 읽고, 그 밖의 URL은 허용 목록을 거쳐 내려받는다. */
async function downloadDocument(env: Bindings, input: ParseDocumentInput): Promise<Response> {
  let key: string | null = null;
  if (env.R2_FILES_PUBLIC_URL) {
    try {
      key = extractFileKey(env, input.url);
    } catch {
      key = null;
    }
  }
  if (key !== null) {
    const object = await getFile(env, key);
    if (!object) throw new UpstageError('문서를 찾을 수 없습니다.', false, null, 404);
    return new Response(object.body, { headers: { 'content-length': String(object.size) } });
  }
  if (!allowedDocumentUrl(input.url, input.allowedUrlPrefixes)) throw new UpstageError('허용되지 않은 문서 URL입니다.', false, null);
  return upstageRequest(input.url, { method: 'GET' }, input.downloadTimeoutSeconds ?? 60);
}

/**
 * 파싱 호출 간격을 D1 행 하나로 직렬화한다. 여러 isolate가 동시에 돌아도 `next_at`을 원자적으로
 * 밀어내므로 Upstage 호출 간격이 `interval` 아래로 내려가지 않는다.
 */
async function waitForParseSlot(env: Bindings, interval: number): Promise<void> {
  const db = createDatabase(env.DB);
  const now = Date.now();
  const reserved = await db.get<{ next_at: number }>(sql`INSERT INTO ${schema.native_integration_rate_limit} (id, next_at) VALUES ('upstage-document-parse', ${now + interval}) ON CONFLICT(id) DO UPDATE SET next_at = MAX(${now}, next_at) + ${interval} RETURNING next_at`);
  if (!reserved) throw new UpstageError('문서 파싱 요청 시간을 예약할 수 없습니다.', true, null);
  const wait = reserved.next_at - interval - Date.now();
  if (wait > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, wait);
    await promise;
  }
}

export async function parseDocument(env: Bindings, input: ParseDocumentInput): Promise<string> {
  const apiKey = requireApiKey(env);
  const maxBytes = Math.min(Math.max(input.maxDocumentBytes ?? MAX_DOCUMENT_BYTES, 1), MAX_DOCUMENT_BYTES);
  const download = await downloadDocument(env, input);
  const document = await limitedBytes(download, maxBytes);
  const interval = Math.max(input.minIntervalMillis ?? 1000, 0);
  if (interval > 0) await waitForParseSlot(env, interval);
  const body = new FormData();
  body.set('model', 'document-parse');
  body.set('ocr', input.ocrMode ?? 'auto');
  body.set('output_formats', '["markdown"]');
  body.set('document', new Blob([document]), input.fileName?.trim() || 'document');
  const response = await upstageRequest('https://api.upstage.ai/v1/document-digitization', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body,
  }, input.parseTimeoutSeconds ?? 180);
  try {
    return extractDocumentText(JSON.parse(new TextDecoder().decode(await limitedBytes(response, maxBytes * 2))));
  } catch (error) {
    if (error instanceof UpstageError) throw error;
    throw new UpstageError('Upstage 문서 파싱 응답이 올바르지 않습니다.', true, null);
  }
}
