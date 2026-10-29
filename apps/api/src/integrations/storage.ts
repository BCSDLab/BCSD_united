import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';
import { base64url, decodeBase64url, hmac, required } from '@api/integrations/http';

// eslint-disable-next-line no-control-regex -- 파일 이름의 제어 문자와 경로 구분자를 거부한다
const INVALID_FILENAME_CHARACTERS = /[\x00-\x1f\x7f/\\]/;
// eslint-disable-next-line no-control-regex -- 객체 키와 URL의 제어 문자 및 역슬래시를 거부한다
const INVALID_KEY_CHARACTERS = /[\x00-\x1f\x7f\\]/;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_DOMAINS: Record<string, true> = Object.fromEntries(
  [
    'ITEMS',
    'LANDS',
    'CIRCLES',
    'MARKET',
    'SHOPS',
    'MEMBERS',
    'OWNERS',
    'COOP',
    'ADMIN',
    'LOST_ITEMS',
    'BANNER',
    'CLUB',
    'CALLVAN_REPORT',
    'CALLVAN_CHAT',
    'TEAM_RECRUITMENT',
  ].map((domain) => [domain, true]),
);

export interface UploadInput {
  content_length: number;
  content_type: string;
  file_name: string;
}
export interface FileCapability {
  version: 1;
  method: 'PUT' | 'GET';
  key: string;
  expires: number;
  contentType?: string;
  contentLength?: number;
}

function invalid(message: string): never {
  throw new ApiError(400, 'INVALID_REQUEST', message);
}

export function uploadDomain(value: string): string {
  const domain = value.toUpperCase();
  if (!Object.hasOwn(UPLOAD_DOMAINS, domain))
    throw new ApiError(404, 'NOT_FOUND_IMAGE_UPLOAD_DOMAIN', '이미지 업로드 도메인을 찾을 수 없습니다.');
  return domain;
}

export function validateUploadInput(value: unknown): UploadInput {
  if (!value || typeof value !== 'object') invalid('업로드 정보가 필요합니다.');
  const input = value as Record<string, unknown>;
  if (
    !Number.isInteger(input.content_length) ||
    Number(input.content_length) <= 0 ||
    Number(input.content_length) > 2_147_483_647
  )
    invalid('파일 크기는 0보다 큰 정수여야 합니다.');
  if (
    typeof input.content_type !== 'string' ||
    !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n\0]*)?$/.test(input.content_type)
  )
    invalid('파일 타입은 필수입니다.');
  if (
    typeof input.file_name !== 'string' ||
    !input.file_name.trim() ||
    INVALID_FILENAME_CHARACTERS.test(input.file_name) ||
    input.file_name === '.' ||
    input.file_name === '..'
  )
    invalid('파일 이름이 올바르지 않습니다.');
  return { content_length: Number(input.content_length), content_type: input.content_type, file_name: input.file_name };
}

export function generateFileKey(domain: string, filename: string, now = Date.now(), id = crypto.randomUUID()): string {
  const date = new Date(now + 9 * 60 * 60 * 1000);
  const parts = filename.split('.');
  const extension = parts.pop() ?? '';
  const name = parts.join('');
  return `upload/${uploadDomain(domain)}/${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}/${id}/${name}.${extension}`;
}

function baseUrl(value: string | undefined, name: string): URL {
  const result = new URL(required(value, name));
  if (result.protocol !== 'https:' || result.username || result.password || result.search || result.hash)
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `${name}은 HTTPS URL이어야 합니다.`);
  if (!result.pathname.endsWith('/')) result.pathname += '/';
  return result;
}

function validKey(key: string): boolean {
  return (
    !!key &&
    !INVALID_KEY_CHARACTERS.test(key) &&
    !key.startsWith('/') &&
    key.split('/').every((part) => part !== '.' && part !== '..')
  );
}

function requireValidKey(key: string): void {
  if (!validKey(key)) invalid('잘못된 파일 경로입니다.');
}

function capabilityUrl(env: Bindings, token: string): string {
  return new URL(`storage/capabilities/${token}`, baseUrl(env.API_PUBLIC_URL, 'API_PUBLIC_URL')).href;
}

export function publicFileUrl(env: Bindings, key: string): string {
  requireValidKey(key);
  return `${baseUrl(env.R2_FILES_PUBLIC_URL, 'R2_FILES_PUBLIC_URL').href}${key}`;
}

export function extractFileKey(env: Bindings, value: string): string {
  const base = baseUrl(env.R2_FILES_PUBLIC_URL, 'R2_FILES_PUBLIC_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('허용되지 않은 파일 URL입니다.');
  }
  if (
    INVALID_KEY_CHARACTERS.test(value) ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(base.pathname) ||
    !value.startsWith(base.href)
  )
    invalid('허용되지 않은 파일 URL입니다.');
  const key = value.slice(base.href.length);
  requireValidKey(key);
  return key;
}

