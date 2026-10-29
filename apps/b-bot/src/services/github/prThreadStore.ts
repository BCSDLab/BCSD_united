import type { Pool } from 'pg';
import { query } from '~/infra/postgres';

export async function getPRThreadTs(pool: Pool, pullRequestLink: string): Promise<string | null> {
  const result = await query(pool, `SELECT ts FROM pr_thread WHERE pr_link = $1 ORDER BY id DESC LIMIT 1`, [
    pullRequestLink,
  ]);
  return result.rows[0]?.ts ?? null;
}

export interface PRThread {
  ts: string;
  reviewers: string[];
  writer: string | null;
  merged: boolean;
}

/**
 * 리뷰어 지정 때 남긴 스레드. 리뷰어마다 한 행씩 같은 ts로 저장돼 있다.
 * 머지 알림은 링크만 받으므로 리뷰어·작성자는 여기서 꺼낸다.
 */
export async function getPRThread(pool: Pool, pullRequestLink: string): Promise<PRThread | null> {
  const result = await query(
    pool,
    `SELECT ts, reviewer, writer, status FROM pr_thread WHERE pr_link = $1 ORDER BY id DESC`,
    [pullRequestLink],
  );
  const rows: { ts: string | null; reviewer: string | null; writer: string | null; status: string | null }[] =
    result.rows;
  const ts = rows[0]?.ts;
  if (!ts) {
    return null;
  }
  const sameThread = rows.filter((row) => row.ts === ts);
  return {
    ts,
    reviewers: sameThread.map((row) => row.reviewer).filter((reviewer): reviewer is string => Boolean(reviewer)),
    writer: sameThread[0].writer,
    merged: sameThread.some((row) => row.status === 'merged'),
  };
}

export async function markPRThreadMerged(pool: Pool, pullRequestLink: string) {
  await query(pool, `UPDATE pr_thread SET status = 'merged' WHERE pr_link = $1`, [pullRequestLink]);
}

interface SavePRThreadParams {
  pool: Pool;
  pullRequestLink: string;
  reviewers: string[];
  writer: string;
  ts: string;
}

export async function savePRThread({ pool, pullRequestLink, reviewers, writer, ts }: SavePRThreadParams) {
  await Promise.all(
    reviewers.map((reviewer) =>
      query(pool, `INSERT INTO pr_thread (pr_link, ts, reviewer, writer) VALUES ($1, $2, $3, $4)`, [
        pullRequestLink,
        ts,
        reviewer,
        writer,
      ]),
    ),
  );
}
