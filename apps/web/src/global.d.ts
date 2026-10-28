import '@tanstack/react-query';

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: unknown;
  }
}


type NativeCallbackResult = boolean | void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    webkit?: {
      messageHandlers?: {
        [name: string]: { postMessage(body: unknown): void };
      };
    };
    onNativeCallback?: (callbackId: string, result: NativeCallbackResult) => void;
    NativeBridge?: {
      call: <T extends NativeCallbackResult>(methodName: string, ...args: unknown[]) => Promise<T>;
      handleCallback: (callbackId: string, result: NativeCallbackResult) => void;
    };
  }
}
