import { incompleteError, responseText } from './responses.ts';
import { object, upstreamError } from './transport.ts';

export async function consumeResponseStream(value: unknown, onText: (full: string) => void): Promise<string> {
  if (!value || typeof (value as ReadableStream<Uint8Array>).getReader !== 'function') {
    throw new Error('Cloudflare AI가 SSE 스트림을 반환하지 않았습니다.');
  }
  const reader = (value as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let eventName = '';
  let data: string[] = [];
  let full = '';
  let completed: string | undefined;

  function dispatch(): void {
    const event = eventName;
    eventName = '';
    if (data.length === 0) {
      if (event === 'error' || event === 'response.failed') throw upstreamError();
      if (event === 'response.incomplete') throw incompleteError();
      return;
    }
    const text = data.join('\n');
    data = [];
    if (text.trim() === '[DONE]') throw incompleteError();
    let payload: Record<string, unknown> | undefined;
    try {
      payload = object(JSON.parse(text));
    } catch {
      throw new Error('Cloudflare AI 스트림에 올바르지 않은 JSON이 포함되어 있습니다.');
    }
    if (!payload) throw new Error('Cloudflare AI 스트림 이벤트 형식이 올바르지 않습니다.');
    const type = typeof payload.type === 'string' ? payload.type : event;
    if (type === 'error' || type === 'response.failed') {
      throw upstreamError(payload.error ?? object(payload.response)?.error ?? payload);
    }
    if (type === 'response.incomplete') {
      throw incompleteError(object(payload.response)?.incomplete_details);
    }
    if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
      throw new Error('AI가 요청에 대한 응답을 거부했습니다.');
    }
    if (type === 'response.output_text.delta') {
      if (typeof payload.delta !== 'string') {
        throw new Error('Cloudflare AI 스트림 텍스트 형식이 올바르지 않습니다.');
      }
      full += payload.delta;
      onText(full);
    }
    if (type === 'response.completed') {
      const response = object(payload.response);
      if (!response) throw new Error('Cloudflare AI 스트림 완료 응답이 없습니다.');
      completed = responseText(response);
      onText(completed);
    }
  }

  function consumeLines(final: boolean): void {
    while (completed === undefined) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      const separator = buffer[index];
      if (!final && separator === '\r' && index === buffer.length - 1) break;
      const line = buffer.slice(0, index);
      const width = separator === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + width);
      consumeLine(line);
    }
    if (final && completed === undefined) {
      if (buffer.length > 0) consumeLine(buffer);
      buffer = '';
      dispatch();
    }
  }

  function consumeLine(line: string): void {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let content = colon < 0 ? '' : line.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    if (field === 'event') eventName = content;
  }

  try {
    while (completed === undefined) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new Error('Cloudflare AI 스트림 연결이 중단되었습니다. 부분 응답은 사용할 수 없습니다.');
      }
      try {
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new Error('Cloudflare AI 스트림의 UTF-8 데이터가 올바르지 않습니다.');
      }
      consumeLines(chunk.done);
      if (chunk.done) break;
    }
    if (completed === undefined) throw incompleteError();
    return completed;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 이미 끊긴 스트림도 잠금은 해제한다.
    }
    reader.releaseLock();
  }
}
