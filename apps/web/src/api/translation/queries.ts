import { queryOptions } from '@tanstack/react-query';

import { TranslationRequestError, translateContent } from 'utils/translation/translateContent';

import type { SourceLanguageRequest } from './entity';
import { checkSourceLanguage } from './index';

export const translationQueryKeys = {
  all: ['translation'] as const,
  sourceLanguage: (request: SourceLanguageRequest, sourceVersion: string | null | undefined) =>
    [...translationQueryKeys.all, 'source-language', request, sourceVersion] as const,
  content: (path: string, language: string, sourceVersion: string) =>
    [...translationQueryKeys.all, 'content', path, language, sourceVersion] as const,
};

export interface TranslatedContent<T> {
  data: T;
  /** 서버가 실제로 번역한 원문 버전. 원문이 바뀌어(409) 다시 요청했으면 요청한 버전과 다르다. */
  sourceVersion: string;
}

interface ContentQueryParams {
  path: string;
  language: string;
  sourceVersion: string;
  refetchSourceVersion: () => Promise<string | null | undefined>;
}

// 원문 언어와 번역문은 원문 버전·화면 언어가 같으면 바뀌지 않는다
export const translationQueries = {
  sourceLanguage: (request: SourceLanguageRequest, sourceVersion: string | null | undefined) =>
    queryOptions({
      queryKey: translationQueryKeys.sourceLanguage(request, sourceVersion),
      queryFn: () => checkSourceLanguage(request),
      staleTime: Infinity,
    }),

  // 실패를 캐시에 남기면 다시 눌러도 요청하지 않으므로, 성공이 아니면 오류로 던진다
  content: <T>({ path, language, sourceVersion, refetchSourceVersion }: ContentQueryParams) =>
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- 원문을 다시 받는 방법은 번역 결과를 바꾸지 않는다
    queryOptions({
      queryKey: translationQueryKeys.content(path, language, sourceVersion),
      queryFn: async ({ signal }): Promise<TranslatedContent<T>> => {
        const outcome = await translateContent<T>({
          path,
          targetLanguage: language,
          sourceVersion,
          refetchSourceVersion,
          signal,
        });
        if (outcome.kind === 'success') return { data: outcome.data, sourceVersion: outcome.sourceVersion };
        throw new TranslationRequestError(outcome.kind);
      },
      staleTime: Infinity,
      retry: false,
    }),
};
