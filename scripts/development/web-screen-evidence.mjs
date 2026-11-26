import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PRODUCT_SIGNATURES = Object.freeze(['rendered-error-boundary', 'unexpected-not-found']);
export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{40}$/;
const statuses = ['passed', 'product-failure', 'blocked', 'harness-error', 'unverified', 'skipped'];
const viewports = ['desktop', 'mobile'];
const harnessRoot = fileURLToPath(new URL('../../', import.meta.url));

function requireValue(test, message) {
  if (!test) throw new Error(message);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validRunId(value) {
  return typeof value === 'string' && value.length === 36 && RUN_ID_PATTERN.test(value);
}

function validSha(value) {
  return typeof value === 'string' && value.length === 40 && sha.test(value);
}

export function validateScreenRun(run, allowedIds) {
  requireValue(
    exactKeys(run, ['schemaVersion', 'runId', 'appSha', 'harnessSha', 'environment', 'parentRunId', 'observations']),
    'Invalid screen run fields',
  );
  requireValue(run.schemaVersion === 1 && run.environment === 'stage', 'Expected stage screen run schema v1');
  requireValue(
    validRunId(run.runId) &&
      (run.parentRunId === null || (validRunId(run.parentRunId) && run.parentRunId !== run.runId)),
    'Invalid run identity',
  );
  requireValue(validSha(run.appSha) && validSha(run.harnessSha), 'Invalid screen run SHA');
  requireValue(
    Array.isArray(run.observations) && run.observations.length > 0 && run.observations.length <= allowedIds.size * 2,
    'Invalid screen observation count',
  );
  const seen = new Set();
  for (const row of run.observations) {
    requireValue(exactKeys(row, ['screenId', 'viewport', 'status', 'signature']), 'Invalid screen observation fields');
    requireValue(
      allowedIds.has(row.screenId) && viewports.includes(row.viewport) && statuses.includes(row.status),
      'Unknown screen observation',
    );
    requireValue(
      row.status === 'product-failure' ? PRODUCT_SIGNATURES.includes(row.signature) : row.signature === null,
      'Invalid failure signature',
    );
    const key = `${row.screenId}:${row.viewport}`;
    requireValue(!seen.has(key), 'Duplicate screen observation');
    seen.add(key);
  }
  return run;
}

function cleanHead(cwd) {
  // Don't let a caller's hook environment silently attest the index or tree of a different repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  requireValue(
    !git('status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'),
    'Screen evidence requires clean app and harness checkouts',
  );
  const head = git('rev-parse', '--verify', 'HEAD^{commit}');
  requireValue(validSha(head), 'Expected a full checkout commit SHA');
  return head;
}

export function verifyRevisions(checkout, { appSha, harnessSha }) {
  requireValue(
    cleanHead(checkout) === appSha && cleanHead(harnessRoot) === harnessSha,
    'Checkout changed during screen run',
  );
}

export function parentIdentity(data, allowedIds, selectedIds, appSha, harnessSha) {
  const parent = validateScreenRun(data, allowedIds);
  requireValue(
    parent.parentRunId === null && parent.appSha === appSha && parent.harnessSha === harnessSha,
    'Rerun requires a root stage run with matching app and harness SHAs',
  );
  const parentIds = new Set(parent.observations.map((r) => r.screenId));
  requireValue(
    selectedIds.every((id) => parentIds.has(id)),
    'Selected screen is absent from the parent run',
  );
  return parent.runId;
}

export async function beginScreenRun(checkout, selectedIds, allowedIds, parentPath) {
  const appSha = cleanHead(checkout);
  const harnessSha = cleanHead(harnessRoot);
  let parentRunId = null;
  if (parentPath !== undefined) {
    const text = await readFile(parentPath, 'utf8');
    let parent;
    try {
      parent = JSON.parse(text);
    } catch {
      throw new Error('Invalid parent screen run JSON');
    }
    parentRunId = parentIdentity(parent, allowedIds, selectedIds, appSha, harnessSha);
  }
  return { schemaVersion: 1, runId: randomUUID(), appSha, harnessSha, environment: 'stage', parentRunId };
}

function targetViewport(screen, viewport) {
  return (
    viewports.includes(viewport) &&
    ['public', 'authenticated'].includes(screen.access) &&
    !(viewport === 'desktop' && screen.desktopGuard)
  );
}

export function eligibleProductFault(screen, viewport, signature) {
  if (!targetViewport(screen, viewport) || !PRODUCT_SIGNATURES.includes(signature)) return false;
  // A stale resource in the stage fixture is not evidence of a broken route.
  return (
    signature !== 'unexpected-not-found' ||
    (screen.expect !== 'not-found' && !screen.path.includes(':') && !screen.source && !screen.route.includes('$'))
  );
}

// Only an observed, hydrated error UI on the requested, stable page is product evidence.
// Missing data, backend errors, console text, redirects and timeouts alone never qualify.
export function classifyVisit({ screen, origin, expectedPath, viewport, session, clip, stage, visit, passed }) {
  if (screen.access === 'authenticated' && !session) return 'blocked';
  if (!stage || !targetViewport(screen, viewport)) return 'unverified';
  const { state, record } = visit;
  if (
    visit.navigationError ||
    !state?.ready ||
    !state.hydrated ||
    !visit.networkIdle ||
    record.documentLoads !== 1 ||
    !(record.documentStatus >= 200 && record.documentStatus < 300)
  )
    return 'unverified';
  const actual = new URL(state.url);
  const expected = new URL(expectedPath, origin);
  if (
    actual.origin !== origin ||
    actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '') ||
    actual.search !== expected.search
  )
    return 'unverified';
  if (passed) return screen.access === 'authenticated' && !clip ? 'unverified' : 'passed';
  if (record.failedRequests.length || record.networkFailures) return 'unverified';
  const signature = state.errorBoundaries.length
    ? 'rendered-error-boundary'
    : state.notFound
      ? 'unexpected-not-found'
      : null;
  return eligibleProductFault(screen, viewport, signature) ? signature : 'unverified';
}

// Rebuild rather than spread raw viewport results: even unexpected fields cannot leave this boundary.
export function normalizedScreenRun(identity, entries, allowedIds) {
  const observations = [];
  for (const entry of entries) {
    const { id: screenId, access } = entry;
    for (const viewport of viewports) {
      const outcome =
        access === 'disabled'
          ? 'skipped'
          : (entry[viewport]?.outcome ??
            (access === 'login' && viewport === 'mobile' ? 'unverified' : 'harness-error'));
      const signature = PRODUCT_SIGNATURES.includes(outcome) ? outcome : null;
      observations.push({ screenId, viewport, status: signature ? 'product-failure' : outcome, signature });
    }
  }
  return validateScreenRun({ ...identity, observations }, allowedIds);
}
