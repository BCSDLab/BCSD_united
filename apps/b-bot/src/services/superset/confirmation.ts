import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensureOnce, getPool, query } from '~/infra/postgres';
import type { DashboardPlan } from '~/services/superset';

export interface DashboardConfirmation {
  token: string;
  userId: string;
  channelId: string;
  messageTs: string;
  plan: DashboardPlan;
  status: 'pending' | 'claimed' | 'cancelled' | 'succeeded' | 'failed';
  resultUrl: string | null;
  expiresAt: Date;
}

const ensureSchema = ensureOnce(async () => {
  await query(
    getPool(),
    `CREATE TABLE IF NOT EXISTS superset_dashboard_confirmation (
    token UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    plan JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'cancelled', 'succeeded', 'failed')),
    result_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  );
  await query(getPool(), 'ALTER TABLE superset_dashboard_confirmation ADD COLUMN IF NOT EXISTS result_url TEXT');
  await query(
    getPool(),
    `CREATE TABLE IF NOT EXISTS superset_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    token UUID,
    outcome TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  );
});

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function audit(
  client: PoolClient,
  actor: string,
  action: string,
  token: string | null,
  outcome: string,
): Promise<void> {
  await client.query('INSERT INTO superset_audit (actor, action, token, outcome) VALUES ($1, $2, $3, $4)', [
    actor,
    action,
    token,
    outcome,
  ]);
}

function rowToConfirmation(row: {
  token: string;
  user_id: string;
  channel_id: string;
  message_ts: string;
  plan: DashboardPlan;
  status: DashboardConfirmation['status'];
  result_url: string | null;
  expires_at: Date;
}): DashboardConfirmation {
  return {
    token: row.token,
    userId: row.user_id,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    plan: row.plan,
    status: row.status,
    resultUrl: row.result_url,
    expiresAt: row.expires_at,
  };
}

export async function saveDashboardConfirmation(
  input: Omit<DashboardConfirmation, 'token' | 'status' | 'resultUrl' | 'expiresAt'>,
): Promise<string> {
  await ensureSchema();
  const token = randomUUID();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO superset_dashboard_confirmation
      (token, user_id, channel_id, message_ts, plan, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + INTERVAL '15 minutes')`,
      [token, input.userId, input.channelId, input.messageTs, JSON.stringify(input.plan)],
    );
    await audit(client, input.userId, 'dashboard_plan', token, 'created');
  });
  return token;
}

export async function loadDashboardConfirmation(
  token: string,
  requesterId?: string,
  channelId?: string,
  messageTs?: string,
): Promise<DashboardConfirmation | null> {
  await ensureSchema();
  const result = await query(
    getPool(),
    `SELECT token, user_id, channel_id, message_ts, plan, status, result_url, expires_at
    FROM superset_dashboard_confirmation
    WHERE token = $1 AND ((status = 'pending' AND expires_at > NOW()) OR
      (status IN ('claimed', 'succeeded') AND user_id = $2 AND channel_id = $3 AND message_ts = $4))`,
    [token, requesterId ?? null, channelId ?? null, messageTs ?? null],
  );
  const row = result.rows[0];
  return row ? rowToConfirmation(row) : null;
}

export async function claimDashboardConfirmation(
  token: string,
  userId: string,
  channelId: string,
  messageTs: string,
): Promise<DashboardPlan | null> {
  await ensureSchema();
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE superset_dashboard_confirmation SET status = 'claimed', expires_at = NOW() + INTERVAL '15 minutes'
      WHERE token = $1 AND user_id = $2 AND channel_id = $3 AND message_ts = $4
        AND status = 'pending' AND expires_at > NOW() RETURNING plan`,
      [token, userId, channelId, messageTs],
    );
    if (!result.rows[0]) return null;
    await audit(client, userId, 'dashboard_confirm', token, 'claimed');
    return result.rows[0].plan;
  });
}

export async function finishDashboardConfirmation(
  token: string,
  userId: string,
  succeeded: boolean,
  resultUrl: string | null = null,
): Promise<void> {
  if (succeeded && !resultUrl?.trim()) throw new Error('A successful dashboard confirmation requires a result URL');
  await ensureSchema();
  if (succeeded) {
    // Record the URL in its own durable statement before the state+audit transaction:
    // losing the audit write must never lose the created dashboard. The first saved URL wins.
    await query(
      getPool(),
      `UPDATE superset_dashboard_confirmation SET result_url = $3
      WHERE token = $1 AND user_id = $2 AND status IN ('claimed', 'succeeded') AND result_url IS NULL`,
      [token, userId, resultUrl],
    );
  }
  const status = succeeded ? 'succeeded' : 'failed';
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE superset_dashboard_confirmation
      SET status = $2, result_url = COALESCE(result_url, $3)
      WHERE token = $1 AND user_id = $4 AND status = 'claimed' RETURNING token`,
      [token, status, succeeded ? resultUrl : null, userId],
    );
    if (result.rows.length) await audit(client, userId, 'dashboard_create', token, status);
  });
}

export async function expireDashboardConfirmation(token: string, userId: string): Promise<boolean> {
  await ensureSchema();
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE superset_dashboard_confirmation SET status = 'failed'
      WHERE token = $1 AND user_id = $2 AND status = 'claimed' AND result_url IS NULL
        AND expires_at <= NOW() RETURNING token`,
      [token, userId],
    );
    if (!result.rows.length) return false;
    await audit(client, userId, 'dashboard_create', token, 'expired');
    return true;
  });
}

export async function cancelDashboardConfirmation(
  token: string,
  userId: string,
  channelId: string,
  messageTs: string,
): Promise<boolean> {
  await ensureSchema();
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE superset_dashboard_confirmation SET status = 'cancelled'
      WHERE token = $1 AND user_id = $2 AND channel_id = $3 AND message_ts = $4
        AND status = 'pending' AND expires_at > NOW() RETURNING token`,
      [token, userId, channelId, messageTs],
    );
    if (result.rows.length) await audit(client, userId, 'dashboard_cancel', token, 'cancelled');
    return result.rows.length > 0;
  });
}

export async function recordDashboardAudit(
  actor: string,
  action: string,
  outcome: string,
  token: string | null = null,
): Promise<void> {
  await ensureSchema();
  await transaction((client) => audit(client, actor, action, token, outcome));
}
