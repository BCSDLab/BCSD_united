import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabaseScope, getPool } from '../../src/index.ts';

const directory = new URL('./', import.meta.url);

async function migrate() {
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const scope = createDatabaseScope({
    ...process.env,
    DB_HOST: process.env.DB_HOST ?? process.env.PGHOST ?? '127.0.0.1',
    DB_PORT: process.env.DB_PORT ?? process.env.PGPORT ?? '5432',
    DB_USER: process.env.DB_USER ?? process.env.PGUSER ?? 'postgres',
    DB_PASSWORD: process.env.DB_PASSWORD ?? process.env.PGPASSWORD,
    DB_NAME: process.env.DB_NAME ?? process.env.PGDATABASE ?? 'postgres',
  });
  try {
    await scope.run(async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(913367541)');
        await client.query(`CREATE TABLE IF NOT EXISTS b_bot_schema_migrations (
          filename TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const { rows } = await client.query('SELECT filename, checksum FROM b_bot_schema_migrations');
        const applied = new Map(rows.map((row) => [row.filename, row.checksum]));
        for (const filename of files) {
          const sql = await readFile(new URL(filename, directory), 'utf8');
          const checksum = createHash('sha256').update(sql).digest('hex');
          if (applied.has(filename)) {
            if (applied.get(filename) !== checksum) {
              throw new Error(
                `Applied migration ${filename} was modified. Restore it and add a new SQL migration instead.`,
              );
            }
            continue;
          }
          await client.query(sql);
          await client.query('INSERT INTO b_bot_schema_migrations (filename, checksum) VALUES ($1, $2)', [
            filename,
            checksum,
          ]);
          console.info(`Applied ${filename}`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  } finally {
    await scope.close();
  }
}

migrate().catch((error) => {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
});
