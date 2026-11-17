#!/usr/bin/env node
// 기능·플랫폼·검사 수준별 증거를 합친다. 화면 진입을 사용자 여정 성공으로 승격하지 않는다.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LEVELS = {
  'web-screen': ['render'],
  'maestro-flow': ['flow'],
  'ios-flow': ['flow'],
  'api-smoke': ['api-smoke'],
  'contract-test': ['contract'],
  journey: ['journey', 'auth', 'empty-error', 'continuity', 'posture'],
};
const PLATFORMS = new Set(['web', 'android', 'ios', 'api']);
const SHA = /^[a-f0-9]{40}$/i;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateMatrix(matrix) {
  requireValue(matrix?.schemaVersion === 1, 'Matrix schemaVersion must be 1');
  requireValue(Array.isArray(matrix.sources), 'Matrix sources must be an array');
  requireValue(Array.isArray(matrix.checks) && matrix.checks.length > 0, 'Matrix must contain acceptance checks');
  const sources = new Map();
  for (const source of matrix.sources) {
    requireValue(
      typeof source.id === 'string' && source.id && !sources.has(source.id),
      'Source ids must be unique nonempty strings',
    );
    requireValue(
      source.invalidated === undefined ||
        (Array.isArray(source.invalidated) && source.invalidated.every((id) => typeof id === 'string' && id)),
      `Invalid invalidated scenarios: ${source.id}`,
    );
    requireValue(
      PLATFORMS.has(source.platform) && LEVELS[source.kind] && SHA.test(source.sha),
      `Invalid source provenance: ${source.id}`,
    );
    requireValue(typeof source.path === 'string' && source.path, `Source report path missing: ${source.id}`);
    sources.set(source.id, source);
  }
  const ids = new Set();
  for (const check of matrix.checks) {
    requireValue(
      typeof check.id === 'string' && check.id && !ids.has(check.id),
      'Check ids must be unique nonempty strings',
    );
    requireValue(
      typeof check.feature === 'string' && check.feature && PLATFORMS.has(check.platform),
      `Invalid feature/platform: ${check.id}`,
    );
    requireValue(
      Object.values(LEVELS).some((levels) => levels.includes(check.level)),
      `Unknown check level: ${check.id}`,
    );
    requireValue(check.source === null || sources.has(check.source), `Unknown source: ${check.id}`);
    requireValue(
      Array.isArray(check.scenarios) && check.scenarios.every((id) => typeof id === 'string' && id),
      `Invalid scenarios: ${check.id}`,
    );
    requireValue(check.source === null || check.scenarios.length > 0, `Linked check needs scenarios: ${check.id}`);
    ids.add(check.id);
  }
  return matrix;
}

export function evaluateMatrix(matrix, reports) {
  validateMatrix(matrix);
  const sources = new Map(matrix.sources.map((source) => [source.id, source]));
  const checks = matrix.checks.map((check) => {
    const result = (status, reason) => ({ ...check, status, reason });
    if (check.source === null) return result('unverified', 'No execution evidence is connected');
    const source = sources.get(check.source);
    if (source.platform !== check.platform || !LEVELS[source.kind].includes(check.level)) {
      return result('blocked', 'Evidence platform or verification level does not satisfy this check');
    }
    const report = reports.get(source.id);
    if (!report) return result('unverified', 'Report has not been collected');
    if (report.readError) return result('blocked', report.readError);
    if (
      report.platform !== source.platform ||
      typeof report.sha !== 'string' ||
      report.sha.toLowerCase() !== source.sha.toLowerCase()
    ) {
      return result('blocked', 'Report platform/commit does not match the declared source');
    }
    if (!['passed', 'failed', 'blocked'].includes(report.status)) return result('blocked', 'Unknown execution status');
    if (!Array.isArray(report.scenarios) || !Array.isArray(report.steps))
      return result('blocked', 'Report has no scenario execution evidence');
    if (report.status === 'blocked') return result('blocked', report.errors?.[0] ?? 'Execution was blocked');
    if (!report.steps.some((step) => step.kind === 'build' && step.phase === 'candidate' && step.passed === true))
      return result('blocked', 'No successful build evidence');
    let missing;
    for (const id of check.scenarios) {
      const scenarios = report.scenarios.filter((scenario) => scenario.id === id);
      const steps = report.steps.filter(
        (step) => step.kind === 'scenario' && step.phase === 'candidate' && step.scenarioId === id,
      );
      if (scenarios.length !== 1 || steps.length === 0) {
        missing ??= `Scenario execution missing or ambiguous: ${id}`;
        continue;
      }
      if (scenarios[0].passed !== true || steps.some((step) => step.passed !== true))
        return result('failed', `Scenario failed: ${id}`);
      if (source.invalidated?.includes(id)) missing ??= `Earlier evidence invalidated by a later observation: ${id}`;
    }
    if (missing) return result('unverified', missing);
    return result('passed', 'Every declared scenario has successful matching command evidence');
  });
  const counts = Object.fromEntries(
    ['passed', 'failed', 'blocked', 'unverified'].map((status) => [
      status,
      checks.filter((check) => check.status === status).length,
    ]),
  );
  return { schemaVersion: 1, passed: checks.every((check) => check.status === 'passed'), counts, checks };
}

const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
export function renderMatrix(report) {
  return [
    '# 통합 검증 범위',
    '',
    '기능별 화면·흐름·API·인증·오류/빈 상태·연속성·접힘 검증을 구분한다. 연결하지 않은 증거는 통과가 아니다.',
    '',
    '| 기능 | 플랫폼 | 검사 수준 | 상태 | 근거 / 사유 |',
    '| --- | --- | --- | --- | --- |',
    ...report.checks.map(
      (check) =>
        `| ${cell(check.feature)} | ${check.platform} | ${check.level} | ${check.status} | ${cell(check.source ?? '-')} / ${cell(check.reason)} |`,
    ),
    '',
  ].join('\n');
}

async function main([manifestPath, outputPath, markdownPath, ...extra]) {
  requireValue(
    manifestPath && outputPath && extra.length === 0,
    'Usage: verify-matrix.mjs MATRIX.json RESULT.json [RESULT.md]',
  );
  const matrix = validateMatrix(JSON.parse(await readFile(manifestPath, 'utf8')));
  const reports = new Map();
  for (const source of matrix.sources) {
    const filename = path.resolve(path.dirname(path.resolve(manifestPath)), source.path);
    try {
      reports.set(source.id, JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT')
        reports.set(source.id, { readError: `Could not read report ${source.id}: ${error.message}` });
    }
  }
  const report = evaluateMatrix(matrix, reports);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (markdownPath) await writeFile(markdownPath, renderMatrix(report));
  console.log(JSON.stringify({ passed: report.passed, counts: report.counts }));
  process.exitCode = report.passed ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
