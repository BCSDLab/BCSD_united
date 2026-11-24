import type { APIResponse } from 'interfaces/APIResponse';

export type TranslationStatus = 'PENDING' | 'SUCCESS' | 'UNAVAILABLE' | 'FAILED';

/** 번역 버튼을 보여줄지 확인할 원문 종류 (`POST /translations/source-language`) */
export type TranslationResourceType =
  | 'ARTICLE_SUMMARY'
  | 'LOST_ITEM'
  | 'RECRUITMENT'
  | 'LOST_ITEM_MESSAGE'
  | 'RECRUITMENT_MESSAGE';

export interface TranslationRequest {
  /** 화면 언어 코드 */
  target_language: string;
  /** 원문 조회 응답의 `translation_source_version`. 원문이 바뀌었으면 서버가 409로 거절한다. */
  expected_source_version: string;
}

export interface TranslationResult<T> extends APIResponse {
  /** `PENDING`이면 `GET /translations/{translationId}`로 결과를 다시 조회한다. 제공 불가 등은 `null`이다. */
  translation_id: string | null;
  status: TranslationStatus;
  target_language: string;
  source_version: string;
  reason_code: string | null;
  retryable: boolean;
  data: T | null;
  /** 응답의 `Retry-After` 헤더(초). 서버 응답 본문이 아니라 웹이 헤더에서 읽어 붙인다. */
  retryAfterSeconds?: number | null;
}

export interface SourceLanguageRequest {
  resource_type: TranslationResourceType;
  resource_id: string;
  /** 쪽지의 부모 글 ID */
  parent_id?: number;
  /** 쪽지의 채팅방 ID */
  room_id?: number;
  target_language: string;
}

export interface SourceLanguageData {
  /** 실제 원문 언어. `other`·`mul`·`und`도 올 수 있다. */
  source_language: string;
  /** `true`일 때만 번역 버튼을 보여준다. 같은 언어거나 판별할 문장이 없으면 `false`다. */
  translation_required: boolean;
}
