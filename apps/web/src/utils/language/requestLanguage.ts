import { DEFAULT_LANGUAGE, type LanguageCode } from 'static/language';
import { LANGUAGE_COOKIE_KEY } from 'static/url';
import { parseLanguage, readStoredLanguage } from 'utils/language/language';
import { getServerRequestHeaders } from 'utils/ssr/cookieForwarding';
import { readCookieHeader } from 'utils/ts/cookie';

/**
 * `language` 쿼리를 받아 서버 값을 번역해 주는 조회 API
 * 응답은 원문 필드를 그대로 두고 번역한 `display_*` 필드를 더한다
 * `Accept-Language` 헤더로는 번역하지 않으므로 쿼리로 보내야 한다.
 * 경로를 추가하면 `useLanguage.tsx`의 `LANGUAGE_AWARE_ROOT_KEYS`도 함께 맞춘다.
 */
const LANGUAGE_AWARE_PATHS = [
  /^(v2\/|v3\/)?shops$/,
  /^shops\/categories$/,
  /^(v2\/)?shops\/\d+$/,
  /^shops\/\d+\/summary$/,
  /^dinings$/,
  /^callvan$/,
  /^callvan\/posts\/\d+(\/summary|\/chat)?$/,
  /^bus\/timetable\/shuttle\/[^/]+$/,
  /^bus\/timetable\/city$/,
  /^bus\/route$/,
  /^v3\/lectures$/,
  /^v3\/timetables\/(lecture|main\/lectures)$/,
];

export function isLanguageAwarePath(path: string): boolean {
  const normalized = path.split('?')[0].replace(/^\/+/, '');

  return LANGUAGE_AWARE_PATHS.some((pattern) => pattern.test(normalized));
}

/**
 * 지금 요청을 보낼 화면 언어. 브라우저는 언어 쿠키, 서버 렌더는 원본 요청의 Cookie 헤더에서 읽는다.
 * 쿠키가 없으면 기본 언어다. 기본 언어가 아닌 언어는 `LanguageProvider`가 항상 쿠키에 남긴다.
 */
export function getRequestLanguage(): LanguageCode {
  const language =
    typeof window === 'undefined'
      ? parseLanguage(readCookieHeader(getServerRequestHeaders()?.cookie, LANGUAGE_COOKIE_KEY))
      : readStoredLanguage();

  return language ?? DEFAULT_LANGUAGE;
}
