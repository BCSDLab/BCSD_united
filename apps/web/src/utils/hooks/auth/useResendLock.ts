import { useEffect, useState } from 'react';

const RESEND_LOCK_SECONDS = 180;

const formatSeconds = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
};

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
  const secondsLeft = expiresAt === undefined ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const isResendLocked = secondsLeft > 0;

  // 잠긴 대상이 하나라도 남아 있는 동안만 1초마다 현재 시각을 갱신한다.
  const latestExpiresAt = Math.max(0, ...Object.values(expiresAtByTarget));
  const hasActiveLock = latestExpiresAt > now;

  useEffect(() => {
    if (!hasActiveLock) return undefined;

    const intervalId = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(intervalId);
  }, [hasActiveLock]);

  const markSent = (sentTarget: string) => {
    const sentAt = Date.now();
    setNow(sentAt);
    setExpiresAtByTarget((prev) => ({ ...prev, [sentTarget]: sentAt + lockSeconds * 1000 }));
  };

  const withResendLock =
    <Args extends unknown[]>(send: (...args: Args) => void) =>
    (...args: Args) => {
      if (isResendLocked) return;
      send(...args);
    };

  /** 잠긴 동안 발송 버튼에 다시 보낼 수 있을 때까지 남은 시간을 보여준다. */
  const resendButtonText = (defaultText: string) =>
    isResendLocked ? `재발송 ${formatSeconds(secondsLeft)}` : defaultText;

  return { isResendLocked, markSent, withResendLock, resendButtonText };
}

export default useResendLock;
