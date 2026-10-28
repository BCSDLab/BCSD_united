import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { github, jsonFile, marker } from './common.mjs';
import { validateManifest } from './patch.mjs';

const context = await jsonFile('sentry-input/context.json');
const bytes = await readFile('sentry-verified/patch.json');
const manifest = validateManifest(JSON.parse(bytes));
const verification = await jsonFile('sentry-verified/verification.json');
const expectedChecks = ['regression-fails-on-base', 'regression-passes-on-fix', 'typecheck', 'lint', 'build', 'runtime-route-smoke'];
if (verification.sha256 !== createHash('sha256').update(bytes).digest('hex') || verification.baseSha !== context.baseSha || verification.runId !== process.env.GITHUB_RUN_ID || JSON.stringify(verification.checks) !== JSON.stringify(expectedChecks) || verification.route !== context.route || verification.app !== context.app || !manifest.files.length) throw new Error('Verification provenance mismatch');
const repository = await github('');
if (repository.default_branch !== context.baseBranch) throw new Error('Default branch changed; rerun against the current trusted base');
const base = await github(`/commits/${encodeURIComponent(context.baseBranch)}`);
if (base.sha !== context.baseSha) throw new Error('Base branch advanced during verification; rerun instead of publishing stale verification');
const issue = await github(`/issues/${context.issueNumber}`);
if (!issue.body?.includes(marker(context))) throw new Error('Linked issue identity mismatch');
const existing = await github(`/pulls?state=all&head=${encodeURIComponent(`${repository.owner.login}:${context.branch}`)}&per_page=100`);
if (existing.length) process.exit(0);
const tree = [];
for (const file of manifest.files) {
  let sha = null;
  if (file.content !== null) sha = (await github('/git/blobs', { method: 'POST', body: { content: Buffer.from(file.content).toString('base64'), encoding: 'base64' } })).sha;
  tree.push({ path: file.path, mode: '100644', type: 'blob', sha });
}
const resultTree = await github('/git/trees', { method: 'POST', body: { base_tree: base.commit.tree.sha, tree } });
const commit = await github('/git/commits', { method: 'POST', body: { message: `fix: Sentry ${context.sentryIssueId} 오류 수정`, tree: resultTree.sha, parents: [context.baseSha] } });
try {
  await github('/git/refs', { method: 'POST', body: { ref: `refs/heads/${context.branch}`, sha: commit.sha } });
} catch (error) {
  if (error.status !== 422) throw error;
  const reference = await github(`/git/ref/heads/${encodeURIComponent(context.branch)}`);
  const previous = await github(`/git/commits/${reference.object.sha}`);
  if (previous.tree.sha !== resultTree.sha || previous.parents.length !== 1 || previous.parents[0].sha !== context.baseSha) throw new Error('Existing branch has different content; never overwrite human changes');
}
const run = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const body = `- Close #${context.issueNumber}

${marker(context)}

## What is this PR?

- 기능 : Sentry ${context.sentryIssueId} 오류 수정
- issue : #${context.issueNumber}

## Changes

${manifest.files.map((file) => `- \`${file.path}\``).join('\n')}

## ScreenShot

자동 첨부하지 않습니다. UI 변경은 담당자의 시각 검토가 필요합니다.

## Test CheckList

- [x] 새 회귀 테스트가 수정 전 assertion 실패, 수정 후 통과
- [x] pnpm install --frozen-lockfile
- [x] pnpm typecheck
- [x] pnpm lint
- [x] pnpm build
- [x] ${context.app === 'web' ? 'Chromium 웹 경로' : '독립 API Worker GET 경로'} 검증: \`${context.route}\`

## Precaution

- 독립 검증 실행: ${run}
- 자동 merge/배포는 하지 않습니다. 실제 사용자 데이터와 인증된 화면은 검증하지 않았습니다.
- 오류 문자열과 생성 코드는 신뢰할 수 없는 입력입니다. 원인 및 테스트 타당성을 리뷰해 주세요.

## Please check if the PR fulfills these requirements

- [x] 저장소의 기본 브랜치 \`${context.baseBranch}\`를 대상으로 합니다.
- [ ] hotfix 작업이 아닙니다.
- [x] pnpm lint가 경고 없이 통과했습니다.
`;
const pr = await github('/pulls', { method: 'POST', body: { title: `[${context.domain}] Sentry ${context.sentryIssueId} 오류 수정`, body, head: context.branch, base: context.baseBranch, draft: false } });
await github(`/issues/${context.issueNumber}/comments`, { method: 'POST', body: { body: `독립 검증을 통과한 수정 PR: ${pr.html_url}\n검증 기록: ${run}\n자동 merge/배포는 하지 않습니다.` } });
