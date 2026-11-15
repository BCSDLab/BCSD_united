import { Fragment, Suspense, useEffect, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';

import { SSRLayout } from 'components/layout';
import useMobileView from 'utils/hooks/layout/useMobileView';
import type { DeviceClass } from 'utils/ssr/requestContext';

// 화면이 바뀌면 미리 받지 않은 데이터를 쓰게 될 수 있으므로 Suspense로 감싼다.
// 두 화면이 같은 컴포넌트(오류 경계 등)로 시작해도 상태를 이어받지 않도록 화면별 key로 다시 마운트한다.
// 페이지 헤더 레이아웃은 모바일 폭에서만 레거시 헤더를 숨기므로 데스크톱 화면에도 그대로 쓴다.
interface ResponsivePageProps {
  device: DeviceClass;
  mobile: ReactNode;
  desktop: ReactNode;
}

/** 모바일 화면과 데스크톱 화면을 따로 가진 페이지. `useMobileView` 기준으로 하나를 그린다. */
export function ResponsivePage({ device, mobile, desktop }: ResponsivePageProps) {
  const showMobile = useMobileView(device);

  return (
    <SSRLayout mobileHeader="page">
      <Suspense fallback={null}>
        <Fragment key={showMobile ? 'mobile' : 'desktop'}>{showMobile ? mobile : desktop}</Fragment>
      </Suspense>
    </SSRLayout>
  );
}

interface MobileOnlyPageProps {
  device: DeviceClass;
  desktopHref: string;
  children: ReactNode;
}

/** 데스크톱 화면이 없는 모바일 전용 페이지. 모바일 화면 조건이 풀리면 `desktopHref`로 바꾼다. */
export function MobileOnlyPage({ device, desktopHref, children }: MobileOnlyPageProps) {
  const routeNavigate = useNavigate();
  const showMobile = useMobileView(device);

  useEffect(() => {
    if (!showMobile) routeNavigate({ href: desktopHref, replace: true });
  }, [showMobile, desktopHref, routeNavigate]);

  return <SSRLayout mobileHeader="page">{children}</SSRLayout>;
}
