import { createContext, useContext } from 'react';

import type { ServerRequestContext } from 'utils/ssr/requestContext';

/**
 * 서버가 렌더에 사용한 요청 정보. `ApplicationProviders`가 페이지 loader 데이터의 값을, 없으면
 * 루트 컨텍스트의 값을 흘린다.
 *
 * `null`이면 서버 요청 정보가 없다는 뜻이다. 이때 각 훅은 기본값으로 동작한다.
 */
const ServerRequestContextValue = createContext<ServerRequestContext | null>(null);

export const ServerRequestProvider = ServerRequestContextValue.Provider;

export const useServerRequest = () => useContext(ServerRequestContextValue);
