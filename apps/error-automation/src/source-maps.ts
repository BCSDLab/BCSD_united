import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import type { App } from './types';
import { isBundlePath, sourcePath, type TailEvidence } from './tail';

type Frame = TailEvidence['frames'][number];
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_MODULE_BYTES = 4 * 1024 * 1024;

export class SourceMapEvidenceError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SourceMapEvidenceError('Invalid source-map evidence');
  return value as Record<string, unknown>;
}

async function contentPart(parts: FormData, name: string): Promise<string> {
  const matches = parts.getAll(name);
  if (matches.length !== 1) throw new SourceMapEvidenceError('Missing or ambiguous version source module');
  const part = matches[0];
  if (typeof part === 'string') {
    if (new TextEncoder().encode(part).byteLength > MAX_MODULE_BYTES)
      throw new SourceMapEvidenceError('Source module exceeds limit');
    return part;
  }
  if (part.size > MAX_MODULE_BYTES) throw new SourceMapEvidenceError('Source module exceeds limit');
  return part.text();
}

async function versionContent(workerName: string, version: string, token: string): Promise<FormData> {
  // 대시보드에서 확인한 버전 지정 원본 경로. 아래에서 공식 버전 API의 코드와도 대조한다.
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/abe06b869950de952decf9df29c6f1a3/workers/scripts/${workerName}?deployment=${version}`,
    { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) },
  );
  const type = response.headers.get('content-type');
  if (!response.ok || !response.body || !type?.startsWith('multipart/form-data;')) {
    await response.body?.cancel();
    throw new SourceMapEvidenceError('Pinned version source content unavailable', response.status);
  }
  let received = 0;
  const limited = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_CONTENT_BYTES) throw new SourceMapEvidenceError('Version source content exceeds limit');
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { headers: { 'Content-Type': type } }).formData();
}

/** 소스맵은 동일 버전의 원본 코드와 일치할 때만 사용하며 코드·sourcesContent는 반환하지 않는다. */
export async function mappedTailFrames(
  workerName: string,
  app: App,
  scriptVersion: string,
  version: Record<string, unknown>,
  frames: Frame[],
  token: string,
): Promise<Frame[]> {
  if (
    workerName !== `koin-${app}` ||
    version.id !== scriptVersion ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(scriptVersion)
  ) {
    throw new SourceMapEvidenceError('Source-map version or Worker mismatch');
  }
  if (
    !frames.length ||
    frames.length > 12 ||
    frames.some(
      (frame) =>
        !Number.isSafeInteger(frame.line) ||
        frame.line < 1 ||
        frame.line > 1_000_000 ||
        !Number.isSafeInteger(frame.column) ||
        frame.column < 1 ||
        frame.column > 10_000 ||
        (!sourcePath(frame.path, app) && !isBundlePath(frame.path)),
    )
  ) {
    throw new SourceMapEvidenceError('Invalid Tail frame');
  }
  if (!frames.some((frame) => isBundlePath(frame.path))) {
    return frames.map((frame) => ({ ...frame, path: sourcePath(frame.path, app)! }));
  }
  if (!Array.isArray(version.modules)) throw new SourceMapEvidenceError('Pinned version modules unavailable');
  const modules = new Map<string, Record<string, unknown>>();
  for (const value of version.modules) {
    const module = record(value);
    if (typeof module.name !== 'string' || modules.has(module.name))
      throw new SourceMapEvidenceError('Ambiguous version module');
    modules.set(module.name, module);
  }
  const parts = await versionContent(workerName, scriptVersion, token);
  const maps = new Map<string, TraceMap>();
  const result: Frame[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    let mapped = frame;
    if (isBundlePath(frame.path)) {
      let map = maps.get(frame.path);
      if (!map) {
        const module = modules.get(frame.path);
        if (!module) throw new SourceMapEvidenceError('Bundle is absent from the pinned version');
        const encoded = module.content_base64;
        if (typeof encoded !== 'string' || encoded.length > (MAX_MODULE_BYTES * 4) / 3 + 4) {
          throw new SourceMapEvidenceError('Invalid pinned version module');
        }
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
        const pinned = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const compiled = await contentPart(parts, frame.path);
        if (compiled !== pinned) throw new SourceMapEvidenceError('Source content does not match the pinned version');
        const reference = /(?:^|\n)\/\/# sourceMappingURL=([A-Za-z0-9_.$/-]+\.map)\s*$/.exec(compiled)?.[1];
        if (!reference || reference.startsWith('/') || reference.includes('..'))
          throw new SourceMapEvidenceError('Invalid source-map reference');
        const mapName = `${frame.path.slice(0, frame.path.lastIndexOf('/') + 1)}${reference}`;
        const raw = record(JSON.parse(await contentPart(parts, mapName)));
        if (
          raw.version !== 3 ||
          raw.file !== frame.path ||
          !Array.isArray(raw.sources) ||
          raw.sources.length > 20_000 ||
          typeof raw.mappings !== 'string' ||
          'sections' in raw
        ) {
          throw new SourceMapEvidenceError('Invalid pinned source map');
        }
        // TraceMap에는 원문 소스를 넘기지 않는다. 매핑에 필요한 위치 정보만 사용한다.
        map = new TraceMap({
          version: 3,
          names: [],
          sources: raw.sources.map((source) => (typeof source === 'string' ? source : '')),
          sourceRoot: typeof raw.sourceRoot === 'string' ? raw.sourceRoot : undefined,
          mappings: raw.mappings,
        });
        maps.set(frame.path, map);
      }
      const original = originalPositionFor(map, { line: frame.line, column: frame.column - 1 });
      const path = original.source && sourcePath(original.source, app);
      if (
        !path ||
        original.line === null ||
        original.column === null ||
        original.line < 1 ||
        original.line > 1_000_000 ||
        original.column < 0 ||
        original.column >= 10_000
      )
        continue;
      mapped = { path, line: original.line, column: original.column + 1 };
    } else {
      mapped = { ...frame, path: sourcePath(frame.path, app)! };
    }
    const key = `${mapped.path}:${mapped.line}:${mapped.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(mapped);
    }
  }
  if (!result.length) throw new SourceMapEvidenceError('No mapped source in the approved app');
  return result;
}
