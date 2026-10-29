import { useEffect, useState, type ReactNode } from 'react';
import { HydrationBoundary, QueryClientProvider, type DehydratedState } from '@tanstack/react-query';
import { useLocation, useMatches, useRouter } from '@tanstack/react-router';

import Toast from 'components/feedback/Toast';
import PortalProvider from 'components/modal/Modal/PortalProvider';
import Seo from 'components/seo/Seo';
import ROUTES from 'static/routes';
import { clearLegacySessionStorage } from 'utils/auth/legacyStorage';
import { useSessionState } from 'utils/hooks/auth/useSession';
import type { ServerRequestContext } from 'utils/ssr/requestContext';
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
}: {
  children: ReactNode;
  serverRequest: ServerRequestContext | null;
}) {
  const [client] = useState(() => (typeof window === 'undefined' ? createQueryClient() : queryClient));
  const matches = useMatches();
  const pathname = useLocation({ select: (location) => location.pathname });
  const leaf = matches.at(-1);
  const data = matches.map((match): unknown => match.loaderData).findLast(isPageData);
  const title = leaf?.staticData.title;
  const pageTitle = typeof title === 'function' ? title(pathname) : title;

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
          <PortalProvider>
            <AuthGuard required={leaf?.staticData.requireAuth ?? false} />
            {!leaf?.staticData.hasPageSeo && <Seo title={pageTitle} />}
            {children}
            <Toast />
          </PortalProvider>
        </ServerRequestProvider>
      </HydrationBoundary>
    </QueryClientProvider>
  );
}
