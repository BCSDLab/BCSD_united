// KOIN_ORDER_WEBVIEW와 배율을 맞춘다. initial-scale이 없으면 내용의 최소 폭이 화면보다 넓을 때 축소된다.
export default function OrderViewport() {
  return <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />;
}
