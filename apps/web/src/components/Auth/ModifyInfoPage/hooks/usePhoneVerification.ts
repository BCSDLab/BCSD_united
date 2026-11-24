import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { smsSend, smsVerify, checkPhone } from 'api/auth';
import type { SmsSendResponse } from 'api/auth/entity';
import { isKoinError } from 'interfaces/APIError';
import { MESSAGES } from 'static/auth';
import useResendLock, { getSendLimitMessage } from 'utils/hooks/auth/useResendLock';
import { getErrorStatus } from 'utils/ts/httpError';

import { useVerificationTimer } from './useVerificationTimer';

type VerificationMessageType = 'success' | 'warning' | 'error' | 'default';

interface VerificationMessage {
  type: VerificationMessageType;
  content: string;
}

interface UsePhoneVerificationOptions {
  showVerificationHelp?: boolean;
}

const VERIFICATION_DURATION_SECONDS = 180;
const VERIFICATION_HELP_DELAY_SECONDS = 60;

export function usePhoneVerification(
  normalizedPhoneNumber: string,
  { showVerificationHelp = false }: UsePhoneVerificationOptions = {},
) {
  const currentPhoneNumberRef = useRef(normalizedPhoneNumber);

  useEffect(() => {
    currentPhoneNumberRef.current = normalizedPhoneNumber;
  }, [normalizedPhoneNumber]);

  const [isVerified, setIsVerified] = useState(false);
  const [hasSentVerificationCode, setHasSentVerificationCode] = useState(false);
  const [isSendLimitExceeded, setIsSendLimitExceeded] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState<VerificationMessage | null>(null);
  const [verificationMessage, setVerificationMessage] = useState<VerificationMessage | null>(null);
  const [smsSendCountData, setSmsSendCountData] = useState<SmsSendResponse | null>(null);

  const {
    start,
    stop,
    reset: resetTimer,
    expire,
    formattedTime,
    timeLeft,
    isRunning,
  } = useVerificationTimer(VERIFICATION_DURATION_SECONDS, () => {
    if (!isVerified) {
      setVerificationMessage({ type: 'warning', content: MESSAGES.VERIFICATION.TIMEOUT });
    }
  });

  const { isResendLocked, markSent, releaseLock, withResendLock, getResendLockMessage } =
    useResendLock(normalizedPhoneNumber);

  const sendSMS = useMutation({
    mutationFn: smsSend,
    onSuccess: (data: SmsSendResponse, { phone_number: requestedPhoneNumber }) => {
      markSent(requestedPhoneNumber);
      if (requestedPhoneNumber !== currentPhoneNumberRef.current) return;

      setIsSendLimitExceeded(false);
      setPhoneMessage({ type: 'success', content: MESSAGES.PHONE.CODE_SENT });
      setVerificationMessage(null);
      setSmsSendCountData(data);
      setHasSentVerificationCode(true);
      setIsVerified(false);
      start();
    },
    onError: (err, { phone_number: requestedPhoneNumber }) => {
      if (requestedPhoneNumber !== currentPhoneNumberRef.current) return;

      if (getErrorStatus(err) === 429) {
        stop();
        setIsSendLimitExceeded(true);
        setPhoneMessage({ type: 'error', content: getSendLimitMessage(err) });
        setVerificationMessage(null);

        return;
      }
      if (isKoinError(err)) {
        const { status } = err;
        if (status === 400) setPhoneMessage({ type: 'warning', content: MESSAGES.PHONE.INVALID });
      }
    },
  });

  const checkPhoneNumber = useMutation({
    mutationFn: checkPhone,
    onSuccess: (_, checkedPhoneNumber) => {
      if (checkedPhoneNumber !== currentPhoneNumberRef.current) return;

      sendSMS.mutate({ phone_number: checkedPhoneNumber });
    },
    onError: (err, checkedPhoneNumber) => {
      if (checkedPhoneNumber !== currentPhoneNumberRef.current) return;

      if (isKoinError(err)) {
        const { status } = err;
        if (status === 400) setPhoneMessage({ type: 'warning', content: MESSAGES.PHONE.INVALID });
        if (status === 409) setPhoneMessage({ type: 'error', content: MESSAGES.PHONE.ALREADY_REGISTERED });
      }
    },
  });

  const verifyCode = useMutation({
    mutationFn: smsVerify,
    onSuccess: (_, { phone_number: requestedPhoneNumber }) => {
      if (requestedPhoneNumber !== currentPhoneNumberRef.current) return;

      setVerificationMessage({ type: 'success', content: MESSAGES.VERIFICATION.CORRECT });
      setIsVerified(true);
      stop();
    },
    onError: (err, { phone_number: requestedPhoneNumber }) => {
      if (requestedPhoneNumber !== currentPhoneNumberRef.current) return;

      if (isKoinError(err)) {
        const { status } = err;
        if (status === 400) {
          setVerificationMessage({ type: 'warning', content: MESSAGES.VERIFICATION.INCORRECT });
        }
        if (status === 404) {
          setVerificationMessage({ type: 'warning', content: MESSAGES.VERIFICATION.TIMEOUT });
          expire();
          releaseLock(requestedPhoneNumber);
        }
      }
    },
  });

  const resetVerification = () => {
    stop();
    resetTimer();
    setIsVerified(false);
    setHasSentVerificationCode(false);
    setIsSendLimitExceeded(false);
    setPhoneMessage(null);
    setVerificationMessage(null);
    setSmsSendCountData(null);
  };

  const isSending = checkPhoneNumber.isPending || sendSMS.isPending;
  const shouldShowVerificationHelp =
    showVerificationHelp &&
    hasSentVerificationCode &&
    isRunning &&
    timeLeft <= VERIFICATION_DURATION_SECONDS - VERIFICATION_HELP_DELAY_SECONDS;
  const displayedVerificationMessage: VerificationMessage | null =
    verificationMessage ??
    (shouldShowVerificationHelp ? { type: 'default', content: MESSAGES.VERIFICATION.DEFAULT } : null);

  return {
    sendVerification: withResendLock((phoneNumber: string) => checkPhoneNumber.mutate(phoneNumber), isSending),
    verifyCode,
    // 인증을 마치면 타이머가 멈추므로, 인증 전에만 잠금 안내를 보여준다.
    phoneMessage: (isVerified ? null : getResendLockMessage(isRunning)) ?? phoneMessage,
    isResendLocked,
    verificationMessage: displayedVerificationMessage,
    isVerified,
    hasSentVerificationCode,
    isSendLimitExceeded,
    isSending,
    smsSendCountData,
    resetVerification,
    formattedTime,
    timeLeft,
    isRunning,
  };
}
