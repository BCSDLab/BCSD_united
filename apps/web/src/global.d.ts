import '@tanstack/react-query';

import type { NativeMethod } from 'utils/ts/nativeBridge';

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: unknown;
  }
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    webkit?: {
      messageHandlers?: {
        // iOS 앱이 등록하는 브릿지 핸들러. JSON 문자열 메시지를 받는다
        tokenBridge?: { postMessage(message: string): void };
        [name: string]: { postMessage(body: unknown): void } | undefined;
      };
    };
    // Android 앱 웹뷰가 `addJavascriptInterface`로 주입하는 객체. 웹뷰 화면마다 주입하는 메서드가 달라 모두 선택이다
    Android?: Partial<Record<NativeMethod, (...args: unknown[]) => unknown>>;
  }
}
