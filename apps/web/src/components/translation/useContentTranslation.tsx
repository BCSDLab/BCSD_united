import { useEffect, useRef, useState } from 'react';
import { type QueryClient, type QueryExecuteOptions, type QueryKey, useQuery } from '@tanstack/react-query';

import { checkSourceLanguage } from 'api/translation';
import type { TranslationResourceType } from 'api/translation/entity';
import type { Portal } from 'components/modal/Modal/PortalProvider';
import type { TranslateButtonState } from 'components/translation/TranslateButton';
import TranslationErrorModal from 'components/translation/TranslationErrorModal';
import useModalPortal from 'utils/hooks/layout/useModalPortal';
import { useLanguage } from 'utils/language/useLanguage';
import { translateContent } from 'utils/translation/translateContent';

interface UseContentTranslationOptions {
  /** 번역할 원문의 종류 */
  resourceType: TranslationResourceType;
  resourceId: string | number;
  parentId?: number;
  roomId?: number;
  translatePath: string;
  /** 원문 조회 응답의 `translation_source_version`. 없으면 버튼을 보여주지 않는다. */
  sourceVersion: string | null | undefined;
  /** 원문이 바뀌었다는(409) 응답을 받으면 원문을 다시 조회하고 새 `translation_source_version`을 돌려준다 */
  refetchSourceVersion: () => Promise<string | null | undefined>;
}

interface StoredTranslation<T> {
  resourceKey: string;
  language: string;
  /** 번역을 요청할 때 화면이 들고 있던 원문 버전 */
  requestedVersion: string;
  /** 서버가 실제로 번역한 원문 버전. 원문이 바뀌어(409) 다시 받았으면 `requestedVersion`과 다르다. */
  translatedVersion: string;
  data: T;
}

/**
 * 원문 쿼리를 캐시와 관계없이 다시 받아 새 `translation_source_version`을 돌려준다.
 * `useContentTranslation`의 `refetchSourceVersion`에 쓴다. 다시 받은 원문은 캐시에 들어가 화면도 함께 갱신된다.
 */
export async function refetchSourceVersion<
  TData extends { translation_source_version?: string | null },
  TError,
  TQueryKey extends QueryKey,
>(queryClient: QueryClient, options: QueryExecuteOptions<TData, TError, TData, TData, TQueryKey>) {
  const latest = await queryClient.query({ ...options, staleTime: 0 });

  return latest.translation_source_version;
}

/**
 * 콘텐츠 번역 버튼의 상태와 번역 결과를 관리한다.
 *
 * 원문 언어가 화면 언어와 달라 번역이 필요할 때만 `canTranslate`가 `true`다. 번역을 보고 있는 동안에는 원문으로 돌아갈 수 있도록 계속 `true`다.
 * 한 번 받은 번역은 같은 원문·버전·화면 언어인 동안 다시 요청하지 않고 원문 보기와 번갈아 보여준다.
 * 번역에 실패하거나 제공할 수 없으면 원문을 유지하고 안내 모달을 띄운다.
 * 결과가 오기 전에 화면을 떠났거나 다른 글로 바뀌었으면 그 결과는 버린다.
 */
