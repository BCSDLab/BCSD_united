import { type APIRequest, HTTP_METHOD } from 'interfaces/APIRequest';

import type { LanguagesResponse, MyLanguageResponse, UpdateMyLanguageRequest } from './entity';

export class Languages<R extends LanguagesResponse> implements APIRequest<R> {
  method = HTTP_METHOD.GET;

  path = '/languages';

  response!: R;
}

export class MyLanguage<R extends MyLanguageResponse> implements APIRequest<R> {
  method = HTTP_METHOD.GET;

  path = '/users/me/language';

  // 로그인 직후 배경에서 맞추는 조회라 세션이 끝났어도 로그인 화면으로 보내지 않는다
  authOptional = true;

  response!: R;
}

export class UpdateMyLanguage<R extends MyLanguageResponse> implements APIRequest<R> {
  method = HTTP_METHOD.PATCH;

  path = '/users/me/language';

  response!: R;

  constructor(public data: UpdateMyLanguageRequest) {}
}
