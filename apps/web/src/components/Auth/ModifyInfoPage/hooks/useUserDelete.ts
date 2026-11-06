import { useMutation } from '@tanstack/react-query';

import { deleteUser } from 'api/auth';
import { isHttpError, isKoinError } from 'interfaces/APIError';
import { useLogout } from 'utils/hooks/auth/useLogout';
import showToast from 'utils/ts/showToast';

const useUserDelete = () => {
  const logout = useLogout();
  const mutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      showToast('success', '성공적으로 계정을 삭제하였습니다.');
      logout();
    },
    onError: (error: unknown) => {
      const data = isHttpError(error) ? error.data : undefined;
      const payloadMessage =
        data !== null && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
          ? data.message
          : undefined;
      showToast('error', (isKoinError(error) ? error.message : payloadMessage) || '에러가 발생했습니다.');
    },
  });

  return mutation;
};

export default useUserDelete;
