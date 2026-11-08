import { useRouter } from '@tanstack/react-router';

import ROUTES from 'static/routes';
import useGoBack from 'utils/hooks/routing/useGoBack';
import { notifyNative } from 'utils/ts/nativeBridge';

/**
 * 주문 웹뷰(결제·결과·취소)를 벗어나는 이동. 앱 웹뷰면 앱에 맡기고, 아니거나 앱에 보내지 못하면 웹 화면으로 이동한다.
 * 앱은 `navigateBack` 하나로 받아 현재 웹뷰 경로를 보고 어디로 갈지 정한다.
 */
export default function useOrderExit() {
  const router = useRouter();
  const goBack = useGoBack();

  return {
    /** 결제 화면에서 장바구니로 돌아간다 */
    backToCart: () => {
      if (notifyNative('navigateBack')) return;
      goBack(ROUTES.OrderCart());
    },
    /** 주문 흐름(결과·취소)을 끝내고 주문 홈으로 간다. 결과·취소 화면으로 되돌아오지 않게 기록을 바꾼다 */
    close: () => {
      if (notifyNative('navigateBack')) return;
      router.navigate({ href: ROUTES.OrderHome(), replace: true });
    },
    /** 가게 상세를 연다 */
    openShop: (shopId: number) => {
      if (notifyNative('goToShopDetail', shopId)) return;
      router.navigate({ href: ROUTES.OrderShop({ id: String(shopId) }) });
    },
  };
}
