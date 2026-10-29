import { isKoinError } from '@bcsdlab/koin';
import { captureError } from '@koin/telemetry/runtime';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { articleMutations } from 'api/articles/mutations';
import showToast from 'utils/ts/showToast';

const usePutLostItemArticle = (articleId: number) => {
  const queryClient = useQueryClient();
  const mutation = articleMutations.updateLostItem(queryClient, articleId);
  const { status, mutateAsync } = useMutation({
    ...mutation,
    onSuccess: async (...args) => {
      await mutation.onSuccess?.(...args);
      showToast('success', '게시글 수정이 완료되었습니다.');
    },
    onError: (e) => {
      if (isKoinError(e)) {
        showToast('error', e.message);
      } else captureError(e);
    },
  });

  return { status, mutateAsync };
};

export default usePutLostItemArticle;
