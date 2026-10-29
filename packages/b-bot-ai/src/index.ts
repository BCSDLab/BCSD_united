import { embeddingVector, parseStructured, responseText } from './responses.ts';
import { consumeResponseStream } from './stream.ts';
import { EMBEDDING_MODEL, GENERATION_MODEL, requestAi } from './transport.ts';

const REASONING = { effort: 'none' } as const;

export { hasAiCredentials, runWithAi } from './context.ts';
export type { AiEnvironment } from './context.ts';

export type StructuredImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface StructuredImage {
  data: string;
  mimeType: StructuredImageMimeType;
}

export interface StructuredGenerationRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  images?: StructuredImage[];
  maxTokens?: number;
}

function outputLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('출력 토큰 한도는 양의 정수여야 합니다.');
  }
  return value;
}

function imageInput(image: StructuredImage): Record<string, unknown> {
  if (typeof image.data !== 'string' || !image.data.trim()) {
    throw new Error('이미지 데이터가 비어 있습니다.');
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)) {
    throw new Error('지원하지 않는 이미지 형식입니다. PNG, JPEG, WEBP 또는 GIF를 사용하세요.');
  }
  return {
    type: 'input_image',
    image_url: `data:${image.mimeType};base64,${image.data}`,
    detail: 'auto',
  };
}

export async function generateStructured<T>({
  system,
  prompt,
  schema,
  images = [],
  maxTokens = 4096,
}: StructuredGenerationRequest): Promise<T> {
  const content = [{ type: 'input_text', text: prompt }, ...images.map(imageInput)];
  const result = await requestAi(GENERATION_MODEL, {
    instructions: system,
    input: [{ role: 'user', content }],
    max_output_tokens: outputLimit(maxTokens),
    reasoning: REASONING,
    text: { format: { type: 'json_schema', name: 'structured_response', strict: true, schema } },
    store: false,
  });
  return parseStructured<T>(result);
}

export async function generate(prompt: string, numPredict = 160): Promise<string> {
  return responseText(
    await requestAi(GENERATION_MODEL, {
      input: prompt,
      max_output_tokens: outputLimit(numPredict),
      reasoning: REASONING,
      store: false,
    }),
  ).trim();
}

export async function generateStream(
  prompt: string,
  onText: (full: string) => void,
  numPredict = 160,
): Promise<string> {
  const stream = await requestAi(GENERATION_MODEL, {
    input: prompt,
    max_output_tokens: outputLimit(numPredict),
    reasoning: REASONING,
    stream: true,
    store: false,
  });
  return consumeResponseStream(stream, onText);
}

export async function embed(text: string): Promise<number[]> {
  return embeddingVector(await requestAi(EMBEDDING_MODEL, { text: [text] }));
}
