import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { type QueryFilters, useQueryClient } from '@tanstack/react-query';

import { getMyLanguage, updateMyLanguage } from 'api/language';
import { DEFAULT_LANGUAGE, type LanguageCode } from 'static/language';
import { useSessionState } from 'utils/hooks/auth/useSession';
import useMount from 'utils/hooks/state/useMount';
import { getBrowserLanguage, parseLanguage, readStoredLanguage, writeLanguageCookie } from 'utils/language/language';

interface LanguageContextValue {
  language: LanguageCode;
  /** 로그인 상태면 서버 선호 언어도 바꾼 뒤 새로고침한다. 서버 저장에 실패하면 예외를 그대로 던진다. */
  changeLanguage: (language: LanguageCode) => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);
// 마운트 후 반드시 한 번 바뀌는 값이라 `LanguageContext`에 넣으면 하이드레이션 직후 언어를 쓰는 화면 전체가 다시 그려지므로 따로 둔다
const LanguageSettledContext = createContext(false);

// 화면 언어로 번역해 내려주는 조회(`requestLanguage.ts`의 `LANGUAGE_AWARE_PATHS`)의 query key 첫 칸.
// 언어가 바뀌면 이 조회만 다시 받는다. A/B 테스트 배정처럼 다시 보내면 안 되는 요청은 건드리지 않는다.
const LANGUAGE_AWARE_ROOT_KEYS = new Set(['store', 'store-mobile', 'cafeteria', 'bus', 'callvan', 'lecture']);

/**
 * 서버에 저장한 선호 언어를 쿠키에 남기고 돌려준다. 서버에 값이 없으면 지금 쓰는 언어를 서버에 저장하고 `null`을 돌려준다.
 * 동기화는 화면 이용을 막지 않는다. 실패하면 `null`을 돌려주고, 기기에 저장한 언어를 그대로 쓰다가 다음 로그인 때 다시 맞춘다.
 */
// React Compiler는 try/finally가 있는 컴포넌트를 최적화하지 않으므로 컴포넌트 밖에 둔다.
// 최적화가 빠지면 Provider value가 렌더마다 새 객체가 되어, 하이드레이션 직후 언어가 그대로여도 화면 전체가 다시 그려진다.
async function syncLanguageWithServer(): Promise<LanguageCode | null> {
  try {
    const { language: serverValue } = await getMyLanguage();
    const savedLanguage = parseLanguage(serverValue);
    if (savedLanguage) {
      writeLanguageCookie(savedLanguage);

      return savedLanguage;
    }
    await updateMyLanguage({ language: readStoredLanguage() ?? getBrowserLanguage() });
  } catch {
    // 실패해도 화면 이용은 막지 않는다
  }

  return null;
}

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
  const { session, resolved: isSessionResolved } = useSessionState();
  const isLoggedIn = session.status === 'authenticated';
  const syncedRef = useRef(false);
  const [isServerLanguageChecked, setServerLanguageChecked] = useState(false);
  const fetchedLanguageRef = useRef(initialLanguage);
  const queryClient = useQueryClient();

  // 하이드레이션까지는 서버가 그린 언어를 쓰고, 마운트 후에는 저장한 언어(없으면 브라우저 언어)를 쓴다.
  // 로그인 상태면 서버 선호 언어가 우선이므로, 확인하기 전에는 브라우저 언어로 한 번 더 바꾸지 않는다.
  const waitsForServerLanguage = isLoggedIn && !isServerLanguageChecked;
  const deviceLanguage = mounted
    ? (readStoredLanguage() ?? (waitsForServerLanguage ? initialLanguage : getBrowserLanguage()))
    : initialLanguage;
  const language = serverLanguage ?? deviceLanguage;
  const isLanguageSettled = mounted && isSessionResolved && !waitsForServerLanguage;

  // 정한 언어를 다음 서버 렌더도 쓰도록 쿠키에 남긴다. 기본 언어는 쿠키가 없어도 같게 그려지므로 남기지 않는다.
  // API 요청도 쿠키로 언어를 정하므로, 서버가 그린 언어와 달라지면 번역되는 데이터를 새 언어로 다시 받는다.
  useEffect(() => {
    if (!mounted) return;
    if (!readStoredLanguage() && language !== DEFAULT_LANGUAGE) writeLanguageCookie(language);
    if (language !== fetchedLanguageRef.current) {
      fetchedLanguageRef.current = language;
      const filters: QueryFilters = {
        predicate: ({ queryKey: [root] }) => typeof root === 'string' && LANGUAGE_AWARE_ROOT_KEYS.has(root),
      };
      // 처음 불러오는 중이라 데이터가 없는 쿼리는 invalidateQueries가 진행 중인 요청을 취소하지 않고 이전 언어 응답을 기다린다.
      // 진행 중인 요청을 먼저 취소한 뒤 새 언어 쿠키로 다시 받는다.
      queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    }
  }, [mounted, language, queryClient]);

  // 로그인하면 서버 선호 언어를 따르고, 서버에 값이 없으면 지금 쓰는 언어를 서버에 저장한다.
  useEffect(() => {
    if (!isLoggedIn) {
      syncedRef.current = false;

      return;
    }
    if (syncedRef.current) return;
    syncedRef.current = true;

    syncLanguageWithServer().then((savedLanguage) => {
      if (savedLanguage) setServerLanguage(savedLanguage);
      setServerLanguageChecked(true);
    });
  }, [isLoggedIn]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const changeLanguage = async (next: LanguageCode) => {
    if (isLoggedIn) await updateMyLanguage({ language: next });
    writeLanguageCookie(next);
    window.location.reload();
  };

  return (
    <LanguageContext.Provider value={{ language, changeLanguage }}>
      <LanguageSettledContext.Provider value={isLanguageSettled}>{children}</LanguageSettledContext.Provider>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage는 LanguageProvider 안에서만 쓸 수 있습니다.');

  return value;
}

/**
 * 화면 언어가 더 바뀌지 않으면 `true`다. 마운트 후 로그인 여부를 확인했고, 로그인 상태면 서버 선호 언어까지 확인한 뒤다.
 * 언어별로 한 번만 보내야 하는 요청은 이 값이 `true`일 때 보낸다. 그 전에 보내면 바뀌기 전 언어로 한 번 더 나간다.
 */
export function useIsLanguageSettled(): boolean {
  return useContext(LanguageSettledContext);
}
