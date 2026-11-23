import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng, diffImages, encodePng } from './visual-diff.mjs';

const cli = fileURLToPath(new URL('./visual-diff.mjs', import.meta.url));
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Deterministic noise so every filter type has non-trivial neighbours to predict from. */
function noise(width, height, channels) {
  const data = new Uint8Array(width * height * channels);
  let state = 0x2f6e2b1;
  for (let index = 0; index < data.length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data[index] = state >>> 16;
  }
  return data;
}

function solid(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set(pixel, index);
  return { width, height, data };
}

function withPixel(image, x, y, pixel) {
  const data = image.data.slice();
  data.set(pixel, (y * image.width + x) * 4);
  return { ...image, data };
}

function chunk(type, body) {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const framing = Buffer.alloc(8);
  framing.writeUInt32BE(body.length, 0);
  framing.writeUInt32BE(crc32(typed), 4);
  return Buffer.concat([framing.subarray(0, 4), typed, framing.subarray(4)]);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distances = [left, up, upLeft].map((value) => Math.abs(estimate - value));
  return [left, up, upLeft][distances.indexOf(Math.min(...distances))];
}

/** Applies one PNG filter type to a scanline, the inverse of what the decoder must undo. */
function applyFilter(type, line, previous, channels) {
  return line.map((value, x) => {
    const left = x >= channels ? line[x - channels] : 0;
    const up = previous[x];
    const upLeft = x >= channels ? previous[x - channels] : 0;
    const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type];
    return (value - predicted) & 0xff;
  });
}

/** Builds a PNG by hand: `filters[y % filters.length]` per row, IDAT split into `idatParts` chunks. */
function handPng({
  width,
  height,
  channels,
  pixels,
  filters = [0],
  idatParts = 1,
  bitDepth = 8,
  colourType,
  interlace = 0,
}) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    const filter = filters[y % filters.length];
    raw[y * (stride + 1)] = filter;
    raw.set(applyFilter(filter, line, previous, channels), y * (stride + 1) + 1);
    previous = line;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([bitDepth, colourType ?? (channels === 4 ? 6 : 2), 0, 0, interlace], 8);
  const compressed = deflateSync(raw);
  const size = Math.ceil(compressed.length / idatParts);
  const idat = Array.from({ length: idatParts }, (_, index) =>
    chunk('IDAT', compressed.subarray(index * size, (index + 1) * size)),
  );
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), ...idat, chunk('IEND', Buffer.alloc(0))]);
}

function rgbToRgba(pixels) {
  const data = new Uint8Array((pixels.length / 3) * 4).fill(255);
  for (let index = 0; index < pixels.length / 3; index += 1) {
    data.set(pixels.subarray(index * 3, index * 3 + 3), index * 4);
  }
  return data;
}

test('encodePng output decodes back to the same pixels', () => {
  const image = { width: 7, height: 5, data: noise(7, 5, 4) };
  const encoded = encodePng(image);
  assert.deepEqual(encoded.subarray(0, 8), SIGNATURE);
  assert.deepEqual(decodePng(encoded), image);
  assert.deepEqual(decodePng(new Uint8Array(encoded)), image, 'plain Uint8Array input is accepted');
  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8Array(15) }), /width \* height RGBA/);
});

test('scanlines using filter types 1-4 decode to the unfiltered source', () => {
  for (const channels of [3, 4]) {
    const pixels = noise(6, 5, channels);
    const expected = { width: 6, height: 5, data: channels === 4 ? pixels : rgbToRgba(pixels) };
    for (const filters of [[1], [2], [3], [4], [4, 3, 2, 1, 0]]) {
      const png = handPng({ width: 6, height: 5, channels, pixels, filters });
      assert.deepEqual(decodePng(png), expected, `channels ${channels}, filters ${filters}`);
    }
  }
});

test('RGB input decodes to RGBA with alpha 255, also when IDAT is split across chunks', () => {
  const pixels = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
  const expected = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]);
  assert.deepEqual(decodePng(handPng({ width: 2, height: 2, channels: 3, pixels })).data, expected);

  const large = noise(16, 16, 3);
  const split = handPng({ width: 16, height: 16, channels: 3, pixels: large, filters: [4, 1], idatParts: 5 });
  assert.equal(split.toString('latin1').split('IDAT').length - 1, 5);
  assert.deepEqual(decodePng(split), { width: 16, height: 16, data: rgbToRgba(large) });
});

