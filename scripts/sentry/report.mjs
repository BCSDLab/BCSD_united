import { findIssue, github, jsonFile, validateDispatch } from './common.mjs';

const payload = validateDispatch(await jsonFile(process.env.GITHUB_EVENT_PATH), process.env.GITHUB_EVENT_NAME, {
  organization: process.env.SENTRY_ORGANIZATION,
  projects: (process.env.SENTRY_PROJECTS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
});
const issue = await findIssue(payload);
if (issue) {
  const results = JSON.parse(process.env.JOB_RESULTS ?? '{}');
  const labels = { prepare: '이벤트 검증·진단 조회', agent: '수정 생성', verify: '독립 검증', publish: 'PR 발행' };
  const statuses = Object.entries(labels).map(([key, label]) => `- ${label}: ${['success', 'failure', 'cancelled', 'skipped'].includes(results[key]) ? results[key] : 'unknown'}`).join('\n');
  const run = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  await github(`/issues/${issue.number}/comments`, { method: 'POST', body: { body: `자동 수정이 완료되지 않았습니다. 통과하지 않은 수정으로 새 PR을 만들지 않습니다.\n\n${statuses}\n\n원인 및 실제 명령 출력: ${run}\n\n변경 없음, 재현 테스트의 수정 전 assertion 실패 없음, 경로 판별 불가, 로컬 환경의 API 부재, 검사 실패는 모두 담당자 검토가 필요합니다. 로그에서 실패한 단계를 해결한 뒤 workflow_dispatch로 동일 Sentry ID를 재실행해 주세요. 토큰·진단 원문을 댓글에 붙이지 마세요.` } });
}
