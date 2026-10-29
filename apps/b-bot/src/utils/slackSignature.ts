import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 슬랙이 보낸 요청인지 확인한다.
 *
 * 슬랙은 모든 요청에 `v0:{타임스탬프}:{본문}`을 signing secret으로 HMAC-SHA256 한
 * 서명을 붙인다. 같은 secret을 가진 쪽만 같은 값을 만들 수 있다.
 *
 * 검증하지 않으면 URL을 아는 누구나 이벤트를 위조할 수 있다.
 * 특히 파일 첨부 이벤트는 페이로드에 적힌 주소로 **봇 토큰을 붙여** 요청하므로,
 * 그 주소를 공격자 서버로 바꿔 보내면 토큰이 그대로 새어 나간다.
 */
const VERSION = 'v0';
/** 지난 요청을 그대로 다시 보내는 걸 막는다. 슬랙 권장값. */
const MAX_AGE_SECONDS = 60 * 5;

export interface VerifyResult {
  ok: boolean;
  /** 거절 사유. 로그용이며 응답으로 내보내지 않는다. */
  reason?: string;
}

export function verifySlackSignature({
  signature,
  timestamp,
  body,
  secret,
  now = new Date(),
}: {
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  secret: string | undefined;
  now?: Date;
}): VerifyResult {
  if (!secret) {
    // 열어두는 쪽으로 실수하지 않는다. 검증할 수 없으면 통과시키지 않는다.
    return { ok: false, reason: 'SLACK_BOT_SIGNING_SECRET이 설정되지 않았습니다' };
  }
  if (!signature || !timestamp) {
    return { ok: false, reason: '서명 헤더가 없습니다' };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: '타임스탬프 형식이 올바르지 않습니다' };
  }
  const age = Math.abs(Math.floor(now.getTime() / 1000) - sentAt);
  if (age > MAX_AGE_SECONDS) {
    return { ok: false, reason: `요청이 너무 오래되었습니다 (${age}초)` };
  }

  const expected = `${VERSION}=${createHmac('sha256', secret).update(`${VERSION}:${timestamp}:${body}`).digest('hex')}`;

  // 길이가 다르면 timingSafeEqual이 던진다. 길이 자체는 비밀이 아니라 먼저 본다.
  if (expected.length !== signature.length) {
    return { ok: false, reason: '서명이 일치하지 않습니다' };
  }
  // 앞에서부터 비교하면 어디까지 맞았는지가 시간으로 새어 나간다.
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return { ok: false, reason: '서명이 일치하지 않습니다' };
  }

  return { ok: true };
}
