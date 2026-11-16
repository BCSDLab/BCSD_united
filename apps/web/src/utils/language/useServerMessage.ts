import { useQuery } from '@tanstack/react-query';

import { languageQueries } from 'api/language/queries';
import { DEFAULT_LANGUAGE } from 'static/language';
import { useLanguage } from 'utils/language/useLanguage';

/**
 * 서버가 코드나 한국어 원문으로 내려주는 값(모집 상태, 분실물 분류 등)을 화면 언어 문구로 바꾸는 함수를 돌려준다.
 *
 * 사전은 `그룹.값` 키(`recruitment.status.RECRUITING`, `lost_item.category.카드`)로 찾는다.
 * 한국어 화면과 사전에 없는 값은 `fallback`을 그대로 돌려주므로, 화면에 보여줄 한국어 문구를 `fallback`으로 넘긴다.
 * 서버 원문을 그대로 보여주는 값이면 `fallback`을 생략한다. 원문을 쓰고, 값이 없으면 빈 문자열이다.
 * 돌려준 문구는 화면 표시에만 쓰고, 비교·로그·요청에는 원래 값을 쓴다.
 */
export default function useServerMessage() {
  const { language } = useLanguage();
  const isDefaultLanguage = language === DEFAULT_LANGUAGE;
  const { data } = useQuery({
    ...languageQueries.messages(language),
    // 앱 기본값처럼 서버 렌더 중에는 조회하지 않는다. 서버 렌더는 루트에서 받아 `ApplicationProviders`가 채운 사전을 쓴다.
    enabled: typeof window !== 'undefined' && !isDefaultLanguage,
    // 훅을 쓰는 컴포넌트가 많아, 실패한 사전을 컴포넌트가 붙을 때마다 다시 요청하지 않게 한다
    retryOnMount: false,
  });

  return (group: string, value: string | number | null | undefined, fallback?: string): string => {
    // 서버가 값을 주지 않으면 빈 문자열을 돌려줘, 빈 값 표시(복덕방 표의 ` - ` 등)가 그대로 동작하게 한다
    const original = fallback ?? (value == null ? '' : String(value));
    if (isDefaultLanguage || value == null) return original;

    return data?.[`${group}.${value}`] ?? original;
  };
}
