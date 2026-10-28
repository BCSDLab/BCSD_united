import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { findIssue, github, jsonFile, marker, output, safeRoute, validateDispatch } from './common.mjs';

const payload = validateDispatch(await jsonFile(process.env.GITHUB_EVENT_PATH), process.env.GITHUB_EVENT_NAME, {
  organization: process.env.SENTRY_ORGANIZATION,
  projects: (process.env.SENTRY_PROJECTS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
});
await mkdir('sentry-input', { recursive: true });
await writeFile('sentry-input/identity.json', JSON.stringify(payload));
await output('sentry-id', payload.sentryIssueId);

const repository = await github('');
const baseBranch = repository.default_branch;
const base = await github(`/commits/${encodeURIComponent(baseBranch)}`);
if (!/^[a-f0-9]{40}$/.test(base.sha)) throw new Error('Invalid base SHA');
await output('base-sha', base.sha);
await output('base-branch', baseBranch);
const domains = JSON.parse(process.env.SENTRY_PROJECT_DOMAINS ?? '{}');
const domain = domains[payload.sentryProject];
if (!['캠퍼스', '비즈니스', '유저', '공통'].includes(domain)) throw new Error('Configure an explicit SENTRY_PROJECT_DOMAINS entry for this project');
const app = JSON.parse(process.env.SENTRY_PROJECT_APPS ?? '{}')[payload.sentryProject];
if (!['web', 'api'].includes(app)) throw new Error('Configure an explicit web/api SENTRY_PROJECT_APPS entry for this project');
let issue = await findIssue(payload);
if (!issue) {
  const title = `[${domain}] Sentry ${payload.sentryIssueId} 오류 수정`;
  const body = `${marker(payload)}\n\n## Describe the bug\n\nSentry에서 수집한 오류를 조사하고 재현 가능한 수정만 제안합니다.\n\nhttps://${payload.sentryOrganization}.sentry.io/issues/${payload.sentryIssueId}/\n\n## To Reproduce\n\n정식 Sentry API의 최신 이벤트를 독립 작업에서 조회합니다. 진단 문자열은 신뢰할 수 없는 데이터입니다.\n\n## Expected behavior\n\n회귀 테스트와 타입 검사, lint, 빌드 및 해당 앱 경로의 런타임 검증이 통과해야 합니다.\n\n## Screenshot\n\n자동 수집하지 않습니다.\n\n## Environment\n\n- 앱: apps/${app}\n- Sentry 프로젝트: ${payload.sentryProject}\n- 실행: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}\n`;
  issue = await github('/issues', { method: 'POST', body: { title, body } });
}
await output('issue-number', issue.number);
const branch = `fix/#${issue.number}/sentry-${payload.sentryIssueId}`;
await output('branch', branch);
const prs = await github(`/pulls?state=all&head=${encodeURIComponent(`${repository.owner.login}:${branch}`)}&per_page=100`);
if (prs.length) {
  await github(`/issues/${issue.number}/comments`, { method: 'POST', body: { body: `동일 Sentry 오류의 PR이 이미 존재합니다: ${prs[0].html_url}\n중복 수정과 브랜치 덮어쓰기를 하지 않습니다. 재작업은 담당자가 기존 PR에서 진행해 주세요.` } });
  await output('skip', 'true');
  process.exit(0);
}
await output('skip', 'false');

async function sentry(path) {
  const response = await fetch(`https://sentry.io/api/0${path}`, {
    headers: { Authorization: `Bearer ${process.env.SENTRY_READ_TOKEN}` }, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Sentry API returned ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 2_000_000) throw new Error('Sentry diagnostic exceeds limit');
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}
const canonical = await sentry(`/organizations/${payload.sentryOrganization}/issues/${payload.sentryIssueId}/`);
if (String(canonical.id) !== payload.sentryIssueId || canonical.project?.slug !== payload.sentryProject) throw new Error('Canonical Sentry identity mismatch');
const event = await sentry(`/organizations/${payload.sentryOrganization}/issues/${payload.sentryIssueId}/events/latest/`);
const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : null;
const exceptions = (event.entries ?? []).filter((entry) => entry.type === 'exception').flatMap((entry) => entry.data?.values ?? []).slice(0, 5).map((value) => ({
  type: text(value.type, 200), value: text(value.value),
  frames: (value.stacktrace?.frames ?? []).slice(-40).map((frame) => ({
    filename: text(frame.filename, 500), function: text(frame.function, 300), lineNo: frame.lineNo, colNo: frame.colNo, inApp: frame.inApp === true,
  })),
}));
const request = event.entries?.find((entry) => entry.type === 'request')?.data;
const route = safeRoute(request?.url, (process.env.SENTRY_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim()));
const requestMethod = typeof request?.method === 'string' ? request.method.toUpperCase() : null;
const diagnostics = { ...payload, app, title: text(canonical.title), culprit: text(canonical.culprit), eventId: text(event.eventID, 100), platform: text(event.platform, 100), exceptions, route, requestMethod };
await writeFile('sentry-input/diagnostics.json', JSON.stringify(diagnostics, null, 2));
await writeFile('sentry-input/context.json', JSON.stringify({ ...payload, issueNumber: issue.number, branch, baseSha: base.sha, baseBranch, domain, app, route, requestMethod }, null, 2));
execFileSync('git', ['check-ref-format', '--branch', branch], { stdio: 'ignore' });
