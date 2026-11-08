import { GitHubError, github, installationToken } from './github';
import { inspectPullRequest, pullRequestPolicy, PullRequestRejected } from './pull-request';
import type { Env, PatchManifest, PreparedPullRequestJob, PullRequestReview } from './types';

export type AutoMergeOutcome = { status: 'merged' | 'skipped' | 'pending-checks'; reason: string };

/** Jobs of `.github/workflows/LINT_CHECK.yml` (Quality); GitHub attaches pull_request runs to the PR head SHA. */
const REQUIRED_CHECKS = ['ESLint', 'Format', 'TypeCheck'] as const;
type CheckRun = { name?: string; status?: string; conclusion?: string; app?: { slug?: string } };

function protectedPath(path: string): boolean {
  const basename = path.split('/').at(-1) ?? '';
  return (
    path.startsWith('.github/') ||
    path.startsWith('scripts/') ||
    path.startsWith('apps/error-automation/') ||
    path.startsWith('apps/api/drizzle/') ||
    path === 'apps/api/src/db/schema.ts' ||
    path.startsWith('apps/api/src/domains/commerce/') ||
    path.startsWith('apps/api/src/domains/identity/') ||
    /(^|\/)migrations\//i.test(path) ||
    /(^|\/)(auth|authentication|payment|payments|session|sessions)(\/|\.|$)/i.test(path) ||
    /(^|\/)[^/]*(?:auth|payment|session|cookie|login|token|credential|oauth|checkout|billing)[^/]*\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(
      path,
    ) ||
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|wrangler(?:\..*)?|tsconfig.*|.*\.config\..*|Dockerfile.*|\.env.*)$/i.test(
      basename,
    )
  );
}

