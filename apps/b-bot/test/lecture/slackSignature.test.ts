import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSlackFileUrl } from '~/utils/slackFile';
import { verifySlackSignature } from '~/utils/slackSignature';

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
const NOW = new Date('2026-08-08T00:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));

const sign = (body: string, timestamp: string, secret = SECRET) =>
  `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

describe('슬랙 서명 검증', () => {
  it('슬랙이 보낸 요청을 통과시킨다', () => {
    const result = verifySlackSignature({
      signature: sign(BODY, TS),
      timestamp: TS,
      body: BODY,
      secret: SECRET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('본문이 한 글자만 달라도 막는다', () => {
    const result = verifySlackSignature({
      signature: sign(BODY, TS),
      timestamp: TS,
      body: `${BODY}x`,
      secret: SECRET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('다른 secret으로 만든 서명을 막는다', () => {
    const result = verifySlackSignature({
      signature: sign(BODY, TS, 'wrong-secret'),
      timestamp: TS,
      body: BODY,
      secret: SECRET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('오래된 요청을 막는다', () => {
    // 가로챈 요청을 그대로 다시 보내는 걸 차단한다.
    const old = String(Number(TS) - 60 * 6);
    const result = verifySlackSignature({
      signature: sign(BODY, old),
      timestamp: old,
      body: BODY,
      secret: SECRET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/오래/);
  });

  it('미래에서 온 요청도 막는다', () => {
    const future = String(Number(TS) + 60 * 6);
    const result = verifySlackSignature({
      signature: sign(BODY, future),
      timestamp: future,
      body: BODY,
      secret: SECRET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('헤더가 없으면 막는다', () => {
    expect(
      verifySlackSignature({
        signature: undefined,
        timestamp: TS,
        body: BODY,
        secret: SECRET,
        now: NOW,
      }).ok,
    ).toBe(false);
    expect(
      verifySlackSignature({
        signature: sign(BODY, TS),
        timestamp: undefined,
        body: BODY,
        secret: SECRET,
        now: NOW,
      }).ok,
    ).toBe(false);
  });

  it('타임스탬프가 숫자가 아니면 막는다', () => {
    expect(
      verifySlackSignature({
        signature: sign(BODY, '어제'),
        timestamp: '어제',
        body: BODY,
        secret: SECRET,
        now: NOW,
      }).ok,
    ).toBe(false);
  });

  it('secret이 없으면 통과시키지 않는다', () => {
    // 검증할 수 없을 때 열어두면 검증을 안 하는 것과 같다.
    const result = verifySlackSignature({
      signature: sign(BODY, TS),
      timestamp: TS,
      body: BODY,
      secret: undefined,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SIGNING_SECRET/);
  });

  it('길이가 다른 서명에도 던지지 않는다', () => {
    // timingSafeEqual은 길이가 다르면 예외를 던진다.
    expect(() =>
      verifySlackSignature({ signature: 'v0=short', timestamp: TS, body: BODY, secret: SECRET, now: NOW }),
    ).not.toThrow();
  });
});

describe('파일 주소 확인', () => {
  it('슬랙 주소만 받는다', () => {
    expect(isSlackFileUrl('https://files.slack.com/files-pri/T1-F1/a.xlsx')).toBe(true);
    expect(isSlackFileUrl('https://slack.com/files/a.xlsx')).toBe(true);
  });

  it('다른 주소로는 토큰을 보내지 않는다', () => {
    // 위조 이벤트로 여기에 공격자 주소가 오면 봇 토큰이 그대로 새어 나간다.
    expect(isSlackFileUrl('https://evil.example.com/a.xlsx')).toBe(false);
    expect(isSlackFileUrl('https://slack.com.evil.example.com/a.xlsx')).toBe(false);
    expect(isSlackFileUrl('http://files.slack.com/a.xlsx')).toBe(false);
    expect(isSlackFileUrl('주소아님')).toBe(false);
  });
});
