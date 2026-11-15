import useMediaQuery, { MOBILE_QUERY } from 'utils/hooks/layout/useMediaQuery';
import type { DeviceClass } from 'utils/ssr/requestContext';

/**
 * 모바일 화면과 데스크톱 화면을 따로 그리는 페이지가 모바일 화면을 쓸지 정한다.
 *
 * - 모바일 기기(UA)는 화면 폭과 관계없이 모바일 화면을 쓴다. 가로로 돌려 폭이 넓어져도 화면이 바뀌지 않는다.
 * - 데스크톱 기기는 창 폭이 모바일 폭(`MOBILE_QUERY`)이면 모바일 화면을 쓴다.
 *
 * SSR과 하이드레이션은 `useMediaQuery`의 서버 스냅샷(UA 판정)을 따르므로 서버 HTML과 어긋나지 않고,
 * 마운트 뒤 실제 창 폭으로 다시 판정한다. `device`는 loader가 돌려준 `serverRequest.device`를 넘긴다.
 */
export default function useMobileView(device: DeviceClass): boolean {
  const isMobileWidth = useMediaQuery();

  return device === 'mobile' || isMobileWidth;
}

/**
 * loader가 어느 화면의 데이터를 미리 받을지 정한다. `useMobileView`와 같은 기준이다.
 * SSR은 창 폭을 모르므로 UA로만 판정하고, 브라우저 이동은 실제 창 폭도 본다.
 */
export function isMobileView(device: DeviceClass): boolean {
  return device === 'mobile' || (typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
}
