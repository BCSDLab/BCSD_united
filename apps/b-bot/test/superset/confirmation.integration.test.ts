import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Postgres from '~/infra/postgres';

const database = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('~/infra/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof Postgres>();
  return { ...actual, getPool: () => database.pool! };
});
import {
  cancelDashboardConfirmation,
  claimDashboardConfirmation,
  expireDashboardConfirmation,
  finishDashboardConfirmation,
  loadDashboardConfirmation,
  saveDashboardConfirmation,
} from '~/services/superset/confirmation';

const connectionString = process.env.SUPERSET_TEST_DATABASE_URL;
const schema = `superset_test_${randomUUID().replaceAll('-', '')}`;
const plan = {
  title: '매출',
  charts: [
    { title: '합계', datasetId: 1, chartType: 'table' as const, columns: [], metrics: ['revenue'], groupby: [] },
  ],
};
const scope = ['U1', 'C1', '1'] as const;
const legacyToken = randomUUID();

describe.skipIf(!connectionString)('Superset PostgreSQL confirmation transitions', () => {
  beforeAll(async () => {
    database.pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    // Exercise upgrading the previous schema with an existing pending request.
    await database.pool.query(`CREATE TABLE superset_dashboard_confirmation (
      token UUID PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_ts TEXT NOT NULL,
      plan JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL)`);
    await database.pool.query(
      `INSERT INTO superset_dashboard_confirmation
      (token, user_id, channel_id, message_ts, plan, expires_at) VALUES ($1, 'U1', 'C1', '1', $2, NOW() + INTERVAL '15 minutes')`,
      [legacyToken, plan],
    );
    await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    await database.pool.query(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test audit failure'; END $$`);
  });
  afterAll(async () => {
    if (!database.pool) return;
    await database.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.pool.end();
  });

  it('migrates a pending request and recovers its completed result after expiry', async () => {
    expect(await claimDashboardConfirmation(legacyToken, ...scope)).toEqual(plan);
    await finishDashboardConfirmation(legacyToken, scope[0], true, 'https://superset.test/superset/dashboard/1/');
    await database.pool!.query(
      "UPDATE superset_dashboard_confirmation SET expires_at=NOW()-INTERVAL '1 hour' WHERE token=$1",
      [legacyToken],
    );
    expect(await loadDashboardConfirmation(legacyToken, ...scope)).toMatchObject({
      status: 'succeeded',
      resultUrl: 'https://superset.test/superset/dashboard/1/',
    });
    expect(await loadDashboardConfirmation(legacyToken, 'U2', scope[1], scope[2])).toBeNull();
    expect(await loadDashboardConfirmation(legacyToken, scope[0], 'C2', scope[2])).toBeNull();
    expect(await loadDashboardConfirmation(legacyToken, scope[0], scope[1], '2')).toBeNull();
    expect(await claimDashboardConfirmation(legacyToken, ...scope)).toBeNull();
  });

  it('rolls back an audit failure so the requester can claim again', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    await database.pool!.query(
      'CREATE TRIGGER reject_audit BEFORE INSERT ON superset_audit FOR EACH ROW EXECUTE FUNCTION reject_audit()',
    );
    try {
      await expect(claimDashboardConfirmation(token, ...scope)).rejects.toThrow('test audit failure');
    } finally {
      await database.pool!.query('DROP TRIGGER reject_audit ON superset_audit');
    }
    expect(await loadDashboardConfirmation(token, ...scope)).toMatchObject({ status: 'pending' });
    expect(await claimDashboardConfirmation(token, ...scope)).toEqual(plan);
    const result = await database.pool!.query(
      "SELECT outcome FROM superset_audit WHERE token=$1 AND action='dashboard_confirm'",
      [token],
    );
    expect(result.rows).toEqual([{ outcome: 'claimed' }]);
  });

  it('concurrent confirmations perform exactly one state transition', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    const results = await Promise.all([
      claimDashboardConfirmation(token, ...scope),
      claimDashboardConfirmation(token, ...scope),
    ]);
    expect(results.filter((value) => value !== null)).toEqual([plan]);
    expect(await cancelDashboardConfirmation(token, ...scope)).toBe(false);
  });

  it('rolls back cancellation but keeps a created URL when audit writes fail', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    await database.pool!.query(
      'CREATE TRIGGER reject_audit BEFORE INSERT ON superset_audit FOR EACH ROW EXECUTE FUNCTION reject_audit()',
    );
    try {
      await expect(cancelDashboardConfirmation(token, ...scope)).rejects.toThrow('test audit failure');
    } finally {
      await database.pool!.query('DROP TRIGGER reject_audit ON superset_audit');
    }
    expect(await claimDashboardConfirmation(token, ...scope)).toEqual(plan);
    await database.pool!.query(
      'CREATE TRIGGER reject_audit BEFORE INSERT ON superset_audit FOR EACH ROW EXECUTE FUNCTION reject_audit()',
    );
    try {
      await expect(
        finishDashboardConfirmation(token, scope[0], true, 'https://superset.test/superset/dashboard/2/'),
      ).rejects.toThrow('test audit failure');
    } finally {
      await database.pool!.query('DROP TRIGGER reject_audit ON superset_audit');
    }
    expect(await loadDashboardConfirmation(token, ...scope)).toMatchObject({
      status: 'claimed',
      resultUrl: 'https://superset.test/superset/dashboard/2/',
    });
    await finishDashboardConfirmation(token, scope[0], true, 'https://superset.test/superset/dashboard/2/');
    expect(await loadDashboardConfirmation(token, ...scope)).toMatchObject({
      status: 'succeeded',
      resultUrl: 'https://superset.test/superset/dashboard/2/',
    });
  });

  it('keeps a recorded URL usable after a process loses the finish step', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    expect(await claimDashboardConfirmation(token, ...scope)).toEqual(plan);
    const url = 'https://superset.test/superset/dashboard/6/';
    await database.pool!.query(
      'CREATE TRIGGER reject_audit BEFORE INSERT ON superset_audit FOR EACH ROW EXECUTE FUNCTION reject_audit()',
    );
    try {
      // The simulated crash leaves the URL recorded but the status unsettled.
      await expect(finishDashboardConfirmation(token, scope[0], true, url)).rejects.toThrow('test audit failure');
    } finally {
      await database.pool!.query('DROP TRIGGER reject_audit ON superset_audit');
    }
    expect(await loadDashboardConfirmation(token, ...scope)).toMatchObject({ status: 'claimed', resultUrl: url });
    expect(await loadDashboardConfirmation(token, 'U2', scope[1], scope[2])).toBeNull();
    expect(await loadDashboardConfirmation(token, scope[0], 'C2', scope[2])).toBeNull();
    expect(await loadDashboardConfirmation(token, scope[0], scope[1], '2')).toBeNull();
    expect(await claimDashboardConfirmation(token, ...scope)).toBeNull();
    expect(await expireDashboardConfirmation(token, scope[0])).toBe(false);
    await finishDashboardConfirmation(token, scope[0], true, url);
    expect(await loadDashboardConfirmation(token, ...scope)).toMatchObject({ status: 'succeeded', resultUrl: url });
  });

  it('never lets a second result overwrite the first recorded URL', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    expect(await claimDashboardConfirmation(token, ...scope)).toEqual(plan);
    const first = 'https://superset.test/superset/dashboard/7/';
    const second = 'https://superset.test/superset/dashboard/8/';
    await database.pool!.query(
      'CREATE TRIGGER reject_audit BEFORE INSERT ON superset_audit FOR EACH ROW EXECUTE FUNCTION reject_audit()',
    );
    try {
      await expect(finishDashboardConfirmation(token, scope[0], true, first)).rejects.toThrow('test audit failure');
    } finally {
      await database.pool!.query('DROP TRIGGER reject_audit ON superset_audit');
    }
    await finishDashboardConfirmation(token, scope[0], true, second);
    expect(await loadDashboardConfirmation(token, ...scope)).toMatchObject({ status: 'succeeded', resultUrl: first });
  });

  it('expires an abandoned claim without executing it again', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    expect(await claimDashboardConfirmation(token, ...scope)).toEqual(plan);
    await database.pool!.query(
      "UPDATE superset_dashboard_confirmation SET expires_at = NOW() - INTERVAL '1 second' WHERE token = $1",
      [token],
    );
    expect(await expireDashboardConfirmation(token, scope[0])).toBe(true);
    const status = await database.pool!.query(
      'SELECT status, result_url FROM superset_dashboard_confirmation WHERE token = $1',
      [token],
    );
    expect(status.rows).toEqual([{ status: 'failed', result_url: null }]);
    expect(await expireDashboardConfirmation(token, scope[0])).toBe(false);
    expect(await claimDashboardConfirmation(token, ...scope)).toBeNull();
    const auditRows = await database.pool!.query(
      "SELECT outcome FROM superset_audit WHERE token = $1 AND action = 'dashboard_create'",
      [token],
    );
    expect(auditRows.rows).toEqual([{ outcome: 'expired' }]);
  });

  it('does not erase a recorded URL when a failure is recorded afterwards', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    expect(await claimDashboardConfirmation(token, ...scope)).toEqual(plan);
    const url = 'https://superset.test/superset/dashboard/9/';
    await finishDashboardConfirmation(token, scope[0], true, url);
    await database.pool!.query("UPDATE superset_dashboard_confirmation SET status = 'claimed' WHERE token = $1", [
      token,
    ]);
    await finishDashboardConfirmation(token, scope[0], false);
    const status = await database.pool!.query(
      'SELECT status, result_url FROM superset_dashboard_confirmation WHERE token = $1',
      [token],
    );
    expect(status.rows).toEqual([{ status: 'failed', result_url: url }]);
  });

  it('grants the full execution deadline when claiming a near-expiry request', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    await database.pool!.query(
      "UPDATE superset_dashboard_confirmation SET expires_at = NOW() + INTERVAL '5 seconds' WHERE token = $1",
      [token],
    );
    expect(await claimDashboardConfirmation(token, ...scope)).toEqual(plan);
    const result = await database.pool!.query(
      "SELECT expires_at > NOW() + INTERVAL '14 minutes' AS extended FROM superset_dashboard_confirmation WHERE token = $1",
      [token],
    );
    expect(result.rows).toEqual([{ extended: true }]);
  });

  it('requires a non-blank result URL for a successful finish', async () => {
    const token = await saveDashboardConfirmation({ userId: scope[0], channelId: scope[1], messageTs: scope[2], plan });
    await expect(finishDashboardConfirmation(token, scope[0], true, '')).rejects.toThrow('requires a result URL');
    await expect(finishDashboardConfirmation(token, scope[0], true, '   ')).rejects.toThrow('requires a result URL');
    await expect(finishDashboardConfirmation(token, scope[0], true)).rejects.toThrow('requires a result URL');
  });
});
