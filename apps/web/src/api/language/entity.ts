import type { APIResponse } from 'interfaces/APIResponse';

export interface Language {
  code: string;
  name: string;
}

export interface LanguagesResponse extends APIResponse {
  default_language: string;
  languages: Language[];
}

export interface MyLanguageResponse extends APIResponse {
  /** 서버에 저장한 선호 언어. 설정한 적이 없으면 `null`이다. */
  language: string | null;
}

export interface UpdateMyLanguageRequest {
  language: string;
}

export type PolicyType = 'privacy' | 'terms';

export interface PolicySection {
  id: number;
  title: string;
  content: string | string[];
  items?: string[];
  additionalContent?: string;
  additionalItems?: string[];
}

export interface PolicyResponse extends APIResponse {
  type: PolicyType;
  requested_language: string;
  /** 실제로 내려준 문서의 언어. 번역이 없으면 `ko-KR`이다. */
  language: string;
  /** 요청한 언어의 번역이 없어 한국어 원문을 대신 내려줬으면 `true`다. */
  is_fallback: boolean;
  sections: PolicySection[];
}
