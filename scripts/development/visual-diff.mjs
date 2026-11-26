#!/usr/bin/env node
// 계약: 고정 커밋에서 찍은 스크린샷(--actual)을 기준 이미지(--baseline)와 픽셀 단위로 비교한다.
// - --baseline 바로 아래의 *.png마다 --actual의 같은 이름 파일과 비교한다(하위 폴더는 보지 않는다).
//   기준에만 있으면 missing, 크기가 다르면 size-mismatch, --actual에만 있으면 unexpected이며 모두 실패다.
// - 픽셀은 RGBA 채널 차이의 최댓값이 threshold * 255를 넘을 때 다르다고 본다.
//   이미지는 다른 픽셀 비율(ratio)이 --max-ratio를 넘을 때 실패한다.
// - --out(cwd 안쪽 상대 경로)에 result.json을 쓰고, different 이미지마다 같은 이름의 PNG를 쓴다.
//   다른 픽셀은 불투명한 빨강, 나머지는 기준 픽셀을 25% 불투명도로 흰 바탕에 얹은 색이다.
// - --out은 비어 있거나 이 스크립트가 만든 디렉터리여야 하며, 재실행 시 그 디렉터리만 비운다.
// - 종료 코드: 0 모든 이미지 통과, 1 하나라도 실패, 2 사용법·디코딩 오류.
// 한계: PNG는 node:zlib만으로 다루며 8비트 RGB·RGBA 비인터레이스만 읽는다. 그 밖의 형식은
// `Unsupported PNG` 오류로 거부한다. 기준 이미지를 갱신하는 기능은 없다. 기준 교체는 사람이 결정한다.
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const TOOL = 'visual-diff';
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOUR_TYPES = { 0: 'greyscale', 3: 'palette', 4: 'greyscale with alpha' };
const usage =
  'Usage: visual-diff.mjs --baseline DIR --actual RELATIVE_DIR --out RELATIVE_DIR [--threshold 0.1] [--max-ratio 0]';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const fromLeft = Math.abs(estimate - left);
  const fromUp = Math.abs(estimate - up);
  const fromUpLeft = Math.abs(estimate - upLeft);
  if (fromLeft <= fromUp && fromLeft <= fromUpLeft) return left;
  return fromUp <= fromUpLeft ? up : upLeft;
}

/** Reverses the scanline filters in place and returns the pixels as RGBA. */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const line = raw.subarray(start + 1, start + 1 + stride);
    switch (raw[start]) {
      case 0:
        break;
      case 1:
        for (let x = channels; x < stride; x += 1) line[x] += line[x - channels];
        break;
      case 2:
        for (let x = 0; x < stride; x += 1) line[x] += previous[x];
        break;
      case 3:
        for (let x = 0; x < stride; x += 1) {
          line[x] += ((x >= channels ? line[x - channels] : 0) + previous[x]) >> 1;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x += 1) {
          line[x] +=
            x >= channels ? paeth(line[x - channels], previous[x], previous[x - channels]) : paeth(0, previous[x], 0);
        }
        break;
      default:
        throw new Error(`Invalid PNG: unknown filter type ${raw[start]} on row ${y}`);
    }
    if (channels === 4) data.set(line, y * stride);
    else {
      for (let x = 0, target = y * width * 4; x < stride; x += 3, target += 4) {
        data[target] = line[x];
        data[target + 1] = line[x + 1];
        data[target + 2] = line[x + 2];
        data[target + 3] = 255;
      }
    }
    previous = line;
  }
  return data;
}

