import type { ReactNode } from 'react';
import { captureError } from '@koin/telemetry/runtime';
import {
  createRootRoute,
  HeadContent,
  notFound,
  Outlet,
  redirect,
  Scripts,
  useLocation,
  useMatches,
} from '@tanstack/react-router';

import ApplicationProviders from 'components/app/ApplicationProviders';
import Layout from 'components/layout';
import { NotFoundPage } from 'routes/404.index';
import { isDisabledOrderPath, isProtectedPath } from 'static/routeAccess';
import ROUTES from 'static/routes';
import { parseSearch, stringifySearch } from 'utils/routing/search';
import { getClientRootSnapshot, type RootSnapshot } from 'utils/ssr/pageLoader';
import type { ServerRequestContext } from 'utils/ssr/requestContext';
import { getRootSnapshot } from 'utils/ssr/rootContext.functions';

import 'pretendard/dist/web/static/pretendard-dynamic-subset.css';
import 'assets/font/fonts.scss';
import 'styles/global.scss';

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): Record<string, string | string[] | undefined> =>
    parseSearch(stringifySearch(search)),
  beforeLoad: async ({ location, matches }): Promise<RootSnapshot> => {
    if (isDisabledOrderPath(location.pathname)) throw notFound();
    // 하이드레이션 이후 화면 이동은 서버 함수를 거치지 않고 SSR 스냅샷과 브라우저 세션으로 만든다.
    // 루트 매치는 항상 matches[0]이고 loaderData는 아래 loader가 돌려준 값이다. 자기 참조라 타입을 직접 적는다
    const rootLoaderData = matches[0]?.loaderData as { serverRequest?: ServerRequestContext } | undefined;
    const snapshot =
      typeof window !== 'undefined' && rootLoaderData?.serverRequest
        ? await getClientRootSnapshot(rootLoaderData.serverRequest)
        : await getRootSnapshot();
    if (isProtectedPath(location.pathname) && !snapshot.hasSession) {
      throw redirect({ href: ROUTES.Auth() + '?redirect=' + encodeURIComponent(location.href) });
    }

    return snapshot;
  },
  loader: ({ context }) => ({ serverRequest: context.serverRequest }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'theme-color', content: '#000000' },
      { name: 'author', content: 'BCSD Lab' },
      { name: 'google', content: 'notranslate' },
    ],
    links: [
      { rel: 'preconnect', href: 'https://static.koreatech.in', crossOrigin: 'anonymous' },
      { rel: 'icon', type: 'image/svg+xml', sizes: 'any', href: '/favicon.svg' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      { rel: 'shortcut icon', href: '/favicon.ico' },
    ],
  }),
  onError: (error) => captureError(error),
  shellComponent: RootDocument,
  component: () => <Outlet />,
  notFoundComponent: () => (
    <Layout>
      <NotFoundPage />
    </Layout>
  ),
  errorComponent: ({ reset }) => (
    <Layout>
      <main>
        <h1>페이지를 불러오지 못했습니다.</h1>
        <button type="button" onClick={reset}>
          다시 시도
        </button>
      </main>
    </Layout>
  ),
});

function RootDocument({ children }: { children: ReactNode }) {
  const matches = useMatches();
  const data = matches.find((match) => match.routeId === '__root__')?.loaderData;
  const pathname = useLocation({ select: (location) => location.pathname });
  const gtmId = process.env.NEXT_PUBLIC_GTM_ID;
  const gaId = process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID;

  return (
    <html lang="ko">
      <head>
        {!pathname.startsWith(ROUTES.OrderHome()) && (
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        )}
        <HeadContent />
      </head>
      <body>
        {gtmId && (
          <noscript>
            <iframe
              title="Google Tag Manager"
              src={'https://www.googletagmanager.com/ns.html?id=' + gtmId}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        )}
        <ApplicationProviders serverRequest={data?.serverRequest ?? null}>{children}</ApplicationProviders>
        {gtmId && (
          <script
            dangerouslySetInnerHTML={{
              __html:
                '(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({"gtm.start":new Date().getTime(),event:"gtm.js"});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src="https://www.googletagmanager.com/gtm.js?id="+i;f.parentNode.insertBefore(j,f);})(window,document,"script","dataLayer",' +
                JSON.stringify(gtmId).replaceAll('<', '\u003c') +
                ');',
            }}
          />
        )}
        {gaId && (
          <>
            <script async src={'https://www.googletagmanager.com/gtag/js?id=' + gaId} />
            <script
              dangerouslySetInnerHTML={{
                __html:
                  'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config",' +
                  JSON.stringify(gaId).replaceAll('<', '\u003c') +
                  ');',
              }}
            />
          </>
        )}
        <Scripts />
      </body>
    </html>
  );
}
