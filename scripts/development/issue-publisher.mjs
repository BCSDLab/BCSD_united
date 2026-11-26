#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { eligibleProductFault, validateScreenRun } from './web-screen-evidence.mjs';
import { INVENTORY, validateInventory } from './web-suite.mjs';

const REPO = 'BCSDLab/BCSD_united';
const BRANCH = 'refs/heads/develop';
const DISPATCH_LIMIT = 65_535;
const screens = new Map(validateInventory(JSON.parse(await readFile(INVENTORY, 'utf8'))).map((s) => [s.id, s]));
const allowedIds = new Set(screens.keys());

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

function hasKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Malformed JSON');
  }
}

function faults(run) {
  try {
    validateScreenRun(run, allowedIds);
  } catch {
    throw new Error('Invalid normalized screen run');
  }
  const product = new Map();
  for (const obs of run.observations) {
    if (obs.status !== 'product-failure') continue;
    const screen = screens.get(obs.screenId);
    requireValue(
      eligibleProductFault(screen, obs.viewport, obs.signature),
      'Fault is not evidence of a product target failure',
    );
    product.set(`${obs.screenId}:${obs.viewport}`, obs);
  }
  return product;
}

export function reviewPair(baseline, confirmation) {
  const first = faults(baseline);
  const second = faults(confirmation);
  requireValue(
    baseline.runId === confirmation.parentRunId &&
      baseline.runId !== confirmation.runId &&
      baseline.parentRunId !== confirmation.runId,
    'Confirmation must be a distinct direct rerun',
  );
  requireValue(
    baseline.appSha === confirmation.appSha && baseline.harnessSha === confirmation.harnessSha,
    'Commits differ between runs',
  );
  const candidates = [];
  for (const [key, { screenId, viewport, signature }] of second) {
    if (first.get(key)?.signature !== signature) continue;
    const screen = screens.get(screenId);
    const marker = `<!-- koin-harness:v1:stage:${key}:${signature} -->`;
    const evidenceMarker = `<!-- koin-harness-evidence:v1:${baseline.appSha}:${baseline.harnessSha} -->`;
    const evidence = `${evidenceMarker}\n앱: \`${baseline.appSha}\` · 하네스: \`${baseline.harnessSha}\`\n원본 실행: \`${baseline.runId}\` · 재검증: \`${confirmation.runId}\``;
    const title = `[Stage 하네스] ${screenId} (${viewport}): ${signature}`;
    const body = `${marker}\nstage에서 같은 화면의 제품 오류가 재현됐습니다.\n\n화면: \`${screen.path}\` · 뷰포트: \`${viewport}\`\n라우트: \`apps/web/src/routes/${screen.route}\`\n오류 분류: \`${signature}\`\n\n${evidence}`;
    candidates.push({ marker, evidenceMarker, title, body, evidence });
  }
  return candidates;
}

export function dispatchInputs(baseline, confirmation) {
  reviewPair(baseline, confirmation);
  const inputs = JSON.stringify({ baseline: JSON.stringify(baseline), confirmation: JSON.stringify(confirmation) });
  requireValue(Buffer.byteLength(inputs) <= DISPATCH_LIMIT, 'Dispatch payload exceeds the GitHub input limit');
  return inputs;
}

async function* pages(request, route, query = '') {
  for (let page = 1; ; page++) {
    const rows = await request(`${route}?${query}per_page=100&page=${page}`);
    requireValue(Array.isArray(rows) && rows.length <= 100, 'Invalid GitHub list response');
    yield* rows;
    if (rows.length < 100) return;
  }
}

// 다른 작성자가 공개 마커를 복사해도 기존 이슈나 검증 증거로 인정하지 않는다.
function botBody(row) {
  return row.user?.id === 41898282 && row.user.type === 'Bot' && typeof row.body === 'string' ? row.body : '';
}

