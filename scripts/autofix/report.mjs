import { dispatchConfig, findIssue, github, jsonFile, validateDispatch } from './common.mjs';

const payload = validateDispatch(
  await jsonFile(process.env.GITHUB_EVENT_PATH),
  process.env.GITHUB_EVENT_NAME,
  dispatchConfig(),
);
const issue = await findIssue(payload);
if (issue) {
  const results = JSON.parse(process.env.JOB_RESULTS ?? '{}');
  const labels = { prepare: '이벤트 검증·진단 조회', agent: '수정 생성', verify: '독립 검증', publish: 'PR 발행' };
  const statuses = Object.entries(labels)
    .map(
      ([key, label]) =>
        `- ${label}: ${['success', 'failure', 'cancelled', 'skipped'].includes(results[key]) ? results[key] : 'unknown'}`,
    )
    .join('\n');
  const run = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  await github(`/issues/${issue.number}/comments`, {
    method: 'POST',
    body: {
      body: `자동 수정이 완료되지 않았습니다. 통과하지 않은 수정으로 새 PR을 만들지 않습니다.\n\n${statuses}\n\n원인 및 실제 명령 출력: ${run}\n\n변경 없음, 수정 전 assertion 실패 없음, 진단 근거/경로 부재, 검사 실패는 담당자 검토가 필요합니다. Cloudflare Issues는 공식 알림 문서에서 data 내부의 예외/소스 프레임/요청 경로 스키마를 정의하지 않습니다. 인증된 실제 알림으로 그 계약을 확인하기 전에는 자동 코드 수정을 주장하지 않습니다. 실패한 단계를 해결한 뒤 workflow_dispatch의 identity에 동일 제공자 식별자를 넣어 재실행할 수 있습니다. 토큰·진단 원문은 댓글에 붙이지 마세요.`,
    },
  });
}
