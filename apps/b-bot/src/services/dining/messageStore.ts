import { ensureOnce, getPool, query } from '~/infra/postgres';
import type { KoinEnv } from '~/services/koin/target';

export interface DiningReportMessage {
  env: KoinEnv;
  report_id: number;
  channel_id: string;
  message_ts: string;
  last_delivery_id: string;
  created_at: string;
  updated_at: string;
}

export const ensureDiningMessageSchema = ensureOnce(async () => {
  await query(
    getPool(),
    `CREATE TABLE IF NOT EXISTS dining_report_message (
       env              TEXT NOT NULL,
       report_id        INTEGER NOT NULL,
       channel_id       TEXT NOT NULL,
       message_ts       TEXT NOT NULL,
       last_delivery_id TEXT NOT NULL,
       created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (env, report_id)
     )`,
  );
});

export async function findMessage(env: KoinEnv, reportId: number): Promise<DiningReportMessage | undefined> {
  await ensureDiningMessageSchema();
  const result = await query(getPool(), `SELECT * FROM dining_report_message WHERE env = $1 AND report_id = $2`, [
    env,
    reportId,
  ]);
  return result.rows[0];
}

export async function saveMessage(
  env: KoinEnv,
  reportId: number,
  message: { channelId: string; messageTs: string },
  deliveryId: string,
): Promise<boolean> {
  await ensureDiningMessageSchema();
  const result = await query(
    getPool(),
    `INSERT INTO dining_report_message (env, report_id, channel_id, message_ts, last_delivery_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (env, report_id) DO NOTHING
     RETURNING report_id`,
    [env, reportId, message.channelId, message.messageTs, deliveryId],
  );
  return result.rows.length > 0;
}

export async function replaceMessage(
  env: KoinEnv,
  reportId: number,
  message: { channelId: string; messageTs: string },
  deliveryId: string,
): Promise<void> {
  await ensureDiningMessageSchema();
  await query(
    getPool(),
    `UPDATE dining_report_message
        SET channel_id = $3, message_ts = $4, last_delivery_id = $5, updated_at = now()
      WHERE env = $1 AND report_id = $2`,
    [env, reportId, message.channelId, message.messageTs, deliveryId],
  );
}

export async function markDelivered(env: KoinEnv, reportId: number, deliveryId: string): Promise<void> {
  await ensureDiningMessageSchema();
  await query(
    getPool(),
    `UPDATE dining_report_message
        SET last_delivery_id = $3, updated_at = now()
      WHERE env = $1 AND report_id = $2`,
    [env, reportId, deliveryId],
  );
}