export async function publishCandidates(candidates, request) {
  const result = { created: 0, updated: 0, unchanged: 0 };
  if (!candidates.length) return result;
  const wanted = new Set(candidates.map(({ marker }) => marker));
  const existing = new Map();
  for await (const issue of pages(request, '/issues', 'state=open&sort=created&direction=asc&')) {
    if (issue.pull_request || issue.state !== 'open') continue;
    const marker = botBody(issue).split('\n', 1)[0].trimEnd();
    if (!wanted.has(marker)) continue;
    requireValue(
      Number.isSafeInteger(issue.number) && issue.number > 0 && !existing.has(marker),
      'Ambiguous or invalid open harness issue',
    );
    existing.set(marker, issue);
  }
  for (const { marker, evidenceMarker, evidence, title, body } of candidates) {
    const issue = existing.get(marker);
    if (!issue) {
      await request('/issues', { title, body });
      result.created++;
      continue;
    }
    let recorded = issue.body.split(/\r?\n/).includes(evidenceMarker);
    const route = `/issues/${issue.number}/comments`;
    if (!recorded) {
      for await (const comment of pages(request, route)) {
        if (botBody(comment).split('\n', 1)[0].trimEnd() === evidenceMarker) {
          recorded = true;
          break;
        }
      }
    }
    if (recorded) result.unchanged++;
    else {
      await request(route, { body: evidence });
      result.updated++;
    }
  }
  return result;
}

async function githubRequest(route, payload) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${route}`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    ...(payload && { body: JSON.stringify(payload) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  requireValue(response.status === (payload ? 201 : 200), `GitHub request failed (HTTP ${response.status})`);
  // 쓰기 결과가 불확실하면 재전송하지 않는다. 다시 디스패치할 때 열린 이슈부터 읽는다.
  if (payload) return;
  return parseJson(await response.text());
}

function trustedWorkflow(env) {
  return (
    env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === REPO &&
    env.GITHUB_REF === BRANCH &&
    env.GITHUB_WORKFLOW_REF === `${REPO}/.github/workflows/harness-issues.yml@${BRANCH}` &&
    env.GITHUB_EVENT_PATH &&
    env.GITHUB_TOKEN
  );
}

export async function main(argv, env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      baseline: { type: 'string' },
      confirmation: { type: 'string' },
      'validate-only': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'dispatch-inputs': { type: 'boolean' },
      publish: { type: 'boolean' },
    },
  });
  const modes = ['validate-only', 'dry-run', 'dispatch-inputs', 'publish'].filter((key) => values[key]);
  requireValue(modes.length === 1, 'Choose --validate-only, --dry-run, --dispatch-inputs or --publish');
  let baseline;
  let confirmation;
  if (values.publish) {
    requireValue(
      !values.baseline && !values.confirmation && trustedWorkflow(env),
      'Publishing requires the trusted develop dispatch workflow',
    );
    const { inputs } = parseJson(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    requireValue(
      hasKeys(inputs, ['baseline', 'confirmation']) &&
        typeof inputs.baseline === 'string' &&
        typeof inputs.confirmation === 'string',
      'Invalid dispatch inputs',
    );
    requireValue(
      Buffer.byteLength(JSON.stringify(inputs)) <= DISPATCH_LIMIT,
      'Dispatch payload exceeds the GitHub input limit',
    );
    baseline = parseJson(inputs.baseline);
    confirmation = parseJson(inputs.confirmation);
  } else {
    requireValue(values.baseline && values.confirmation, 'Specify --baseline FILE and --confirmation FILE');
    const texts = await Promise.all([values.baseline, values.confirmation].map((file) => readFile(file, 'utf8')));
    [baseline, confirmation] = texts.map(parseJson);
  }
  if (values['dispatch-inputs']) return dispatchInputs(baseline, confirmation);
  const candidates = reviewPair(baseline, confirmation);
  if (values.publish) return JSON.stringify(await publishCandidates(candidates, githubRequest));
  if (values['dry-run'])
    return JSON.stringify(
      candidates.map(({ title, body }) => ({ title, body })),
      null,
      2,
    );
  return JSON.stringify({ confirmed: candidates.length });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then(console.log)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