/** Re-read every merge fact canonically; missing, pending, or inconsistent evidence fails closed. */
export async function autoMergePullRequest(
  env: Env,
  job: PreparedPullRequestJob,
  manifest: PatchManifest,
  review: PullRequestReview,
): Promise<AutoMergeOutcome> {
  const skip = (reason: string): AutoMergeOutcome => ({ status: 'skipped', reason });
  if (review.decision !== 'approved' || review.findings.some((finding) => finding.severity !== 'P3'))
    return skip('리뷰가 승인되지 않았거나 P1/P2 발견 사항이 있습니다.');
  if (manifest.files.length) return skip('리뷰 수정 커밋이 적용되었습니다.');
  let read: string;
  try {
    read = await installationToken(env, 'merge-evidence');
  } catch (error) {
    if (
      error instanceof Error &&
      (/^GitHub App token rejected \((?:403|422)\)$/.test(error.message) ||
        error.message === 'GitHub returned an invalid scoped token')
    )
      return skip('App 권한(checks/statuses) 승인 대기');
    throw error;
  }
  let current;
  try {
    current = await inspectPullRequest(env, read, job.pullNumber, { ...pullRequestPolicy(env), auto: true });
  } catch (error) {
    if (error instanceof PullRequestRejected) return skip('PR이 닫혔거나 draft/대상 브랜치가 변경되었습니다.');
    throw error;
  }
  if (current.headSha !== job.headSha || current.baseSha !== job.baseSha || current.headRef !== job.headRef)
    return skip('리뷰 후 head 또는 develop이 변경되었습니다.');
  if (!current.author || current.authorBot) return skip('봇 작성 PR이거나 작성자를 확인할 수 없습니다.');
  if (!current.labels) return skip('PR 라벨을 확인할 수 없습니다.');
  if (current.labels.includes('automerge:skip')) return skip('automerge:skip 라벨이 있습니다.');
  if (current.mergeable !== true) return skip('GitHub가 mergeable 상태를 확인하지 못했습니다.');
  if (!current.mergeTitle) return skip('PR 제목을 안전하게 확인할 수 없습니다.');
  if (
    !Number.isSafeInteger(current.changedFilesCount) ||
    current.changedFilesCount < 1 ||
    current.changedFilesCount > 10 ||
    !Number.isSafeInteger(current.additions) ||
    !Number.isSafeInteger(current.deletions) ||
    current.additions < 0 ||
    current.deletions < 0 ||
    current.additions + current.deletions > 300
  )
    return skip('변경 파일 10개 또는 변경 줄 300줄 제한을 넘었거나 통계를 확인할 수 없습니다.');
  const files = await github<
    { filename?: string; previous_filename?: string; status?: string; additions?: number; deletions?: number }[]
  >(env, read, `/pulls/${job.pullNumber}/files?per_page=100&page=1`);
  if (
    files.length !== current.changedFilesCount ||
    files.some(
      ({ filename, previous_filename, status, additions, deletions }) =>
        typeof filename !== 'string' ||
        typeof status !== 'string' ||
        !['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(status) ||
        !Number.isSafeInteger(additions) ||
        !Number.isSafeInteger(deletions) ||
        (status === 'renamed'
          ? typeof previous_filename !== 'string' || !previous_filename
          : previous_filename !== undefined),
    )
  )
    return skip('변경 파일 목록/통계를 확인할 수 없습니다.');
  if (
    files.some(
      (file) => protectedPath(file.filename!) || (file.status === 'renamed' && protectedPath(file.previous_filename!)),
    )
  )
    return skip('보호된 설정, 인증/결제/세션 또는 운영 경로가 변경되었습니다.');
  if (files.reduce((sum, file) => sum + file.additions! + file.deletions!, 0) > 300)
    return skip('변경 줄 300줄 제한을 넘었습니다.');
  const checks = await github<{ total_count?: number; check_runs?: CheckRun[] }>(
    env,
    read,
    `/commits/${job.headSha}/check-runs?per_page=100`,
  );
  if (
    !Number.isSafeInteger(checks.total_count) ||
    checks.total_count! < 0 ||
    checks.total_count! > 1000 ||
    !Array.isArray(checks.check_runs) ||
    checks.check_runs.length !== Math.min(100, checks.total_count!)
  )
    return skip('head의 check run 목록을 확인할 수 없습니다.');
  if (checks.total_count === 0)
    return { status: 'pending-checks', reason: 'head의 check run이 아직 생성되지 않았습니다.' };
  const allChecks = [...checks.check_runs];
  for (let page = 2; allChecks.length < checks.total_count! && page <= Math.ceil(checks.total_count! / 100); page++) {
    const batch = await github<{ total_count?: number; check_runs?: CheckRun[] }>(
      env,
      read,
      `/commits/${job.headSha}/check-runs?per_page=100&page=${page}`,
    );
    if (
      batch.total_count !== checks.total_count ||
      !Array.isArray(batch.check_runs) ||
      batch.check_runs.length !== Math.min(100, checks.total_count! - allChecks.length)
    )
      return skip('head의 check run 페이지를 확인할 수 없습니다.');
    allChecks.push(...batch.check_runs);
  }
  if (allChecks.length !== checks.total_count) return skip('head의 check run 페이지를 확인할 수 없습니다.');
  const missing = REQUIRED_CHECKS.filter(
    (name) => !allChecks.some((check) => check.name === name && check.app?.slug === 'github-actions'),
  );
  if (missing.length)
    return {
      status: 'pending-checks',
      reason: `필수 Quality check(${missing.join(', ')})가 아직 생성되지 않았습니다.`,
    };
  const statuses = await github<{ state?: string; total_count?: number; statuses?: { state?: string }[] }>(
    env,
    read,
    `/commits/${job.headSha}/status?per_page=100`,
  );
  if (
    !Number.isSafeInteger(statuses.total_count) ||
    !Array.isArray(statuses.statuses) ||
    statuses.statuses.length !== statuses.total_count ||
    statuses.total_count! > 100
  )
    return skip('head의 commit status 목록을 확인할 수 없습니다.');
  if (
    allChecks.some(
      (check) =>
        !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(check.status ?? '') ||
        (check.status === 'completed' && !['success', 'neutral', 'skipped'].includes(check.conclusion ?? '')),
    ) ||
    statuses.statuses.some((status) => !['success', 'pending'].includes(status.state ?? '')) ||
    !['success', 'pending'].includes(statuses.state ?? '')
  )
    return skip('head의 check run 또는 commit status가 실패했습니다.');
  if (
    allChecks.some((check) => check.status !== 'completed') ||
    statuses.statuses.some((status) => status.state === 'pending') ||
    (statuses.total_count! > 0 && statuses.state === 'pending')
  )
    return { status: 'pending-checks', reason: 'head의 check run 또는 commit status가 아직 대기 중입니다.' };
  if (statuses.total_count! > 0 && statuses.state !== 'success')
    return skip('head의 commit status가 성공하지 않았습니다.');
  const write = await installationToken(env, 'publish');
  let latest;
  try {
    latest = await inspectPullRequest(env, read, job.pullNumber, { ...pullRequestPolicy(env), auto: true });
  } catch (error) {
    if (error instanceof PullRequestRejected)
      return skip('merge 직전 PR이 닫혔거나 draft/대상 브랜치가 변경되었습니다.');
    throw error;
  }
  if (
    latest.baseRef !== 'develop' ||
    latest.headSha !== job.headSha ||
    latest.headRef !== job.headRef ||
    latest.baseSha !== job.baseSha ||
    latest.mergeable !== true ||
    latest.authorBot ||
    !latest.author ||
    !latest.labels ||
    latest.labels.includes('automerge:skip') ||
    latest.changedFilesCount !== current.changedFilesCount ||
    latest.additions !== current.additions ||
    latest.deletions !== current.deletions ||
    latest.mergeTitle !== current.mergeTitle
  )
    return skip('merge 직전 PR의 head, base 또는 안전 조건이 변경되었습니다.');
  try {
    const merged = await github<{ merged?: boolean }>(env, write, `/pulls/${job.pullNumber}/merge`, 'PUT', {
      merge_method: 'squash',
      sha: job.headSha,
      commit_title: `${current.mergeTitle} (#${job.pullNumber})`,
    });
    return merged.merged === true
      ? { status: 'merged', reason: '낮은 영향 범위와 모든 검증 조건을 통과해 develop에 squash merge했습니다.' }
      : skip('GitHub가 squash merge를 확인하지 않았습니다.');
  } catch (error) {
    if (error instanceof GitHubError && [405, 409, 422].includes(error.status))
      return skip('GitHub가 최신 merge 상태 또는 브랜치 규칙으로 merge를 거부했습니다.');
    throw error;
  }
}
