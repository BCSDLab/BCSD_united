import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import type { App } from './types';
import { isBundlePath, mappedSourcePath, sourcePath, type TailEvidence } from './tail';

type Frame = TailEvidence['frames'][number];
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_MAP_BYTES = 16 * 1024 * 1024;

export class SourceMapEvidenceError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SourceMapEvidenceError('Invalid source-map evidence');
  return value as Record<string, unknown>;
}

function moduleContent(module: Record<string, unknown>, type: string, limit: number): string {
  const encoded = module.content_base64;
  if (module.content_type !== type || typeof encoded !== 'string' || encoded.length > Math.ceil(limit / 3) * 4)
    throw new SourceMapEvidenceError('Invalid pinned version module');
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (bytes.byteLength > limit) throw new SourceMapEvidenceError('Pinned version module exceeds limit');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SourceMapEvidenceError('Invalid pinned version module');
  }
}

/** 소스맵은 동일 버전의 원본 코드와 일치할 때만 사용하며 코드·sourcesContent는 반환하지 않는다. */
export async function mappedTailFrames(
  workerName: string,
  app: App,
  scriptVersion: string,
  version: Record<string, unknown>,
  frames: Frame[],
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
  if (!Array.isArray(version.modules) || version.modules.length > 2_000)
    throw new SourceMapEvidenceError('Pinned version modules unavailable');
  const modules = new Map<string, Record<string, unknown>>();
  for (const value of version.modules) {
    const module = record(value);
    if (typeof module.name !== 'string' || modules.has(module.name))
      throw new SourceMapEvidenceError('Ambiguous version module');
    modules.set(module.name, module);
  }
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
        const compiled = moduleContent(module, 'application/javascript+module', MAX_BUNDLE_BYTES);
        const reference = /(?:^|\n)\/\/# sourceMappingURL=([A-Za-z0-9_.$/-]+\.map)\s*$/.exec(compiled)?.[1];
        if (!reference || reference.startsWith('/') || reference.includes('..'))
          throw new SourceMapEvidenceError('Invalid source-map reference');
        const mapName = `${frame.path.slice(0, frame.path.lastIndexOf('/') + 1)}${reference}`;
        const sourceMap = modules.get(mapName);
        if (!sourceMap) throw new SourceMapEvidenceError('Source map is absent from the pinned version');
        const raw = record(JSON.parse(moduleContent(sourceMap, 'application/source-map', MAX_MAP_BYTES)));
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
      const path = original.source && mappedSourcePath(original.source, app);
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
