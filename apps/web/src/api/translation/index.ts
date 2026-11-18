import APIClient from 'utils/ts/apiClient';

import { RequestTranslation, SourceLanguage, TranslationById } from './APIDetail';
import type { TranslationRequest, TranslationResult } from './entity';

export const checkSourceLanguage = APIClient.of(SourceLanguage);

// 번역 결과(`data`) 형태가 원문 종류마다 달라 호출부가 타입을 정하도록 제네릭 함수로 둔다
export const requestTranslation = <T>(path: string, data: TranslationRequest, signal?: AbortSignal) =>
  APIClient.request(new RequestTranslation<TranslationResult<T>>(path, data, signal));

export const getTranslation = <T>(translationId: string, signal?: AbortSignal) =>
  APIClient.request(new TranslationById<TranslationResult<T>>(translationId, signal));
