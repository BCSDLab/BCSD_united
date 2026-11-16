import { useEffect, useState, type ReactNode } from 'react';
import { HydrationBoundary, QueryClientProvider, type DehydratedState } from '@tanstack/react-query';
import { useLocation, useMatches, useRouter } from '@tanstack/react-router';

import type { MessagesResponse } from 'api/language/entity';
import { languageQueries } from 'api/language/queries';
import Toast from 'components/feedback/Toast';
import PortalProvider from 'components/modal/Modal/PortalProvider';
import Seo from 'components/seo/Seo';
import { DEFAULT_LANGUAGE } from 'static/language';
import ROUTES from 'static/routes';
import { clearLegacySessionStorage } from 'utils/auth/legacyStorage';
import { initializeSessionConfirmation } from 'utils/auth/sessionConfirmation';
import { useSessionState } from 'utils/hooks/auth/useSession';
import { LanguageProvider } from 'utils/language/useLanguage';
import type { ServerRequestContext } from 'utils/ssr/requestContext';
import { initializeServerClock } from 'utils/ssr/serverClock';
import { ServerRequestProvider } from 'utils/ssr/useServerRequest';
import { isomorphicLocalStorage } from 'utils/ts/env';
import { createQueryClient, queryClient } from 'utils/ts/queryClient';

interface PageData {
  serverRequest?: ServerRequestContext;
  dehydratedState?: DehydratedState;
}

function isPageData(value: unknown): value is PageData {
  return typeof value === 'object' && value !== null && ('serverRequest' in value || 'dehydratedState' in value);
}

function AuthGuard({ required }: { required: boolean }) {
  const router = useRouter();
  const { session, resolved } = useSessionState();

  useEffect(() => {
    if (required && resolved && session.status === 'anonymous') router.navigate({ href: ROUTES.Main(), replace: true });
  }, [required, resolved, session.status, router]);

  return null;
}

export default function ApplicationProviders({
  children,
  serverRequest,
  messages,
}: {
  children: ReactNode;
  serverRequest: ServerRequestContext | null;
  messages: MessagesResponse | null;
}) {
  const [client] = useState(() => {
    const nextClient = typeof window === 'undefined' ? createQueryClient() : queryClient;
    // 서버가 함께 내려준 표시 문구 사전을 첫 렌더 전에 채워, 서버와 브라우저가 같은 문구로 그리게 한다
    const language = serverRequest?.language;
    if (messages && language) nextClient.setQueryData(languageQueries.messages(language).queryKey, messages);

    return nextClient;
  });
  const matches = useMatches();
  const pathname = useLocation({ select: (location) => location.pathname });
  const leaf = matches.at(-1);
  const data = matches.map((match): unknown => match.loaderData).findLast(isPageData);
  const title = leaf?.staticData.title;
  const pageTitle = typeof title === 'function' ? title(pathname) : title;

  // 자식의 useSessionState와 첫 클라이언트 이동이 스냅샷을 읽기 전에 동기 초기화해야 한다.
  useState(() => {
    if (typeof window !== 'undefined') {
      const initial = data?.serverRequest ?? serverRequest;
      if (initial) {
        initializeSessionConfirmation(initial.isLoggedIn);
        initializeServerClock(initial.now, initial.mayBeSharedCached);
      }
    }
  });

  useEffect(() => {
    clearLegacySessionStorage();
    if (typeof window === 'undefined') return;
    const userId = isomorphicLocalStorage.getItem('uuid') || '';
    window.dataLayer = window.dataLayer || [];
    if (userId) window.dataLayer.push({ user_id: userId, event: 'userIdAvailable' });
    if (typeof window.gtag === 'undefined') {
      window.gtag = ((...args: Gtag.GtagCommands[]) => window.dataLayer?.push(args)) as Gtag.Gtag;
    }
  }, []);

  return (
    <QueryClientProvider client={client}>
      <HydrationBoundary state={data?.dehydratedState}>
        <ServerRequestProvider value={data?.serverRequest ?? serverRequest}>
          <LanguageProvider initialLanguage={(data?.serverRequest ?? serverRequest)?.language ?? DEFAULT_LANGUAGE}>
            <PortalProvider>
              <AuthGuard required={leaf?.staticData.requireAuth ?? false} />
              {!leaf?.staticData.hasPageSeo && <Seo title={pageTitle} />}
              {children}
              <Toast />
            </PortalProvider>
          </LanguageProvider>
        </ServerRequestProvider>
      </HydrationBoundary>
    </QueryClientProvider>
  );
}
