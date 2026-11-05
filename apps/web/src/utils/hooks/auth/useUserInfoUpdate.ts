import { useMutation } from '@tanstack/react-query';

import { updateUser, updateGeneralUser } from 'api/auth';
import type { UserUpdateRequest, GeneralUserUpdateRequest } from 'api/auth/entity';
import { isHttpError, isKoinError } from 'interfaces/APIError';
import type { UserType } from 'utils/auth/session';
import useLogger from 'utils/hooks/analytics/useLogger';
import showToast from 'utils/ts/showToast';

interface UserUpdateOption {
  onSuccess?: () => void;
  onError?: () => void;
}

const useUserInfoUpdate = <T = unknown>(userType: UserType | null, options: UserUpdateOption = {}) => {
  const logger = useLogger();
  const { status, mutate } = useMutation<T, unknown, UserUpdateRequest | GeneralUserUpdateRequest>({
    mutationFn: (data) =>
      userType === 'STUDENT' ? (updateUser(data) as Promise<T>) : (updateGeneralUser(data) as Promise<T>),
    onSuccess: () => {
      options.onSuccess?.();
      logger.actionEventClick({
        event_label: 'user_info',
        value: '정보수정 완료',
        team: 'USER',
      });
    },
    onError: (error) => {
      if (isKoinError(error) || isHttpError(error) || error instanceof Error) {
        if (error.message) showToast('error', error.message);
      }
      options.onError?.();
      logger.actionEventClick({
        event_label: 'user_info',
        value: '정보수정 실패',
        team: 'USER',
      });
    },
  });

  return {
    status,
    mutate,
  };
};

export default useUserInfoUpdate;
