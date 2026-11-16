import { createServerFn } from '@tanstack/react-start';
import { getCookie, getRequest } from '@tanstack/react-start/server';

import { DEFAULT_LANGUAGE } from 'static/language';
import { LANGUAGE_COOKIE_KEY, WEB_AUTH_CSRF_COOKIE_KEY } from 'static/url';
import { parseLanguage } from 'utils/language/language';
import { getServerMessages } from 'utils/language/serverMessages';
import type { RootSnapshot } from 'utils/ssr/pageLoader';
import { getServerRequestContext } from 'utils/ssr/requestContext';

export const getRootSnapshot = createServerFn({ method: 'GET' }).handler(async (): Promise<RootSnapshot> => {
  // 화면 언어는 쿠키만으로 정해지므로, 세션 확인을 기다리지 않고 표시 문구 사전을 함께 받기 시작한다.
  const language = parseLanguage(getCookie(LANGUAGE_COOKIE_KEY)) ?? DEFAULT_LANGUAGE;
  const [serverRequest, messages] = await Promise.all([
    getServerRequestContext(getRequest()),
    language === DEFAULT_LANGUAGE ? null : getServerMessages(language),
  ]);

  return { serverRequest, hasSession: Boolean(getCookie(WEB_AUTH_CSRF_COOKIE_KEY)), messages };
});
