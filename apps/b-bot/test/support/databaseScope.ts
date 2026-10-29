import { createDatabaseScope } from '@koin/b-bot-database';
import { test, type TestContext } from 'vitest';

export async function withDatabaseScope<T>(callback: () => T | Promise<T>): Promise<T> {
  const env = import.meta.env;
  if (!env.DB_HOST || !env.DB_NAME?.endsWith('_test')) {
    throw new Error('Database integration tests require DB_HOST and a DB_NAME ending in _test.');
  }
  const scope = createDatabaseScope({
    DB_HOST: env.DB_HOST,
    DB_PORT: env.DB_PORT,
    DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD,
    DB_NAME: env.DB_NAME,
  });
  try {
    return await scope.run(callback);
  } finally {
    await scope.close();
  }
}

export function databaseTest(name: string, callback: (context: TestContext) => void | Promise<void>) {
  return test(name, (context) => withDatabaseScope(() => callback(context)));
}
