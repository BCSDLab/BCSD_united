import { isKoinError } from '@bcsdlab/koin';
import { captureError } from '@koin/telemetry/runtime';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { callvanMutations } from 'api/callvan/mutations';
import showToast from 'utils/ts/showToast';

const useCloseCallvan = () => {
  const queryClient = useQueryClient();
  const mutation = callvanMutations.close(queryClient);

  const { mutate, isPending } = useMutation({
    ...mutation,
    onError: (e) => {
      if (isKoinError(e)) {
        showToast('error', e.message || '모집 마감에 실패했습니다.');
      } else {
        captureError(e);
        showToast('error', '모집 마감에 실패했습니다.');
      }
    },
  });

  return { mutate, isPending };
};

export default useCloseCallvan;
