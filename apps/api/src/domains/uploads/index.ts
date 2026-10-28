import type { Context, Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import { ApiError } from '@api/errors';
import { requirePrincipal } from '@api/auth';
import { generateFileKey, MAX_UPLOAD_BYTES, putFile, uploadDomain, uploadUrl, validateUploadInput, verifyCapability } from '@api/integrations/storage';

async function boundedMultipart(request: Request): Promise<FormData> {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'multipart/form-data 요청이 필요합니다.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_REQUEST', '파일이 필요합니다.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new ApiError(413, 'MAX_UPLOAD_SIZE_EXCEEDED', '파일 업로드 요청은 10MB 이하여야 합니다.');
    }
    chunks.push(chunk.value);
  }
  try {
    return await new Response(new Blob(chunks), { headers: { 'content-type': request.headers.get('content-type')! } }).formData();
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', '파일 업로드 요청이 올바르지 않습니다.');
  }
}

function multipartInput(file: FormDataEntryValue | null): File {
  if (!(file instanceof File)) throw new ApiError(400, 'INVALID_REQUEST', '파일이 필요합니다.');
  validateUploadInput({ content_length: file.size || 1, content_type: file.type || 'application/octet-stream', file_name: file.name });
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'MAX_UPLOAD_SIZE_EXCEEDED', '파일 크기는 10MB 이하여야 합니다.');
  return file;
}

/** 업로드는 비로그인도 허용한다. 토큰이 있으면 알려진 회원 유형인지만 확인한다. */
function requireKnownPrincipal(c: Context<ApiEnv>): void {
  if (c.get('principal')) requirePrincipal(c, ['GENERAL', 'STUDENT', 'OWNER', 'COOP', 'ADMIN', 'COUNCIL']);
}

export function registerUploads(app: Hono<ApiEnv>): void {
  app.post('/:domain/upload/url', async (c) => {
    requireKnownPrincipal(c);
    const domain = uploadDomain(c.req.param('domain'));
    const input = validateUploadInput(await c.req.json());
    return c.json(await uploadUrl(c.env, domain, input));
  });

  app.post('/:domain/upload/file', async (c) => {
    requireKnownPrincipal(c);
    const domain = uploadDomain(c.req.param('domain'));
    const form = await boundedMultipart(c.req.raw);
    const file = multipartInput(form.get('multipartFile'));
    return c.json(await putFile(c.env, generateFileKey(domain, file.name), await file.arrayBuffer(), file.type || 'application/octet-stream'), 201);
  });

  app.post('/:domain/upload/files', async (c) => {
    requireKnownPrincipal(c);
    const domain = uploadDomain(c.req.param('domain'));
    const form = await boundedMultipart(c.req.raw);
    const entries = form.getAll('files');
    if (!entries.length) throw new ApiError(400, 'INVALID_REQUEST', '파일이 필요합니다.');
    const files = entries.map(multipartInput);
    const file_urls: string[] = [];
    for (const file of files) {
      const response = await putFile(c.env, generateFileKey(domain, file.name), await file.arrayBuffer(), file.type || 'application/octet-stream');
      file_urls.push(response.file_url);
    }
    return c.json({ file_urls }, 201);
  });

  app.put('/storage/capabilities/:token', async (c) => {
    const capability = await verifyCapability(c.env, c.req.param('token'), 'PUT');
    if (c.req.header('content-type') !== capability.contentType || !c.req.raw.body) throw new ApiError(400, 'UPLOAD_METADATA_MISMATCH', '파일 타입이 업로드 요청과 일치하지 않습니다.');
    const length = c.req.header('content-length');
    if (length && Number(length) !== capability.contentLength) throw new ApiError(400, 'UPLOAD_METADATA_MISMATCH', '파일 크기가 업로드 요청과 일치하지 않습니다.');
    // 선언된 길이보다 짧거나 길면 스트림이 실패해 R2 쓰기도 실패한다.
    const stream = new FixedLengthStream(capability.contentLength!);
    try {
      await Promise.all([
        c.req.raw.body.pipeTo(stream.writable),
        c.env.FILES.put(capability.key, stream.readable, { httpMetadata: { contentType: capability.contentType } }),
      ]);
    } catch {
      throw new ApiError(400, 'UPLOAD_FAILED', '파일 크기가 일치하지 않거나 업로드에 실패했습니다.');
    }
    return c.body(null, 200);
  });

  app.get('/storage/capabilities/:token', async (c) => {
    const capability = await verifyCapability(c.env, c.req.param('token'), 'GET');
    const object = await c.env.FILES.get(capability.key);
    if (!object) throw new ApiError(404, 'FILE_NOT_FOUND', '파일을 찾을 수 없습니다.');
    const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment' });
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  });
}
