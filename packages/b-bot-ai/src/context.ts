import { AsyncLocalStorage } from 'node:async_hooks';

export interface AiEnvironment {
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

const invocation = new AsyncLocalStorage<AiEnvironment>();

export function runWithAi<T>(env: AiEnvironment, callback: () => T): T {
  return invocation.run(env, callback);
}

export function currentEnvironment(): AiEnvironment {
  const scoped = invocation.getStore();
  if (scoped) return scoped;
  return typeof process === 'undefined'
    ? {}
    : {
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      };
}

export function hasAiCredentials(): boolean {
  const env = currentEnvironment();
  return (
    typeof env.AI?.run === 'function' || Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim() && env.CLOUDFLARE_API_TOKEN?.trim())
  );
}
