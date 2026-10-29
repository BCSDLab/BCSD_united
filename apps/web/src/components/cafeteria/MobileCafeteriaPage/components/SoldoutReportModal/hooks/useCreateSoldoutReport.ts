import { isKoinError } from '@bcsdlab/koin';
import { captureError } from '@koin/telemetry/runtime';
import { useMutation } from '@tanstack/react-query';

import { cafeteriaMutations } from 'api/cafeteria/mutations';
import showMobileToast from 'components/feedback/Toast/showMobileToast';

const useCreateSoldoutReport = () => {
  const mutation = cafeteriaMutations.createSoldoutReport();

  const { mutate, isPending } = useMutation({
    ...mutation,
    onError: (error) => {
      if (isKoinError(error)) {
        showMobileToast('error', error.message || '품절 제보에 실패했습니다.');
      } else {
        captureError(error);
        showMobileToast('error', '품절 제보에 실패했습니다.');
      }
    },
  });

  return { mutate, isPending };
};

export default useCreateSoldoutReport;
