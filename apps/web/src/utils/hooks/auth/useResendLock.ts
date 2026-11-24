import { useEffect, useState } from 'react';

import { isKoinError } from 'interfaces/APIError';
import { MESSAGES } from 'static/auth';

// 인증 타이머(`duration: 180`)와 같은 길이다. 발송 성공 때 타이머보다 먼저 걸리므로 항상 타이머보다 먼저 풀린다.
const RESEND_LOCK_SECONDS = 180;

/** 발송 한도(429) 안내. 서버가 번호·IP 한도 등 사유를 `message`로 알려주면 그대로 쓴다. */
export const getSendLimitMessage = (error: unknown) =>
  (isKoinError(error) && error.message) || MESSAGES.VERIFICATION.STOP;

/**
 * 인증번호를 보낸 대상(전화번호·이메일)에는 보낸 뒤 3분 동안 다시 보내지 못하게 한다.
 * 다른 값을 입력하면 바로 보낼 수 있다. 잘못 입력한 번호를 고친 사용자를 기다리게 하지 않는다.
 *
 * 인증 타이머와 따로 대상별 만료 시각을 저장한다. 입력값이 바뀌어 인증 타이머가 멈춰도,
 * 같은 값을 다시 입력하면 남은 시간 동안 계속 잠겨 있다.
 */
function useResendLock(target: string, lockSeconds = RESEND_LOCK_SECONDS) {
  const [expiresAtByTarget, setExpiresAtByTarget] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  const expiresAt = expiresAtByTarget[target];
  const isResendLocked = expiresAt !== undefined && expiresAt > now;

  // 다음 잠금이 풀리는 시각에 맞춰 한 번 다시 그린다
  const nextExpiresAt = Math.min(...Object.values(expiresAtByTarget).filter((time) => time > now));

  useEffect(() => {
    if (!Number.isFinite(nextExpiresAt)) return undefined;

    const timeoutId = setTimeout(() => setNow(Math.max(Date.now(), nextExpiresAt)), nextExpiresAt - Date.now());

    return () => clearTimeout(timeoutId);
  }, [nextExpiresAt]);

  const markSent = (sentTarget: string) => {
    const sentAt = Date.now();
    setNow(sentAt);
    setExpiresAtByTarget((prev) => ({
      ...prev,
      [sentTarget]: sentAt + lockSeconds * 1000,
    }));
  };

  /** 서버가 인증번호를 만료로 판단하면(404) 다시 보낼 수 있게 그 대상의 잠금을 푼다. */
  const releaseLock = (releasedTarget: string) => {
    setExpiresAtByTarget((prev) => {
      const next = { ...prev };
      delete next[releasedTarget];

      return next;
    });
  };

  /** 잠겼거나 앞선 발송 요청이 아직 진행 중이면 보내지 않는다. 응답 전에 연달아 눌러도 한 번만 보낸다. */
  const withResendLock =
    <Args extends unknown[]>(send: (...args: Args) => void, isSending = false) =>
    (...args: Args) => {
      if (isResendLocked || isSending) return;
      send(...args);
    };

  /**
   * 잠겼는데 인증 타이머가 멈춰 있으면(번호·이메일을 바꿨다가 되돌린 경우) 발송 버튼이 왜 막혔는지 알려준다.
   * 타이머가 돌고 있으면 남은 시간이 이미 보이므로 `null`이다.
   * 화면은 이 값을 기존 메시지보다 먼저 보여주고, 메시지에 딸린 남은 횟수·링크도 같은 값으로 분기해야 가려진 메시지의 요소가 남지 않는다.
   */
  const getResendLockMessage = (isTimerRunning: boolean): { type: 'warning'; content: string } | null =>
    isResendLocked && !isTimerRunning ? { type: 'warning', content: MESSAGES.VERIFICATION.RESEND_LOCKED } : null;

  return { isResendLocked, markSent, releaseLock, withResendLock, getResendLockMessage };
}

export default useResendLock;
