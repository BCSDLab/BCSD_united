import { captureError } from '@koin/telemetry/runtime';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { chatMutations } from 'api/chat/mutations';
import { isKoinError } from 'interfaces/APIError';
import showToast from 'utils/ts/showToast';

const useSendCallvanChat = (userId: number | null, roomId: string) => {
  const queryClient = useQueryClient();
  const mutation = chatMutations.sendMessage(queryClient, userId, roomId);

  const { mutate, isPending } = useMutation({
    ...mutation,
    onError: (e) => {
      if (isKoinError(e)) {
        showToast('error', e.message || '메시지 전송에 실패했습니다.');
      } else {
        captureError(e);
        showToast('error', '메시지 전송에 실패했습니다.');
      }
    },
  });

  return { mutate, isPending };
};

export default useSendCallvanChat;
