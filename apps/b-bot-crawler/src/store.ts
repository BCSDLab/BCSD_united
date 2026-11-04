import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Connector = 'github' | 'notion' | 'gdrive';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
export type JobRequest = { connector: Connector; idempotencyKey: string; full?: boolean };
export type JobResult = Record<string, number | string>;
export type Job = {
  id: string;
  connector: Connector;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: JobResult;
  error?: string;
};

type Row = {
  id: string;
  connector: Connector;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
  full: number;
  idempotency_key: string;
};

function publicJob(row: Row): Job {
  const job: Job = {
    id: row.id,
    connector: row.connector,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.result !== null) job.result = JSON.parse(row.result) as JobResult;
  if (row.error !== null) job.error = row.error;
  return job;
}

export class JobStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly lock: DatabaseSync,
  ) {}

  /** 별도 SQLite의 배타 트랜잭션으로 중복 프로세스를 막고 종료 시 OS가 잠금을 해제한다. */
  static open(path: string): JobStore {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const lock = new DatabaseSync(`${absolute}.instance.sqlite`);
    try {
      lock.exec('BEGIN EXCLUSIVE');
      const db = new DatabaseSync(absolute);
      try {
        db.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            connector TEXT NOT NULL,
            full INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            result TEXT,
            error TEXT
          );
          CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, created_at);
        `);
        db.prepare(
          "UPDATE jobs SET status = 'interrupted', updated_at = ?, error = 'INTERRUPTED' WHERE status = 'running'",
        ).run(new Date().toISOString());
        return new JobStore(db, lock);
      } catch (error) {
        db.close();
        throw error;
      }
    } catch (error) {
      lock.close();
      throw error;
    }
  }

  enqueue(request: JobRequest): { job: Job; created: boolean; conflict: boolean } {
    const existing = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(request.idempotencyKey) as
      | Row
      | undefined;
    if (existing) {
      const conflict = existing.connector !== request.connector || Boolean(existing.full) !== Boolean(request.full);
      return { job: publicJob(existing), created: false, conflict };
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO jobs(id, idempotency_key, connector, full, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, 'queued', ?, ?)`)
      .run(id, request.idempotencyKey, request.connector, Number(Boolean(request.full)), now, now);
    return { job: this.get(id)!, created: true, conflict: false };
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? publicJob(row) : undefined;
  }

  next(): { id: string; connector: Connector; full: boolean } | undefined {
    const row = this.db
      .prepare("SELECT id, connector, full FROM jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1")
      .get() as Pick<Row, 'id' | 'connector' | 'full'> | undefined;
    return row && { id: row.id, connector: row.connector, full: Boolean(row.full) };
  }

  start(id: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(new Date().toISOString(), id);
  }

  finish(id: string, status: 'succeeded' | 'failed', result?: JobResult): void {
    this.db
      .prepare("UPDATE jobs SET status = ?, updated_at = ?, result = ?, error = ? WHERE id = ? AND status = 'running'")
      .run(
        status,
        new Date().toISOString(),
        result ? JSON.stringify(result) : null,
        status === 'failed' ? 'INGEST_FAILED' : null,
        id,
      );
  }

  interruptRunning(): void {
    this.db
      .prepare("UPDATE jobs SET status = 'interrupted', updated_at = ?, error = 'INTERRUPTED' WHERE status = 'running'")
      .run(new Date().toISOString());
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      try {
        this.lock.exec('ROLLBACK');
      } finally {
        this.lock.close();
      }
    }
  }
}
