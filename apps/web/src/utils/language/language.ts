import { DEFAULT_LANGUAGE, LANGUAGE_CODES, type LanguageCode } from 'static/language';
import { LANGUAGE_COOKIE_KEY } from 'static/url';
import { getCookie, getCookieDomain, setCookie } from 'utils/ts/cookie';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// 브라우저 언어 태그의 첫 부분(en, zh 등)만 맞을 때 고를 지원 언어
const LANGUAGE_BY_PRIMARY_TAG: Record<string, LanguageCode> = {
  ko: 'ko-KR',
  en: 'en-US',
  zh: 'zh-Hans',
  mn: 'mn-MN',
  uz: 'uz-Latn',
  my: 'my-MM',
  ja: 'ja-JP',
};

// 번체 중국어는 지원하지 않으므로 간체로 넘기지 않는다
const UNSUPPORTED_TAGS = /^zh-(hant|tw|hk|mo)\b/i;

/** 쿠키·서버 값처럼 신뢰할 수 없는 문자열을 지원 언어 코드로 바꾼다. 대소문자는 서버와 같이 무시하고, 지원하지 않으면 `null`이다. */
export function parseLanguage(value: string | null | undefined): LanguageCode | null {
  if (!value) return null;
  const lowerValue = value.trim().toLowerCase();

  return LANGUAGE_CODES.find((code) => code.toLowerCase() === lowerValue) ?? null;
}

/** 브라우저·OS 언어 목록(우선순위 순)에서 처음으로 지원하는 언어를 고른다. 하나도 없으면 `null`이다. */
export function detectLanguage(browserLanguages: readonly string[]): LanguageCode | null {
  for (const tag of browserLanguages) {
    const exact = parseLanguage(tag);
    if (exact) return exact;
    if (UNSUPPORTED_TAGS.test(tag)) continue;

    const primaryTag = tag.split('-')[0].toLowerCase();
    if (primaryTag in LANGUAGE_BY_PRIMARY_TAG) return LANGUAGE_BY_PRIMARY_TAG[primaryTag];
  }

  return null;
}

/** 브라우저에 저장한 화면 언어(쿠키). 화면 언어와 API 요청 언어가 같은 값을 쓰도록 이 함수로만 읽는다. */
export function readStoredLanguage(): LanguageCode | null {
  return parseLanguage(getCookie(LANGUAGE_COOKIE_KEY));
}

export function getBrowserLanguage(): LanguageCode {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];

  return detectLanguage(languages) ?? DEFAULT_LANGUAGE;
}

export function writeLanguageCookie(language: LanguageCode) {
  setCookie(LANGUAGE_COOKIE_KEY, language, { maxAge: ONE_YEAR_SECONDS, domain: getCookieDomain() });
}
