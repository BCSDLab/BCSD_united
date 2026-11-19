import { useState } from 'react';
import {
  CancelledError,
  type QueryClient,
  type QueryExecuteOptions,
  type QueryKey,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import type { TranslationResourceType } from 'api/translation/entity';
import { translationQueries, translationQueryKeys } from 'api/translation/queries';
import type { Portal } from 'components/modal/Modal/PortalProvider';
import type { TranslateButtonState } from 'components/translation/TranslateButton';
import TranslationErrorModal from 'components/translation/TranslationErrorModal';
import useModalPortal from 'utils/hooks/layout/useModalPortal';
import { useLanguage } from 'utils/language/useLanguage';
import { TranslationRequestError } from 'utils/translation/translateContent';

/** 원문이 바뀌었다는(409) 응답을 받았을 때 원문을 다시 받아 새 버전을 찾는 방법. `translationSource`로 만든다. */
export interface TranslationSource {
  refetchVersion: (queryClient: QueryClient) => Promise<string | null | undefined>;
}

/** 원문은 캐시와 관계없이 다시 받아 캐시에 넣으므로, 그 query를 쓰는 화면의 원문도 새 버전으로 함께 바뀐다. */
export function translationSource<TData, TError, TQueryKey extends QueryKey>(
  query: QueryExecuteOptions<TData, TError, TData, TData, TQueryKey>,
  selectVersion: (data: TData) => string | null | undefined,
): TranslationSource {
  return {
    refetchVersion: async (queryClient) => selectVersion(await queryClient.query({ ...query, staleTime: 0 })),
  };
}

export interface UseContentTranslationOptions {
  /** 번역할 원문의 종류 */
  resourceType: TranslationResourceType;
  resourceId: string | number;
  parentId?: number;
  roomId?: number;
  translatePath: string;
  /** 원문 조회 응답의 `translation_source_version`. 없으면 버튼을 보여주지 않는다. */
  sourceVersion: string | null | undefined;
  source: TranslationSource;
}

/**
 * 콘텐츠 번역 버튼의 상태와 번역 결과를 관리한다.
 *
 * 원문 언어가 화면 언어와 달라 번역이 필요할 때만 `canTranslate`가 `true`다. 번역을 보고 있는 동안에는 원문으로 돌아갈 수 있도록 계속 `true`다.
 * 번역문은 원문 버전·화면 언어별로 캐시해 다시 요청하지 않고, 원문 보기와 번갈아 보여준다.
 * 번역에 실패하거나 제공할 수 없으면 원문을 유지하고 안내 모달을 띄운다.
 * 응답 전에 화면을 떠나거나 다른 글·언어로 바뀌면 요청을 취소한다.
 */
export default function useContentTranslation<T>({
  resourceType,
  resourceId,
  parentId,
  roomId,
  translatePath,
  sourceVersion,
  source,
}: UseContentTranslationOptions) {
  const { language } = useLanguage();
  const queryClient = useQueryClient();
  const portalManager = useModalPortal();
  // 경로 파라미터만 바뀌면 화면 컴포넌트가 재사용되므로, 보고 있는 번역과 진행 중인 요청을 원문·화면 언어로 구분한다
  const activeKey = `${resourceType}:${resourceId}:${parentId ?? ''}:${roomId ?? ''}|${language}`;
  const [shownKey, setShownKey] = useState<string | null>(null);
  // 409로 원문을 다시 받으면 요청 중에 `sourceVersion`이 바뀌므로, 요청이 끝날 때까지는 요청한 버전의 query를 지켜본다
  const [requested, setRequested] = useState<{ key: string; version: string } | null>(null);
  const requestedVersion = requested?.key === activeKey ? requested.version : null;

  const { data: sourceLanguage } = useQuery({
    ...translationQueries.sourceLanguage(
      {
        resource_type: resourceType,
        resource_id: String(resourceId),
        parent_id: parentId,
        room_id: roomId,
        target_language: language,
      },
      sourceVersion,
    ),
    // 앱 기본값처럼 서버 렌더 중에는 조회하지 않는다. 원문 버전이 없으면 번역을 요청할 수 없으니 조회하지 않는다.
    enabled: typeof window !== 'undefined' && !!sourceVersion,
  });

  const contentQuery = (version: string) =>
    translationQueries.content<T>({
      path: translatePath,
      language,
      sourceVersion: version,
      refetchSourceVersion: () => source.refetchVersion(queryClient),
    });
  // 요청 중이 아니면 캐시만 읽는다. 화면을 떠나거나 다른 글·언어로 바뀌어 이 구독이 끊기면 진행 중인 요청이 취소된다.
  const { data: translation } = useQuery({
    ...contentQuery(requestedVersion ?? sourceVersion ?? ''),
    enabled: requestedVersion !== null,
  });

  const isTranslating = requestedVersion !== null;
  const isShowingTranslation = !isTranslating && shownKey === activeKey && !!translation;

  let state: TranslateButtonState = 'original';
  if (isTranslating) state = 'translating';
  else if (isShowingTranslation) state = 'translated';

  // 번역 중이거나 번역을 보고 있으면, 원문 버전이 바뀌어 원문 언어를 다시 확인하는 동안에도 버튼을 보여준다
  const canTranslate = sourceLanguage?.data?.translation_required === true || isTranslating || isShowingTranslation;

  const openErrorModal = (type: 'failed' | 'unavailable') => {
    portalManager.open((portal: Portal) => <TranslationErrorModal type={type} onClose={portal.close} />);
  };

  const toggle = async () => {
    if (isTranslating || !sourceVersion) return;
    if (isShowingTranslation) {
      setShownKey(null);

      return;
    }
    if (translation) {
      setShownKey(activeKey);

      return;
    }

    const requestedKey = activeKey;
    setRequested({ key: requestedKey, version: sourceVersion });
    try {
      const result = await queryClient.query(contentQuery(sourceVersion));
      // 409로 새 버전을 번역했으면 원문 캐시가 새 버전으로 바뀐 화면에서도 보이도록 그 버전에도 넣는다
      if (result.sourceVersion !== sourceVersion) {
        queryClient.setQueryData(translationQueryKeys.content(translatePath, language, result.sourceVersion), result);
      }
      setShownKey(requestedKey);
    } catch (error) {
      if (error instanceof CancelledError) return;
      openErrorModal(
        error instanceof TranslationRequestError && error.kind === 'unavailable' ? 'unavailable' : 'failed',
      );
    } finally {
      setRequested((current) => (current?.key === requestedKey ? null : current));
    }
  };

  return {
    canTranslate,
    state,
    /** 번역을 보여주는 중일 때만 값이 있다. 없으면 원문을 그린다. */
    translated: isShowingTranslation && translation ? translation.data : null,
    toggle,
  };
}
