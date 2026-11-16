import { WebSession } from 'api/auth/APIDetail';
import { DEFAULT_LANGUAGE, type LanguageCode } from 'static/language';
import { LANGUAGE_COOKIE_KEY, WEB_AUTH_ACCESS_COOKIE_KEY } from 'static/url';
import { toUserType, type UserType } from 'utils/auth/session';
import { parseLanguage } from 'utils/language/language';
import APIClient from 'utils/ts/apiClient';
import { readCookieHeader } from 'utils/ts/cookie';

export type DeviceClass = 'mobile' | 'desktop';

export interface ServerRequestContext {
  device: DeviceClass;
  isLoggedIn: boolean;
  /** `GET /v2/web/auth/session`으로 서버가 직접 확인한 값. 로그인 상태일 때만 의미 있다. */
  userType: UserType | null;
  /** 서버 렌더 시각(ISO). 공유 캐시된 문서에서는 오래됐을 수 있다. */
  now: string;
  /** 문서가 공유 캐시에서 제공될 수 있으면 클라이언트는 새 서버 시각을 받아야 한다. */
  mayBeSharedCached: boolean;
  /**
   * 서버 렌더에 쓴 화면 언어. 언어 쿠키가 없으면 기본 언어다.
   * 브라우저 언어 판정과 로그인 사용자의 서버 선호 언어 반영은 마운트 후 `LanguageProvider`가 한다.
   */
  language: LanguageCode;
}

/** UA로 기기를 분류한다. 서버는 창 폭을 모르므로 첫 렌더 화면을 이 값으로 고른다. */
const MOBILE_UA = /iphone|ipod|android.*mobile|windows phone/i;

export function getDeviceClass(userAgent: string | undefined): DeviceClass {
  return userAgent && MOBILE_UA.test(userAgent) ? 'mobile' : 'desktop';
}

/**
 * 서버만 아는 요청 정보를 렌더 트리에 넘기기 위해 추출한다.
 *
 * 이 값들이 없으면 서버는 "비로그인 데스크톱"을 가정해 렌더하고, 클라이언트는 마운트 후
 * 실제 값으로 다시 그린다. 그 과정에서 서버가 그린 DOM이 통째로 버려진다.
 *
 * 인증 상태를 SSR에 반영해도 캐시는 안전하다. 쿠키가 있는 요청은 공개 캐시를 켜지 않는다(`loadPageData`).
 *
 * 세션 유효성은 원본 Cookie를 그대로 실어 세션 조회(`GET /v2/web/auth/session`)로 백엔드가 확인한다.
 */
// 요청 처리 중에 만료되지 않도록 둔 여유
const ACCESS_EXPIRY_MARGIN_MS = 10_000;

/**
 * 서버는 access를 갱신할 수 없으므로 만료됐으면 비로그인으로 렌더하고 클라이언트가 갱신하게 둔다.
 * 세션 조회는 refresh가 함께 오면 access가 만료돼도 authenticated를 돌려주는데(로컬 개발 프록시가 그렇다),
 * 그대로 로그인으로 렌더하면 인증 요청이 401로 실패한다. 운영에선 만료 시 세션 조회 요청 자체를 아낀다.
 * HttpOnly는 브라우저 JS만 막으므로 서버는 Cookie 헤더의 JWT에서 만료 시각을 읽을 수 있다.
 */
function hasUsableAccessToken(accessToken: string | undefined): boolean {
  const payload = accessToken?.split('.')[1];
  if (!payload) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());

    return typeof exp === 'number' && exp * 1000 > Date.now() + ACCESS_EXPIRY_MARGIN_MS;
  } catch {
    return false;
  }
}

export async function getServerRequestContext(request: Request): Promise<ServerRequestContext> {
  const device = getDeviceClass(request.headers.get('user-agent') ?? undefined);
  const now = new Date().toISOString();
  const cookie = request.headers.get('cookie');

  const accessToken = readCookieHeader(cookie, WEB_AUTH_ACCESS_COOKIE_KEY);
  const language = parseLanguage(readCookieHeader(cookie, LANGUAGE_COOKIE_KEY)) ?? DEFAULT_LANGUAGE;
  // 공유 캐시는 언어 쿠키로 나뉘지 않으므로 기본 언어로 그린 응답만 공유 캐시에 남긴다
  const isDefaultLanguage = language === DEFAULT_LANGUAGE;
  if (!cookie || !hasUsableAccessToken(accessToken)) {
    return { device, isLoggedIn: false, userType: null, now, mayBeSharedCached: isDefaultLanguage, language };
  }

  try {
    const session = await APIClient.request(new WebSession({ Cookie: cookie, Origin: new URL(request.url).origin }));
    const userType = session.authenticated ? toUserType(session.user_type) : null;

    return {
      device,
      isLoggedIn: userType !== null,
      userType,
      now,
      mayBeSharedCached: userType === null && isDefaultLanguage,
      language,
    };
  } catch {
    return { device, isLoggedIn: false, userType: null, now, mayBeSharedCached: isDefaultLanguage, language };
  }
}
