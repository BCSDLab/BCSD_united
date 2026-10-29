import type { ExecutionContext, ExportedHandler } from '@cloudflare/workers-types';
import { runWithAi, type AiEnvironment } from '@koin/b-bot-ai';
import { createDatabaseScope } from '@koin/b-bot-database';
import nitro from './.output/server/index.mjs';

type Bindings = Parameters<typeof createDatabaseScope>[0] & AiEnvironment;
const app = nitro as ExportedHandler<Bindings>;

async function invoke<T>(
  env: Bindings,
  context: ExecutionContext,
  handler: (context: ExecutionContext) => T | Promise<T>,
): Promise<T> {
  const database = createDatabaseScope(env);
  const pending: Promise<unknown>[] = [];
  const scopedContext = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException: () => context.passThroughOnException(),
    props: context.props,
  } as ExecutionContext;

  return runWithAi(env, () =>
    database.run(async () => {
      try {
        return await handler(scopedContext);
      } finally {
        context.waitUntil(
          (async () => {
            const failures: unknown[] = [];
            try {
              for (let index = 0; index < pending.length;) {
                const batch = pending.slice(index);
                index = pending.length;
                const results = await Promise.allSettled(batch);
                for (const result of results) {
                  if (result.status === 'rejected') failures.push(result.reason);
                }
              }
            } finally {
              await database.close();
            }
            if (failures.length > 0) throw new AggregateError(failures, 'Worker background task failed');
          })(),
        );
      }
    }),
  );
}

export default {
  fetch(request, env, context) {
    return invoke(env, context, (scoped) => app.fetch!(request, env, scoped));
  },
  async scheduled(controller, env, context) {
    await invoke(env, context, (scoped) => app.scheduled!(controller, env, scoped));
  },
  async queue(batch, env, context) {
    await invoke(env, context, (scoped) => app.queue!(batch, env, scoped));
  },
} satisfies ExportedHandler<Bindings>;
