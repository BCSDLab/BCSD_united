import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

import useMobileView from 'utils/hooks/layout/useMobileView';
import type { DeviceClass } from 'utils/ssr/requestContext';

/**
 * 데스크톱 화면이 따로 없는 모바일 전용 페이지에서, 모바일 화면 조건(`useMobileView`)이 풀리면
 * (데스크톱 기기에서 창을 넓히면) 대응하는 데스크톱 페이지로 바꾼다.
 * 진입 판정은 loader가 `isMobileView`로 하고, 이 훅은 페이지를 보는 중에 창 폭이 바뀌는 경우를 맡는다.
 */
export default function useMobileOnlyPage(device: DeviceClass, desktopHref: string) {
  const routeNavigate = useNavigate();
  const showMobile = useMobileView(device);

  useEffect(() => {
    if (!showMobile) {
      routeNavigate({ href: desktopHref, replace: true });
    }
  }, [showMobile, desktopHref, routeNavigate]);
}