export default function useContentTranslation<T>({
  resourceType,
  resourceId,
  parentId,
  roomId,
  translatePath,
  sourceVersion,
  refetchSourceVersion: refetchVersion,
}: UseContentTranslationOptions) {
  const { language } = useLanguage();
  const portalManager = useModalPortal();
  const [stored, setStored] = useState<StoredTranslation<T> | null>(null);
  // 보고 있는 번역과 진행 중인 요청을 원문·화면 언어·버전으로 기록해, 원문이나 언어가 바뀌면 자동으로 무효가 되게 한다
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [translatingKey, setTranslatingKey] = useState<string | null>(null);

  // 경로 파라미터만 바뀌면 화면 컴포넌트가 재사용되므로, 응답이 왔을 때 아직 같은 원문을 같은 언어로 보고 있는지 확인한다
  const resourceKey = `${resourceType}:${resourceId}:${parentId ?? ''}:${roomId ?? ''}`;
  // 409로 원문을 다시 받으면 요청 중에 `sourceVersion`이 바뀌므로, 진행 중 표시는 원문·언어로만 구분한다
  const activeKey = `${resourceKey}|${language}`;
  const activeKeyRef = useRef<string | null>(activeKey);
  // 렌더가 반영되기 전에 버튼이 두 번 눌려도 요청을 한 번만 보낸다
  const inFlightRef = useRef(false);
  useEffect(() => {
    activeKeyRef.current = activeKey;

    return () => {
      activeKeyRef.current = null;
    };
  }, [activeKey]);

  const { data: sourceLanguage } = useQuery({
    queryKey: [
      'translation',
      'source-language',
      resourceType,
      String(resourceId),
      parentId,
      roomId,
      language,
      sourceVersion,
    ],
    queryFn: () =>
      checkSourceLanguage({
        resource_type: resourceType,
        resource_id: String(resourceId),
        parent_id: parentId,
        room_id: roomId,
        target_language: language,
      }),
    // 원문 언어는 원문 버전이 같으면 바뀌지 않는다
    staleTime: Infinity,
    // 앱 기본값처럼 서버 렌더 중에는 조회하지 않는다. 원문 버전이 없으면 번역을 요청할 수 없으니 조회하지 않는다.
    enabled: typeof window !== 'undefined' && !!sourceVersion,
  });

  // 409로 원문을 다시 받으면 캐시를 따르는 화면은 `sourceVersion`이 번역된 버전으로 바뀌고, 캐시를 따르지 않는 화면은 요청한 버전 그대로다.
  // 둘 중 하나와 같으면 같은 번역으로 본다.
  const current =
    stored &&
    stored.resourceKey === resourceKey &&
    stored.language === language &&
    (stored.requestedVersion === sourceVersion || stored.translatedVersion === sourceVersion)
      ? stored
      : null;
  const currentShownKey = current ? `${resourceKey}|${language}|${current.translatedVersion}` : null;
  const isShowingTranslation = currentShownKey !== null && shownKey === currentShownKey;
  const isTranslating = translatingKey === activeKey;

  let state: TranslateButtonState = 'original';
  if (isTranslating) state = 'translating';
  else if (isShowingTranslation) state = 'translated';

  // 번역 중이거나 번역을 보고 있으면, 원문 버전이 바뀌어 원문 언어를 다시 확인하는 동안에도 버튼을 보여준다
  const canTranslate = sourceLanguage?.data?.translation_required === true || isTranslating || isShowingTranslation;

  const openErrorModal = (type: 'failed' | 'unavailable') => {
    portalManager.open((portal: Portal) => <TranslationErrorModal type={type} onClose={portal.close} />);
  };

  const toggle = async () => {
    if (state === 'translating' || inFlightRef.current || !sourceVersion) return;
    if (state === 'translated') {
      setShownKey(null);

      return;
    }
    if (current) {
      setShownKey(currentShownKey);

      return;
    }

    const requestedKey = activeKey;
    inFlightRef.current = true;
    setTranslatingKey(requestedKey);
    const outcome = await translateContent<T>({
      path: translatePath,
      targetLanguage: language,
      sourceVersion,
      refetchSourceVersion: refetchVersion,
    });
    inFlightRef.current = false;
    setTranslatingKey((key) => (key === requestedKey ? null : key));
    if (activeKeyRef.current !== requestedKey) return;

    if (outcome.kind === 'success') {
      setStored({
        resourceKey,
        language,
        requestedVersion: sourceVersion,
        translatedVersion: outcome.sourceVersion,
        data: outcome.data,
      });
      setShownKey(`${resourceKey}|${language}|${outcome.sourceVersion}`);

      return;
    }
    openErrorModal(outcome.kind);
  };

  return {
    canTranslate,
    state,
    /** 번역을 보여주는 중일 때만 값이 있다. 없으면 원문을 그린다. */
    translated: isShowingTranslation && current ? current.data : null,
    toggle,
  };
}
