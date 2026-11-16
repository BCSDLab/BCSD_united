import { HttpError, isHttpError } from 'interfaces/APIError';

import { getArticleContentUrl } from './contentUrl';

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export async function fetchArticleContent(content: string): Promise<string> {
  const url = getArticleContentUrl(content);
  if (!url) throw new TypeError('Invalid article content URL');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    // 정적 본문에는 서비스 쿠키를 보내지 않으며, 다른 출처로의 이동을 허용하지 않는다.
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'manual',
      headers: { Accept: 'text/plain, text/html' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new HttpError('Unable to load article content', { status: 502 });
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'text/plain' && contentType !== 'text/html') {
      throw new HttpError('Invalid article content type', { status: 502 });
    }
    if (Number(response.headers.get('content-length')) > MAX_CONTENT_BYTES) {
      throw new HttpError('Article content exceeds 2 MiB', { status: 502 });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_CONTENT_BYTES) {
          throw new HttpError('Article content exceeds 2 MiB', { status: 502 });
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError('Unable to load article content', {
      code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