test('corrupted, truncated and unsupported PNG files are rejected with the reason', () => {
  const valid = encodePng(solid(3, 3, [1, 2, 3, 255]));

  const corrupted = Buffer.from(valid);
  corrupted[corrupted.indexOf('IDAT') + 6] ^= 0xff;
  assert.throws(() => decodePng(corrupted), /Invalid PNG: IDAT chunk CRC mismatch/);

  const badHeaderCrc = Buffer.from(valid);
  badHeaderCrc[8 + 8 + 13] ^= 0x01;
  assert.throws(() => decodePng(badHeaderCrc), /Invalid PNG: IHDR chunk CRC mismatch/);

  assert.throws(() => decodePng(valid.subarray(0, valid.length - 12)), /Invalid PNG: truncated before IEND/);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /Invalid PNG: signature mismatch/);

  const base = { width: 2, height: 2, channels: 4, pixels: noise(2, 2, 4) };
  assert.throws(() => decodePng(handPng({ ...base, interlace: 1 })), /Unsupported PNG: interlaced/);
  assert.throws(() => decodePng(handPng({ ...base, bitDepth: 16 })), /Unsupported PNG: 16-bit depth/);
  assert.throws(() => decodePng(handPng({ ...base, colourType: 3 })), /Unsupported PNG: palette colour type 3/);
  assert.throws(() => decodePng(handPng({ ...base, colourType: 0 })), /Unsupported PNG: greyscale colour type 0/);

  const badFilter = handPng({ ...base, filters: [5] });
  assert.throws(() => decodePng(badFilter), /Invalid PNG: unknown filter type 5 on row 0/);
});

test('diffImages counts pixels whose largest channel delta exceeds the threshold', () => {
  const base = solid(3, 2, [100, 100, 100, 255]);

  const identical = diffImages(base, solid(3, 2, [100, 100, 100, 255]), 0.1);
  assert.deepEqual([identical.differing, identical.total], [0, 6]);

  // threshold 0.1 is 25.5 of 255: a delta of 26 is beyond it, 25 is within it.
  const beyond = diffImages(base, withPixel(base, 2, 1, [100, 126, 100, 255]), 0.1);
  assert.deepEqual([beyond.differing, beyond.total], [1, 6]);
  assert.deepEqual([...beyond.data.subarray(20, 24)], [255, 0, 0, 255], 'the differing pixel is opaque red');
  // 100 at 25% opacity on white: 100 * 0.25 + 255 * 0.75 = 216.25
  assert.deepEqual([...beyond.data.subarray(0, 4)], [216, 216, 216, 255]);

  assert.equal(diffImages(base, withPixel(base, 0, 0, [100, 75, 125, 255]), 0.1).differing, 0);
  assert.equal(diffImages(base, withPixel(base, 0, 0, [100, 100, 100, 200]), 0.1).differing, 1, 'alpha only');
  assert.equal(diffImages(base, withPixel(base, 0, 0, [101, 100, 100, 255]), 0).differing, 1);
  // A delta exactly at the threshold (153 / 255 = 0.6) does not exceed it.
  assert.equal(diffImages(base, withPixel(base, 0, 0, [253, 100, 100, 255]), 0.6).differing, 0);
  assert.equal(diffImages(base, withPixel(base, 0, 0, [254, 100, 100, 255]), 0.6).differing, 1);

  // A half-transparent baseline pixel is blended at 12.5%: 0 * 0.125 + 255 * 0.875 = 223.125 (alpha 128 gives 223).
  const translucent = solid(1, 1, [0, 0, 0, 128]);
  assert.deepEqual([...diffImages(translucent, translucent, 0.1).data], [223, 223, 223, 255]);

  assert.throws(() => diffImages(base, solid(2, 3, [100, 100, 100, 255]), 0.1), /same dimensions/);
});

