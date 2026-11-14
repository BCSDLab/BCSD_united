import { useState } from 'react';

const formatSeconds = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
};

/**
 * 인증번호를 보낸 대상(전화번호·이메일)에는 인증 타이머가 끝날 때까지 다시 보내지 못하게 한다.
 * 입력값이 바뀌면 바로 다시 보낼 수 있다. 잘못 입력한 번호를 고친 사용자를 기다리게 하지 않는다.
 */
function useResendLock(target: string, isTimerRunning: boolean, secondsLeft: number) {
  const [sentTarget, setSentTarget] = useState<string | null>(null);
  const isResendLocked = isTimerRunning && sentTarget !== null && sentTarget === target;

  const withResendLock =
    <Args extends unknown[]>(send: (...args: Args) => void) =>
    (...args: Args) => {
      if (isResendLocked) return;
      send(...args);
    };

  /** 잠긴 동안 발송 버튼에 다시 보낼 수 있을 때까지 남은 시간을 보여준다. */
  const resendButtonText = (defaultText: string) =>
    isResendLocked ? `재발송 ${formatSeconds(secondsLeft)}` : defaultText;

  return { isResendLocked, markSent: setSentTarget, withResendLock, resendButtonText };
}

export default useResendLock;
