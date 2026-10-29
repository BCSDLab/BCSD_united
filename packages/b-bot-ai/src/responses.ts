import { object, upstreamError, unwrapResult } from './transport.ts';

export function incompleteError(details?: unknown): Error {
  return object(details)?.reason === 'max_output_tokens'
    ? new Error('AI 응답이 출력 토큰 한도에 도달해 잘렸습니다. maxTokens 또는 numPredict를 늘려 다시 요청하세요.')
    : new Error('AI 응답이 완료되지 않았습니다. 부분 응답은 사용할 수 없습니다.');
}

export function responseText(value: unknown): string {
  const response = object(unwrapResult(value));
  if (!response) throw new Error('Cloudflare AI 응답 형식이 올바르지 않습니다.');
  if (response.error) throw upstreamError(response.error);
  if (response.status === 'failed' || response.status === 'cancelled') throw upstreamError();
  if (response.status === 'incomplete') throw incompleteError(response.incomplete_details);
  if (response.status !== undefined && response.status !== 'completed') {
    throw new Error('AI 응답이 완료되지 않았습니다. 부분 응답은 사용할 수 없습니다.');
  }
  const pieces: string[] = [];
  if (Array.isArray(response.output)) {
    for (const rawItem of response.output) {
      const item = object(rawItem);
      if (item?.type !== 'message') continue;
      if (item.status === 'incomplete') throw incompleteError(response.incomplete_details);
      if (item.status !== undefined && item.status !== 'completed') throw upstreamError();
      if (!Array.isArray(item.content)) continue;
      for (const rawPart of item.content) {
        const part = object(rawPart);
        if (part?.type === 'refusal' || part?.refusal) {
          throw new Error('AI가 요청에 대한 응답을 거부했습니다.');
        }
        if (part?.type === 'output_text' && typeof part.text === 'string') pieces.push(part.text);
      }
    }
  }
  const text = typeof response.output_text === 'string' ? response.output_text : pieces.join('');
  if (!text.trim()) throw new Error('AI가 빈 응답을 반환했습니다.');
  return text;
}

export function parseStructured<T>(value: unknown): T {
  const text = responseText(value);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('AI 응답이 올바른 JSON이 아닙니다. 요청을 다시 확인하세요.');
  }
}

export function embeddingVector(value: unknown): number[] {
  const response = object(unwrapResult(value));
  if (response?.error) throw upstreamError(response.error);
  const vector: unknown = Array.isArray(response?.data) ? response.data[0] : undefined;
  if (!Array.isArray(vector) || vector.length !== 1024) {
    throw new Error('Cloudflare BGE-M3 응답은 유한한 숫자 1024개로 된 임베딩이어야 합니다.');
  }
  for (const coordinate of vector) {
    if (typeof coordinate === 'number' && Number.isFinite(coordinate)) continue;
    throw new Error('Cloudflare BGE-M3 응답은 유한한 숫자 1024개로 된 임베딩이어야 합니다.');
  }
  return vector as number[];
}
