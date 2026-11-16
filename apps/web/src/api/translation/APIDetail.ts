import { type APIRequest, type APIResult, HTTP_METHOD } from 'interfaces/APIRequest';

import type { SourceLanguageData, SourceLanguageRequest, TranslationRequest, TranslationResult } from './entity';

const parseRetryAfter = (value: string | null): number | null => {
  if (!value) return null;
  const seconds = Number(value);

  return Number.isFinite(seconds) ? seconds : null;
};

// 진행 중(`PENDING`)이면 다시 조회할 시점을 `Retry-After` 헤더로 알려주므로 본문에 함께 담는다
const withRetryAfter = <R extends TranslationResult<unknown>>({ data, headers }: APIResult<R>): R => ({
  ...data,
  retryAfterSeconds: parseRetryAfter(headers.get('Retry-After')),
});

export class SourceLanguage<R extends TranslationResult<SourceLanguageData>> implements APIRequest<R> {
  method = HTTP_METHOD.POST;

  path = '/translations/source-language';

  response!: R;

  constructor(public data: SourceLanguageRequest) {}
}

/** 콘텐츠 번역 요청. 경로는 원문 종류마다 달라 호출부가 넘긴다(예: `/articles/lost-item/{id}/translations`). */
export class RequestTranslation<R extends TranslationResult<unknown>> implements APIRequest<R> {
  method = HTTP_METHOD.POST;

  response!: R;

  constructor(
    public path: string,
    public data: TranslationRequest,
  ) {}

  parse(result: APIResult<R>): R {
    return withRetryAfter(result);
  }
}

export class TranslationById<R extends TranslationResult<unknown>> implements APIRequest<R> {
  method = HTTP_METHOD.GET;

  path: string;

  response!: R;

  constructor(translationId: string) {
    this.path = `/translations/${encodeURIComponent(translationId)}`;
  }

  parse(result: APIResult<R>): R {
    return withRetryAfter(result);
  }
}
