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
    onSuccess: (_data, variables) => {
      options.onSuccess?.();
      logger.actionEventClick({
        event_label: 'account__edit_profile__profile_edit__confirm__click',
        value: '정보수정 완료',
        event_name: 'DA2',
      });
      // 계정 3-4: 웹은 정보수정 폼에서 비밀번호도 함께 저장하므로, 비밀번호를 바꾼 저장이면 3-3과 함께 보낸다
      if (variables.password) {
        logger.actionEventClick({
          event_name: 'DA2',
          event_label: 'account__password_change__password_change__confirm__click',
          value: '비밀번호 수정 완료',
        });
      }
    },
    onError: (error, variables) => {
      if (isKoinError(error) || isHttpError(error) || error instanceof Error) {
        if (error.message) showToast('error', error.message);
      }
      options.onError?.();
      logger.actionEventClick({
        event_label: 'account__edit_profile__profile_edit__confirm__click',
        value: '정보수정 실패',
        event_name: 'DA2',
      });
      // 계정 3-4: 웹은 정보수정 폼에서 비밀번호도 함께 저장하므로, 비밀번호를 바꾼 저장이면 3-3과 함께 보낸다
      if (variables.password) {
        logger.actionEventClick({
          event_name: 'DA2',
          event_label: 'account__password_change__password_change__confirm__click',
          value: '비밀번호 수정 실패',
        });
      }
    },
  });

  return {
    status,
    mutate,
  };
};

export default useUserInfoUpdate;