/** Decodes an 8-bit RGB or RGBA non-interlaced PNG into `{ width, height, data }` with RGBA bytes. */
export function decodePng(input) {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  requireValue(
    buffer.length >= SIGNATURE.length && buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE),
    'Invalid PNG: signature mismatch',
  );
  let header = null;
  let ended = false;
  let transparency = false;
  const parts = [];
  for (let offset = SIGNATURE.length; !ended;) {
    requireValue(offset + 12 <= buffer.length, 'Invalid PNG: truncated before IEND');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.latin1Slice(offset + 4, offset + 8);
    const end = offset + 8 + length;
    requireValue(end + 4 <= buffer.length, `Invalid PNG: ${type} chunk is truncated`);
    requireValue(
      crc32(buffer.subarray(offset + 4, end)) === buffer.readUInt32BE(end),
      `Invalid PNG: ${type} chunk CRC mismatch`,
    );
    const body = buffer.subarray(offset + 8, end);
    requireValue((type === 'IHDR') === (header === null), 'Invalid PNG: IHDR must be the first chunk and appear once');
    if (type === 'IHDR') {
      requireValue(length === 13, 'Invalid PNG: IHDR must be 13 bytes');
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colourType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') ended = true;
    else if (type === 'tRNS') transparency = true;
    else requireValue(type === 'PLTE' || /^[a-z]/.test(type), `Unsupported PNG: critical chunk ${type}`);
    offset = end + 4;
  }
  const { width, height, bitDepth, colourType } = header;
  requireValue(width > 0 && height > 0, 'Invalid PNG: width and height must be positive');
  requireValue(
    colourType === 2 || colourType === 6,
    `Unsupported PNG: ${COLOUR_TYPES[colourType] ?? 'unknown'} colour type ${colourType}`,
  );
  requireValue(bitDepth === 8, `Unsupported PNG: ${bitDepth}-bit depth`);
  requireValue(header.compression === 0 && header.filter === 0, 'Invalid PNG: unknown compression or filter method');
  requireValue(header.interlace === 0, 'Unsupported PNG: interlaced image');
  requireValue(!transparency, 'Unsupported PNG: tRNS transparency');
  requireValue(parts.length > 0, 'Invalid PNG: no IDAT chunk');
  const channels = colourType === 6 ? 4 : 3;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch (error) {
    throw new Error(`Invalid PNG: image data could not be inflated (${error.message})`, { cause: error });
  }
  requireValue(
    raw.length === height * (width * channels + 1),
    `Invalid PNG: image data is ${raw.length} bytes, expected ${height * (width * channels + 1)}`,
  );
  return { width, height, data: unfilter(raw, width, height, channels) };
}

function chunk(type, body) {
  const output = Buffer.alloc(body.length + 12);
  output.writeUInt32BE(body.length, 0);
  output.write(type, 4, 'latin1');
  body.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, body.length + 8)), body.length + 8);
  return output;
}

/** Encodes RGBA bytes as an 8-bit RGBA PNG whose scanlines all use filter type 0. */
export function encodePng({ width, height, data }) {
  requireValue(
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0,
    'PNG width and height must be positive integers',
  );
  requireValue(data.length === width * height * 4, 'PNG data must hold width * height RGBA pixels');
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Counts the pixels of `b` that differ from baseline `a` and renders them:
 * differing pixels are opaque red, the rest is the baseline at 25% opacity on white.
 */
export function diffImages(a, b, threshold) {
  requireValue(a.width === b.width && a.height === b.height, 'Images must have the same dimensions');
  // Largest channel delta that is still within the threshold, found without `threshold * 255` rounding error.
  let limit = 0;
  while (limit < 255 && (limit + 1) / 255 <= threshold) limit += 1;
  const total = a.width * a.height;
  const data = new Uint8Array(total * 4);
  let differing = 0;
  for (let index = 0; index < data.length; index += 4) {
    const delta = Math.max(
      Math.abs(a.data[index] - b.data[index]),
      Math.abs(a.data[index + 1] - b.data[index + 1]),
      Math.abs(a.data[index + 2] - b.data[index + 2]),
      Math.abs(a.data[index + 3] - b.data[index + 3]),
    );
    if (delta > limit) {
      differing += 1;
      data[index] = 255;
    } else {
      const opacity = (a.data[index + 3] / 255) * 0.25;
      for (let channel = 0; channel < 3; channel += 1) {
        data[index + channel] = Math.round(a.data[index + channel] * opacity + 255 * (1 - opacity));
      }
    }
    data[index + 3] = 255;
  }
  return { differing, total, data };
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function relativeSegments(value, flag) {
  const segments = value.split(/[\\/]/);
  requireValue(
    !path.isAbsolute(value) && !value.includes(':') && segments.every((part) => part && part !== '.' && part !== '..'),
    `${flag} must be a relative directory inside the working directory`,
  );
  return segments;
}

function fraction(value, flag) {
  requireValue(/^\d+(\.\d+)?$/.test(value) && Number(value) <= 1, `${flag} must be a number from 0 to 1`);
  return Number(value);
}

async function pngNames(directory, flag) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    throw new Error(`${flag} must be an existing directory: ${error.message}`, { cause: error });
  });
  return entries
    .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
}

