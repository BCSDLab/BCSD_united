export interface AutomationBinding {
  fetch(request: Request): Promise<Response>;
}

/** 권한 없는 형식 필터다. 일반 멘션은 자동화 미설정 상태에서도 기존대로 무시한다. */
export function isAutofixMention(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > 6000) return false;
  const match = /^<@[A-Z][A-Z0-9]{1,39}>\s*(?:수정요청|코드수정요청|fix-request)(?:\s*:\s*|\s+)([\s\S]+)$/i.exec(text);
  return Boolean(match && match[1].trim().length >= 5);
}

/** 원문과 Slack 서명을 그대로 전달한다. 요청자 권한·명령·중복 접수는 수신 DO 계약으로 검증한다. */
export async function forwardAutofixMention(
  binding: AutomationBinding | undefined,
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
): Promise<void> {
  if (!binding) throw new Error('ERROR_AUTOMATION service binding is required for app mentions');
  const response = await binding.fetch(
    new Request('https://error-automation.internal/slack/requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-slack-signature': signature ?? '',
        'x-slack-request-timestamp': timestamp ?? '',
      },
      body,
      signal: AbortSignal.timeout(2000),
    }),
  );
  const notConfigured = response.status === 503 && response.headers.get('x-slack-autofix-error') === 'not-configured';
  await response.body?.cancel();
  // 명시적 설정 거절만 종결한다. 큐·저장소·전송 장애의 503은 Slack 재전송을 유지한다.
  if (!response.ok && !notConfigured && ![400, 401, 403, 413, 415].includes(response.status))
    throw new Error(`Error automation intake failed (${response.status})`);
}
