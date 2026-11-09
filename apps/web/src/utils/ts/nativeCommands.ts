import { notifyNative } from 'utils/ts/nativeBridge';

// 여러 도메인의 웹뷰가 함께 쓰는 앱 명령. 한 도메인에서만 쓰는 명령은 그 도메인 폴더에 둔다

export function closeWebView(): boolean {
  return notifyNative('backButtonTapped');
}
