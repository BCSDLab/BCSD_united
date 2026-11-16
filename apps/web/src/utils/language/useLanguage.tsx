import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { getMyLanguage, updateMyLanguage } from 'api/language';
import { DEFAULT_LANGUAGE, type LanguageCode } from 'static/language';
import { LANGUAGE_COOKIE_KEY } from 'static/url';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useMount from 'utils/hooks/state/useMount';
import { getBrowserLanguage, parseLanguage, writeLanguageCookie } from 'utils/language/language';
import { getCookie } from 'utils/ts/cookie';

interface LanguageContextValue {
  language: LanguageCode;
  /** 로그인 상태면 서버 선호 언어도 바꾼 뒤 새로고침한다. 서버 저장에 실패하면 예외를 그대로 던진다. */
  changeLanguage: (language: LanguageCode) => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const readStoredLanguage = () => parseLanguage(getCookie(LANGUAGE_COOKIE_KEY));

/**
 * 화면 언어 우선순위: 로그인 사용자의 서버 선호 언어 → 기기에 저장한 언어(쿠키) → 브라우저·OS 언어 → 기본 언어.
 *
 * 서버 렌더는 쿠키만 보고 그리므로, 쿠키가 없을 때의 브라우저 언어와 로그인 후의 서버 선호 언어는 마운트 후 반영한다.
 * 정한 언어는 다음 서버 렌더도 같은 언어로 그리도록 쿠키에 남긴다.
 */
export function LanguageProvider({
  initialLanguage,
  children,
}: {
  initialLanguage: LanguageCode;
  children: ReactNode;
}) {
  const mounted = useMount();
  const [serverLanguage, setServerLanguage] = useState<LanguageCode | null>(null);
  const isLoggedIn = useIsLoggedIn();
  const syncedRef = useRef(false);

  // 하이드레이션까지는 서버가 그린 언어를 쓰고, 마운트 후에는 저장한 언어(없으면 브라우저 언어)를 쓴다
  const deviceLanguage = mounted ? (readStoredLanguage() ?? getBrowserLanguage()) : initialLanguage;
  const language = serverLanguage ?? deviceLanguage;

  // 정한 언어를 다음 서버 렌더도 쓰도록 쿠키에 남긴다. 기본 언어는 쿠키가 없어도 같게 그려지므로 남기지 않는다.
  useEffect(() => {
    if (mounted && !readStoredLanguage() && language !== DEFAULT_LANGUAGE) writeLanguageCookie(language);
  }, [mounted, language]);

  // 로그인하면 서버 선호 언어를 따르고, 서버에 값이 없으면 지금 쓰는 언어를 서버에 저장한다.
  useEffect(() => {
    if (!isLoggedIn) {
      syncedRef.current = false;

      return;
    }
    if (syncedRef.current) return;
    syncedRef.current = true;

    const syncWithServer = async () => {
      try {
        const { language: serverValue } = await getMyLanguage();
        const savedLanguage = parseLanguage(serverValue);
        if (savedLanguage) {
          writeLanguageCookie(savedLanguage);
          setServerLanguage(savedLanguage);

          return;
        }
        await updateMyLanguage({ language: readStoredLanguage() ?? getBrowserLanguage() });
      } catch {
        // 동기화는 화면 이용을 막지 않는다. 실패하면 기기에 저장한 언어를 그대로 쓰고 다음 로그인 때 다시 맞춘다.
      }
    };
    syncWithServer();
  }, [isLoggedIn]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const changeLanguage = async (next: LanguageCode) => {
    if (isLoggedIn) await updateMyLanguage({ language: next });
    writeLanguageCookie(next);
    window.location.reload();
  };

  return <LanguageContext.Provider value={{ language, changeLanguage }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage는 LanguageProvider 안에서만 쓸 수 있습니다.');

  return value;
}