async function readImage(directory, name) {
  const filename = path.join(directory, name);
  try {
    return decodePng(await readFile(filename));
  } catch (error) {
    throw new Error(`${filename}: ${error.message}`, { cause: error });
  }
}

async function prepareOutput(root, out, inputs) {
  const directory = path.join(root, ...relativeSegments(out, '--out'));
  const existing = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null) await mkdir(directory, { recursive: true });
  const real = await realpath(directory);
  requireValue(within(root, real) && real !== root, '--out escapes the working directory');
  requireValue(
    inputs.every((input) => !within(real, input)),
    '--out must not be or contain the --baseline or --actual directory',
  );
  if (existing?.length > 0) {
    const previous = await readFile(path.join(real, 'result.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    requireValue(previous?.tool === TOOL, '--out must be empty or a directory previously written by this script');
    for (const name of existing) await rm(path.join(real, name), { recursive: true });
  }
  return real;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      baseline: { type: 'string' },
      actual: { type: 'string' },
      out: { type: 'string' },
      threshold: { type: 'string', default: '0.1' },
      'max-ratio': { type: 'string', default: '0' },
    },
    strict: true,
    allowPositionals: false,
  });
  requireValue(values.baseline && values.actual && values.out, usage);
  const threshold = fraction(values.threshold, '--threshold');
  const maxRatio = fraction(values['max-ratio'], '--max-ratio');

  const root = await realpath(process.cwd());
  const baselineDir = path.resolve(root, values.baseline);
  const actualDir = path.join(root, ...relativeSegments(values.actual, '--actual'));
  const baselineNames = await pngNames(baselineDir, '--baseline');
  const actualNames = await pngNames(actualDir, '--actual');
  requireValue(baselineNames.length > 0, '--baseline contains no PNG files');
  requireValue(within(root, await realpath(actualDir)), '--actual escapes the working directory');
  const directory = await prepareOutput(root, values.out, [await realpath(baselineDir), await realpath(actualDir)]);

  const images = [];
  let passed = true;
  for (const name of baselineNames) {
    const baseline = await readImage(baselineDir, name);
    const image = {
      name,
      status: 'missing',
      width: baseline.width,
      height: baseline.height,
      differing: null,
      ratio: null,
    };
    if (actualNames.includes(name)) {
      const actual = await readImage(actualDir, name);
      if (actual.width !== baseline.width || actual.height !== baseline.height) {
        Object.assign(image, { status: 'size-mismatch', actualWidth: actual.width, actualHeight: actual.height });
      } else {
        const { differing, total, data } = diffImages(baseline, actual, threshold);
        Object.assign(image, { status: differing === 0 ? 'same' : 'different', differing, ratio: differing / total });
        if (differing > 0) await writeFile(path.join(directory, name), encodePng({ ...baseline, data }));
      }
    }
    images.push(image);
  }
  for (const name of actualNames.filter((candidate) => !baselineNames.includes(candidate))) {
    const { width, height } = await readImage(actualDir, name);
    images.push({ name, status: 'unexpected', width, height, differing: null, ratio: null });
  }

  const counts = {};
  for (const image of images) {
    const failed = image.ratio === null || image.ratio > maxRatio;
    if (failed) passed = false;
    counts[image.status] = (counts[image.status] ?? 0) + 1;
    const detail = image.ratio === null ? '' : ` ${image.differing} px differ (ratio ${image.ratio})`;
    console.error(`[${TOOL}] ${failed ? 'FAIL' : 'ok'} ${image.status} ${image.name}${detail}`);
  }
  const result = { schemaVersion: 1, tool: TOOL, threshold, maxRatio, passed, images };
  await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const summary = Object.entries(counts).map(([status, count]) => `${count} ${status}`);
  console.error(`[${TOOL}] ${passed ? 'passed' : 'failed'}: ${images.length} images (${summary.join(', ')})`);
  return passed ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[${TOOL}] ${error.message}`);
      process.exitCode = 2;
    },
  );
}
