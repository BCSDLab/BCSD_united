import useMediaQuery, { MOBILE_QUERY } from 'utils/hooks/layout/useMediaQuery';
import type { DeviceClass } from 'utils/ssr/requestContext';

/**
 * 모바일 화면을 쓸지 정한다. 모바일 기기(UA)이거나 창이 모바일 폭이면 모바일 화면이다.
 * 모바일 기기는 가로로 돌려 폭이 넓어져도 모바일 화면을 유지한다.
 * 서버는 창 폭을 모르므로 SSR·하이드레이션은 UA로 판정하고, 마운트 뒤 실제 폭으로 다시 판정한다.
 */
export default function useMobileView(device: DeviceClass): boolean {
  const isMobileWidth = useMediaQuery();

  return device === 'mobile' || isMobileWidth;
}

/** loader용 `useMobileView`. SSR은 UA로만, 브라우저 이동은 실제 창 폭도 본다. */
export function isMobileView(device: DeviceClass): boolean {
  return device === 'mobile' || (typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
}
