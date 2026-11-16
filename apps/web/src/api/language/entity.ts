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
  /** 서버에 저장한 선호 언어. 설정한 적이 없으면 null이다. */
  language: string | null;
}

export interface UpdateMyLanguageRequest {
  language: string;
}
