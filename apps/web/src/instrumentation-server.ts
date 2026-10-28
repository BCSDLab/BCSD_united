import { maskSensitive } from '@koin/telemetry';
import * as Sentry from '@sentry/cloudflare';

interface SentryEnvironment {
  NEXT_PUBLIC_SENTRY_DSN?: string;
  NEXT_PUBLIC_SENTRY_ENVIRONMENT?: string;
  NEXT_PUBLIC_SENTRY_RELEASE?: string;
}

/** 민감 파일을 탐색하는 봇 요청 경로. 애플리케이션 결함이 아니므로 이슈로 만들지 않는다. */
const BOT_PROBE_PATTERN = /\/(\.env|\.git|\.aws|wp-admin|wp-login|phpmyadmin|\.well-known\/security)/i;

interface KoinErrorLike {
  type?: string;
  status?: number;
  code?: number;
}

function asKoinError(error: unknown): KoinErrorLike | null {
  if (error == null) return null;

  if (typeof error === 'object') {
    const candidate = error as KoinErrorLike;
    if (candidate.type === 'KOIN_ERROR') return candidate;
  }

  // 직렬화된 KoinError가 Error 메시지로 전달되어도 같은 상태 코드 필터를 적용한다.
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as KoinErrorLike;
      if (parsed?.type === 'KOIN_ERROR') return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

function getTransactionKey(transaction: string | undefined): string | undefined {
  if (!transaction) return undefined;
  if (/\/articles\/(?:\$id|:id|[0-9]+)(?:\/|\?|$)/.test(transaction)) return 'article_detail';
  return undefined;
}

const options: Sentry.CloudflareOptions = {
  enabled: process.env.NODE_ENV === 'production',

  beforeSendTransaction(event) {
    const transactionKey = getTransactionKey(event.transaction);
    if (transactionKey) {
      event.tags = { ...event.tags, 'koin.transaction_key': transactionKey };
    }
    return event;
  },

  beforeSend(event, hint) {
    if (event.request?.url && BOT_PROBE_PATTERN.test(event.request.url)) return null;

    const koinError = asKoinError(hint.originalException);
    if (koinError) {
      // 401(토큰 만료) · 404(삭제된 리소스)는 정상 흐름이므로 이슈로 만들지 않는다.
      if (koinError.status === 401 || koinError.status === 404) return null;

      // KoinError는 Error 인스턴스가 아니라 plain object다. 그대로 두면 Sentry가
      // "Object captured as exception with keys: ..." 로 묶어 서로 다른 에러가 한 이슈에
      // 뒤섞이고 스택도 남지 않는다. 상태 코드별로 그룹을 분리한다.
      event.fingerprint = ['koin-error', String(koinError.status), String(koinError.code ?? 'no-code')];
      event.tags = {
        ...event.tags,
        'koin.error_type': koinError.type ?? 'KOIN_ERROR',
        'koin.error_status': String(koinError.status ?? 'unknown'),
        'koin.error_code': String(koinError.code ?? 'no-code'),
      };
      event.exception?.values?.forEach((value) => {
        value.type = `KoinError(${koinError.status ?? 'unknown'})`;
      });
    }

    return maskSensitive(event);
  },

  beforeSendLog(log) {
    if (log.level === 'debug') return null;
    // API가 인증 실패 응답에 토큰 원문을 실어 보내고, 그 메시지가 그대로 로그로 넘어온다.
    return maskSensitive(log);
  },

  // plain object로 throw된 에러의 추가 속성을 이벤트에 붙인다 (KoinError 대응)
  integrations: [
    Sentry.extraErrorDataIntegration(),
    // 스트리밍 SSR의 복구 가능한 렌더 오류는 요청 핸들러로 전파되지 않고 console.error로 보고된다.
    Sentry.captureConsoleIntegration({ levels: ['error'] }),
  ],

  enableLogs: true,
  tracesSampleRate: 1.0,
  // 자격증명급 위험이 있는 항목만 최소로 차단한다. cookie 헤더는 httpHeaders가 아니라
  // 별도의 cookies 옵션으로 처리되므로 여기 deny에 넣어도 효과가 없다.
  // frameContextLines: 7은 sendDefaultPii: true 시절의 기본값을 그대로 유지한 것이다.
  dataCollection: {
    cookies: false,
    httpHeaders: {
      request: { deny: ['authorization', 'referer'] },
      response: { deny: ['authorization', 'referer'] },
    },
    frameContextLines: 7,
  },
};

/** 요청별 Worker 바인딩으로 DSN·환경·릴리스를 결정하며 전역 SDK를 초기화하지 않는다. */
export function getSentryOptions(env: SentryEnvironment): Sentry.CloudflareOptions {
  return {
    ...options,
    dsn: env.NEXT_PUBLIC_SENTRY_DSN,
    environment: env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    release: env.NEXT_PUBLIC_SENTRY_RELEASE,
  };
}
