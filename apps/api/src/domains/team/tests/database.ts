import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createDatabase } from '@api/db/client';

interface TestResult {
  success: boolean;
  results: Record<string, unknown>[];
  meta: { changes: number; last_row_id: number; duration: number };
}
interface TestStatement {
  bind(...parameters: SQLInputValue[]): TestStatement;
  all(): Promise<TestResult>;
  run(): Promise<TestResult>;
  raw(): Promise<unknown[][]>;
  execute(): TestResult;
}

export function teamDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE team_recruitment (id INTEGER PRIMARY KEY, title TEXT, status TEXT, deadline_date TEXT, updated_at TEXT);
    CREATE TABLE team_recruitment_application (id INTEGER PRIMARY KEY, recruitment_id INTEGER, applicant_id INTEGER, status TEXT, decision_reason TEXT, updated_at TEXT);
    CREATE TABLE team_recruitment_chat_room (id INTEGER PRIMARY KEY, recruitment_id INTEGER, room_scope_key TEXT, room_type TEXT);
    CREATE TABLE team_recruitment_notification (
      id INTEGER PRIMARY KEY, native_event_key TEXT UNIQUE, recipient_id INTEGER, type TEXT, target_type TEXT,
      message_preview TEXT, sender_nickname TEXT, recruitment_id INTEGER, application_id INTEGER, chat_room_id INTEGER,
      read_at TEXT, is_deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE team_recruitment_outbox_event (
      id INTEGER PRIMARY KEY, event_key TEXT UNIQUE, event_type TEXT, aggregate_type TEXT, aggregate_id INTEGER,
      payload TEXT, status TEXT, attempt_count INTEGER DEFAULT 0, next_attempt_at TEXT, locked_until TEXT,
      worker_id TEXT, published_at TEXT, last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  function prepared(query: string, values: SQLInputValue[] = []): TestStatement {
    const execute = () => {
      const statement = sqlite.prepare(query);
      const results = statement.columns().length ? statement.all(...values) : [];
      const mutation = statement.columns().length ? undefined : statement.run(...values);
      return { success: true, results, meta: { changes: Number(mutation?.changes ?? 0), last_row_id: Number(mutation?.lastInsertRowid ?? 0), duration: 0 } };
    };
    return { bind: (...parameters: SQLInputValue[]) => prepared(query, parameters), all: async () => execute(), run: async () => execute(),
      raw: async () => {
        const statement = sqlite.prepare(query);
        return statement.all(...values).map((row) => Object.values(row));
      }, execute };
  }
  const binding = {
    prepare: prepared,
    batch: async (statements: TestStatement[]) => {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, db: createDatabase(binding as unknown as D1Database) };
}
