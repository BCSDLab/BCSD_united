import { isKoinError } from '@bcsdlab/koin';
import { captureError } from '@koin/telemetry/runtime';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { callvanMutations } from 'api/callvan/mutations';
import useCallvanRestrictionModal from 'components/Callvan/hooks/useCallvanRestrictionModal';
import showToast from 'utils/ts/showToast';

const useCreateCallvan = () => {
  const queryClient = useQueryClient();
  const mutation = callvanMutations.create(queryClient);
  const { openFromError } = useCallvanRestrictionModal();

  const { mutate, isPending } = useMutation({
    ...mutation,
    onError: async (e) => {
      try {
        if (await openFromError(e)) return;
      } catch (restrictionError) {
        captureError(restrictionError);
      }

      if (isKoinError(e)) {
        showToast('error', e.message || '게시글 작성에 실패했습니다.');
      } else {
        captureError(e);
        showToast('error', '게시글 작성에 실패했습니다.');
      }
    },
  });

  return { mutate, isPending };
};

export default useCreateCallvan;