export async function readFileText(env: Bindings, url: string): Promise<string> {
  const object = await getFile(env, extractFileKey(env, url));
  if (!object) throw new ApiError(404, 'FILE_NOT_FOUND', '파일을 찾을 수 없습니다.');
  return object.text();
}

export async function readArticleContent(env: Bindings, content: string | null): Promise<string | null> {
  if (!content?.trim().startsWith('https://')) return content;
  let key: string;
  try {
    key = extractFileKey(env, content.trim());
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) return content;
    throw error;
  }
  const object = await getFile(env, key);
  if (!object) throw new ApiError(404, 'FILE_NOT_FOUND', '파일을 찾을 수 없습니다.');
  return object.text();
}

export async function getFile(env: Bindings, key: string): Promise<R2ObjectBody | null> {
  requireValidKey(key);
  return env.FILES.get(key);
}

export async function fileExists(env: Bindings, key: string): Promise<boolean> {
  requireValidKey(key);
  return (await env.FILES.head(key)) !== null;
}

export async function putFile(
  env: Bindings,
  key: string,
  data: ArrayBuffer | ArrayBufferView | ReadableStream | string,
  contentType = 'application/octet-stream',
): Promise<{ file_url: string }> {
  const file_url = publicFileUrl(env, key);
  await env.FILES.put(key, data, { httpMetadata: { contentType } });
  return { file_url };
}

export async function deleteFiles(env: Bindings, keys: string[]): Promise<void> {
  if (keys.some((key) => !validKey(key))) invalid('잘못된 파일 경로입니다.');
  for (let offset = 0; offset < keys.length; offset += 1000) await env.FILES.delete(keys.slice(offset, offset + 1000));
}

function signingSecret(env: Bindings): string {
  const secret = required(env.UPLOAD_SIGNING_SECRET, 'UPLOAD_SIGNING_SECRET');
  if (new TextEncoder().encode(secret).length < 32)
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'UPLOAD_SIGNING_SECRET은 32바이트 이상이어야 합니다.');
  return secret;
}

export async function signCapability(env: Bindings, capability: FileCapability): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(capability)));
  return `${payload}.${base64url(new Uint8Array(await hmac(signingSecret(env), payload)))}`;
}

export async function verifyCapability(
  env: Bindings,
  token: string,
  method: 'PUT' | 'GET',
  now = Date.now(),
): Promise<FileCapability> {
  const forbidden = () => new ApiError(403, 'INVALID_FILE_CAPABILITY', '파일 URL이 만료되었거나 올바르지 않습니다.');
  if (token.length > 8192) throw forbidden();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw forbidden();
  const [payload, signature] = parts as [string, string];
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  let capability: FileCapability;
  try {
    if (!(await crypto.subtle.verify('HMAC', key, decodeBase64url(signature), new TextEncoder().encode(payload))))
      throw forbidden();
    capability = JSON.parse(new TextDecoder().decode(decodeBase64url(payload))) as FileCapability;
  } catch {
    throw forbidden();
  }
  if (
    capability.version !== 1 ||
    capability.method !== method ||
    !Number.isSafeInteger(capability.expires) ||
    capability.expires <= now ||
    typeof capability.key !== 'string' ||
    !validKey(capability.key)
  )
    throw forbidden();
  if (
    method === 'PUT' &&
    (!Number.isSafeInteger(capability.contentLength) ||
      !capability.contentLength ||
      capability.contentLength < 0 ||
      typeof capability.contentType !== 'string')
  )
    throw forbidden();
  return capability;
}

export async function signedDownloadUrl(env: Bindings, key: string, lifetimeSeconds = 600): Promise<string> {
  if (!validKey(key) || !Number.isInteger(lifetimeSeconds) || lifetimeSeconds <= 0 || lifetimeSeconds > 3600)
    invalid('파일 URL 만료 시간이 올바르지 않습니다.');
  const token = await signCapability(env, {
    version: 1,
    method: 'GET',
    key,
    expires: Date.now() + lifetimeSeconds * 1000,
  });
  return capabilityUrl(env, token);
}

export async function uploadUrl(env: Bindings, domain: string, input: UploadInput, now = Date.now()) {
  const key = generateFileKey(domain, input.file_name, now);
  const expires = now + 600_000;
  const token = await signCapability(env, {
    version: 1,
    method: 'PUT',
    key,
    expires,
    contentType: input.content_type,
    contentLength: input.content_length,
  });
  return {
    pre_signed_url: capabilityUrl(env, token),
    file_url: publicFileUrl(env, key),
    expiration_date: new Date(expires + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
  };
}
