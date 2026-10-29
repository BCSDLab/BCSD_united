import { isKoinError, sendClientError } from '@bcsdlab/koin';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { clubMutations } from 'api/club/mutations';
import showToast from 'utils/ts/showToast';

export default function useDeleteEvent() {
  const { id } = useParams({ strict: false });
  const queryClient = useQueryClient();

  return useMutation({
    ...clubMutations.deleteEvent(queryClient, Number(id), {
      onSuccess: () => {
        showToast('success', '행사 삭제되었습니다.');
      },
    }),
    onError: (error) => {
      if (isKoinError(error)) {
        showToast('error', error.message);
      } else {
        sendClientError(error);
      }
    },
  });
}
