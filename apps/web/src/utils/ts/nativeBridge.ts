const isBrowser = () => typeof window !== 'undefined';

// 앱과의 계약. 키는 앱이 받는 메서드 이름이고 이름이나 인자를 바꾸려면 앱도 함께 바꿔야 한다
// TODO: 응답이 필요한 메서드가 생기면 메시지 버전(v)·id와 `{ id, ok, result } | { id, ok: false, error }` 응답 형식을
//  모바일과 합의해 요청(request)을 추가한다

/** 웹 → 앱, 응답 없음. 값은 앱에 넘기는 인자 목록이다 */
export interface NativeNotifications {
  /** 앱이 웹뷰를 닫는다 */
  backButtonTapped: [];
  /** 주문 웹뷰에서 앱으로 돌아간다. 어디로 갈지는 앱이 현재 웹뷰 경로를 보고 정한다 */
  navigateBack: [];
  /** 앱의 가게 상세를 연다 */
  goToShopDetail: [orderableShopId: number];
}

export type NativeMethod = keyof NativeNotifications;

let messageIdCounter = 0;

// iOS 동아리 웹뷰는 callbackId가 없으면 메시지를 버리므로, 웹이 응답을 받지 않아도 값을 채워 보낸다
const generateMessageId = () => {
  messageIdCounter += 1;

  return `cb_${messageIdCounter}`;
};

type Send = (args: unknown[]) => void;

/**
 * 지금 웹뷰에서 이 메서드를 앱에 보낼 함수. 앱 웹뷰가 아니거나 앱이 메서드를 주입하지 않았으면 `null`이다.
 */
function getSend(methodName: NativeMethod): Send | null {
  if (!isBrowser()) return null;

  // iOS는 앱이 등록한 메시지 핸들러에 JSON 문자열을 보낸다
  const ios = window.webkit?.messageHandlers?.tokenBridge;
  if (ios) {
    return (args) => ios.postMessage(JSON.stringify({ method: methodName, args, callbackId: generateMessageId() }));
  }

  // Android는 메서드마다 `@JavascriptInterface`를 주입하므로 그 메서드를 직접 부른다
  // TODO: Android도 postMessage 하나로 받게 되면 iOS와 같은 메시지를 보낸다
  const android = window.Android;
  const androidMethod = android?.[methodName];
  if (typeof androidMethod === 'function') return (args) => androidMethod.apply(android, args);

  return null;
}

/**
 * 앱에 명령을 보내고 응답은 기다리지 않는다. 앱 웹뷰가 아니거나 보내지 못하면 `false`이므로 호출부는 웹 이동으로 대신한다.
 */
export function notifyNative<M extends NativeMethod>(methodName: M, ...args: NativeNotifications[M]): boolean {
  const send = getSend(methodName);
  if (!send) return false;

  try {
    send(args);

    return true;
  } catch (error) {
    console.warn(error);

    return false;
  }
}
