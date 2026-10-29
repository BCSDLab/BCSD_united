import { verifySlackSignature } from './slackSignature';

/**
 * 슬랙 수신 엔드포인트의 첫 줄에서 부른다.
 *
 * HMAC은 파싱 전 원문으로 계산해야 해서 `readRawBody`를 먼저 부른다.
 * h3가 원문을 캐시하므로 이후 `readBody`는 그대로 쓸 수 있다.
 */
export async function assertSlackRequest(
  event: Parameters<Parameters<typeof defineEventHandler>[0]>[0],
): Promise<void> {
  const body = (await readRawBody(event, 'utf-8')) ?? '';

  const result = verifySlackSignature({
    signature: getHeader(event, 'x-slack-signature'),
    timestamp: getHeader(event, 'x-slack-request-timestamp'),
    body,
    secret: process.env.SLACK_BOT_SIGNING_SECRET,
  });

  if (result.ok) {
    return;
  }

  // 거절 사유는 로그에만 남긴다. 응답으로 알려주면 공격자에게 힌트가 된다.
  console.error(`[slack] 서명 검증 실패: ${result.reason}`);
  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
}