async function workspace(t, baseline, actual) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'development-visual-diff-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = path.join(root, 'checkout');
  const baselineDir = path.join(root, 'baseline');
  await mkdir(path.join(cwd, 'shots'), { recursive: true });
  await mkdir(baselineDir);
  for (const [name, image] of Object.entries(baseline)) await writeFile(path.join(baselineDir, name), encodePng(image));
  for (const [name, image] of Object.entries(actual)) await writeFile(path.join(cwd, 'shots', name), encodePng(image));
  const run = (...extra) =>
    spawnSync(process.execPath, [cli, '--baseline', baselineDir, '--actual', 'shots', '--out', 'diff', ...extra], {
      cwd,
      encoding: 'utf8',
    });
  const result = async () => JSON.parse(await readFile(path.join(cwd, 'diff', 'result.json'), 'utf8'));
  return { cwd, baselineDir, run, result };
}

const white = solid(2, 2, [255, 255, 255, 255]);
const navy = solid(2, 2, [10, 20, 30, 255]);

test('CLI exits 0 and writes no diff image when every screenshot matches its baseline', async (t) => {
  const { cwd, run, result } = await workspace(
    t,
    { 'home.png': white, 'menu.png': navy },
    { 'home.png': white, 'menu.png': navy },
  );
  const outcome = run();
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(await readdir(path.join(cwd, 'diff')), ['result.json']);
  assert.deepEqual(await result(), {
    schemaVersion: 1,
    tool: 'visual-diff',
    threshold: 0.1,
    maxRatio: 0,
    passed: true,
    images: [
      { name: 'home.png', status: 'same', width: 2, height: 2, differing: 0, ratio: 0 },
      { name: 'menu.png', status: 'same', width: 2, height: 2, differing: 0, ratio: 0 },
    ],
  });
  assert.match(outcome.stderr, /\[visual-diff\] ok same home\.png/);
  assert.match(outcome.stderr, /\[visual-diff\] passed: 2 images \(2 same\)/);
});

test('CLI exits 1 for a changed screenshot, writes its diff image, and --max-ratio can accept it', async (t) => {
  const changed = withPixel(navy, 1, 0, [10, 200, 30, 255]);
  const { cwd, run, result } = await workspace(
    t,
    { 'home.png': white, 'menu.png': navy },
    { 'home.png': white, 'menu.png': changed },
  );

  const outcome = run();
  assert.equal(outcome.status, 1, outcome.stderr);
  const report = await result();
  assert.equal(report.passed, false);
  assert.deepEqual(report.images, [
    { name: 'home.png', status: 'same', width: 2, height: 2, differing: 0, ratio: 0 },
    { name: 'menu.png', status: 'different', width: 2, height: 2, differing: 1, ratio: 0.25 },
  ]);
  assert.deepEqual((await readdir(path.join(cwd, 'diff'))).toSorted(), ['menu.png', 'result.json']);
  const diff = decodePng(await readFile(path.join(cwd, 'diff', 'menu.png')));
  assert.deepEqual([diff.width, diff.height], [2, 2]);
  assert.deepEqual([...diff.data.subarray(4, 8)], [255, 0, 0, 255], 'changed pixel (1,0) is red');
  // Unchanged pixels: baseline (10,20,30) at 25% on white, e.g. 10 * 0.25 + 255 * 0.75 = 193.75.
  assert.deepEqual([...diff.data.subarray(0, 4)], [194, 196, 199, 255]);
  assert.match(outcome.stderr, /\[visual-diff\] FAIL different menu\.png 1 px differ \(ratio 0\.25\)/);

  // The same --out is reused: it was written by this script, so it is cleared and rewritten.
  const accepted = run('--max-ratio', '0.25');
  assert.equal(accepted.status, 0, accepted.stderr);
  const acceptedReport = await result();
  assert.deepEqual([acceptedReport.passed, acceptedReport.maxRatio], [true, 0.25]);
  assert.equal(acceptedReport.images[1].status, 'different');
  assert.deepEqual((await readdir(path.join(cwd, 'diff'))).toSorted(), ['menu.png', 'result.json']);

  assert.equal(run('--max-ratio', '0.24').status, 1);
  // A delta of 180 is 0.706 of 255, so a threshold above that no longer counts the pixel.
  const tolerant = run('--threshold', '0.75');
  assert.equal(tolerant.status, 0, tolerant.stderr);
  assert.deepEqual(await readdir(path.join(cwd, 'diff')), ['result.json'], 'the stale diff image is removed');
});

test('CLI exits 1 for a missing, a differently sized, and an unexpected screenshot', async (t) => {
  const cases = [
    ['missing', { 'home.png': white, 'menu.png': navy }, { 'home.png': white }, 'menu.png', { width: 2, height: 2 }],
    [
      'size-mismatch',
      { 'home.png': white },
      { 'home.png': solid(2, 3, [255, 255, 255, 255]) },
      'home.png',
      { width: 2, height: 2, actualWidth: 2, actualHeight: 3 },
    ],
    [
      'unexpected',
      { 'home.png': white },
      { 'home.png': white, 'new.png': solid(4, 1, [0, 0, 0, 255]) },
      'new.png',
      { width: 4, height: 1 },
    ],
  ];
  for (const [status, baseline, actual, name, size] of cases) {
    await t.test(status, async (t) => {
      const { cwd, run, result } = await workspace(t, baseline, actual);
      const outcome = run('--max-ratio', '1');
      assert.equal(outcome.status, 1, outcome.stderr);
      const report = await result();
      assert.equal(report.passed, false);
      assert.deepEqual(
        report.images.find((image) => image.name === name),
        { name, status, width: size.width, height: size.height, differing: null, ratio: null, ...size },
      );
      assert.deepEqual(
        report.images.filter((image) => image.name !== name).map((image) => image.status),
        Array.from({ length: report.images.length - 1 }, () => 'same'),
      );
      assert.deepEqual(await readdir(path.join(cwd, 'diff')), ['result.json']);
      assert.match(outcome.stderr, new RegExp(`FAIL ${status} ${name.replace('.', '\\.')}`));
    });
  }
});

test('CLI exits 2 on usage errors and leaves foreign directories untouched', async (t) => {
  const { cwd, baselineDir, run } = await workspace(t, { 'home.png': white }, { 'home.png': white });
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  const common = ['--baseline', baselineDir, '--actual', 'shots'];

  const absolute = invoke(...common, '--out', path.join(cwd, 'diff'));
  assert.equal(absolute.status, 2);
  assert.match(absolute.stderr, /--out must be a relative directory inside the working directory/);
  assert.equal(invoke(...common, '--out', '../outside').status, 2);
  assert.equal(invoke('--baseline', baselineDir, '--actual', path.join(cwd, 'shots'), '--out', 'diff').status, 2);
  assert.equal(invoke('--baseline', baselineDir, '--actual', '../baseline', '--out', 'diff').status, 2);
  assert.deepEqual((await readdir(cwd)).toSorted(), ['shots'], 'rejected runs create nothing');

  assert.equal(invoke(...common).status, 2, 'missing --out');
  assert.equal(run('--threshold', '1.5').status, 2);
  assert.equal(run('--max-ratio', 'lots').status, 2);
  assert.equal(invoke('--baseline', path.join(cwd, 'absent'), '--actual', 'shots', '--out', 'diff').status, 2);

  const overlapping = invoke(...common, '--out', 'shots');
  assert.equal(overlapping.status, 2);
  assert.match(overlapping.stderr, /--out must not be or contain the --baseline or --actual directory/);

  await mkdir(path.join(cwd, 'notes'));
  await writeFile(path.join(cwd, 'notes', 'keep.txt'), 'operator notes');
  const foreign = invoke(...common, '--out', 'notes');
  assert.equal(foreign.status, 2);
  assert.match(foreign.stderr, /--out must be empty or a directory previously written by this script/);
  assert.equal(await readFile(path.join(cwd, 'notes', 'keep.txt'), 'utf8'), 'operator notes');

  await writeFile(path.join(cwd, 'shots', 'home.png'), 'this is not a png');
  const undecodable = run();
  assert.equal(undecodable.status, 2);
  assert.match(undecodable.stderr, /home\.png: Invalid PNG: signature mismatch/);
});
