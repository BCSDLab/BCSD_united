import { z } from 'zod';
import { sourceRows } from '@api/source-sync/contract';

/** bridge `/dinings` 행이자 KV 스냅샷 행. KV의 likes는 Durable Object 좋아요 수다. */
export const diningRows = sourceRows.dining
  .extend({
    id: z.number().int().nonnegative(),
    date: sourceRows.dining.shape.date.refine(
      (value) =>
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    ),
    type: z.enum(['BREAKFAST', 'LUNCH', 'DINNER']),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    sold_out: z.string().nullable(),
    likes: z.number().int().nonnegative().nullable(),
  })
  .array();
export type DiningRow = z.infer<typeof diningRows>[number];
export interface LikePair {
  dining_id: number;
  user_id: number;
}

/**
 * 품절·사진 소유권 전환 뒤 coop Durable Object가 내려 주는 식단별 값. version이 큰 값만 반영한다.
 * touched_at은 coop 변경 시각(UTC, Java BaseEntity updated_at과 같은 형식)이다.
 */
export type OwnedEntry = {
  id: number;
  sold_out: string | null;
  image_url: string | null;
  touched_at: string | null;
  version: number;
};

// 학교 배치 스냅샷(school:*)과 같은 BATCH_KV에 식단 스냅샷(koin:dining:*)을 둔다.
export const diningCacheKey = (date: string) => `koin:dining:v1:${date}`;
export const DINING_CACHE_TTL_SECONDS = 14 * 86_400;

export type LikeResult = 'OK' | 'NOT_READY' | 'DUPLICATE_LIKE' | 'LIKE_NOT_FOUND' | 'MENU_NOT_FOUND';
export interface DiningView {
  /** 마지막 bridge 동기화 시각(ms). null이면 아직 적재하지 않은 날짜다. */
  syncedAt: number | null;
  /** bridge 좋아요 최초 가져오기 완료 여부. 완료 전에는 개수를 신뢰하지 않는다. */
  imported: boolean;
  rows: DiningRow[];
  liked: number[];
}

type Sql = Pick<SqlStorage, 'exec'>;
type Transaction = <T>(operation: () => T) => T;

const schema = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS dinings (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, row TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS likes (dining_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (dining_id, user_id)) WITHOUT ROWID',
  // 식단 ID → KST 날짜 색인. 이름이 "index"인 인스턴스만 사용한다.
  'CREATE TABLE IF NOT EXISTS dining_index (id INTEGER PRIMARY KEY, date TEXT NOT NULL)',
  // coop 소유 품절·사진 값. meta owned=1일 때만 MySQL 값 대신 쓴다(행이 없으면 MySQL 값).
  'CREATE TABLE IF NOT EXISTS owned (id INTEGER PRIMARY KEY, sold_out TEXT, image_url TEXT, touched_at TEXT, version INTEGER NOT NULL)',
];

/**
 * 날짜별 Durable Object의 SQLite 상태. 메서드는 await 없이 동기 실행되므로 DO 안에서 원자적이다.
 * 식단 행은 MySQL 원본(bridge) 그대로, 좋아요는 이 저장소가 원본이다.
 */
export class DiningStore {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction,
  ) {
    for (const statement of schema) sql.exec(statement);
  }

  private meta(key: string): string | null {
    const [row] = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray();
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
  }

  private hasLike(userId: number, diningId: number): boolean {
    return (
      this.sql.exec('SELECT 1 FROM likes WHERE dining_id = ? AND user_id = ?', diningId, userId).toArray().length > 0
    );
  }

  private hasDining(diningId: number): boolean {
    return this.sql.exec('SELECT 1 FROM dinings WHERE id = ?', diningId).toArray().length > 0;
  }

  view(userId: number | null): DiningView {
    const syncedAt = this.meta('synced_at');
    const owned = this.meta('owned') === '1';
    const rows = this.sql
      .exec<{
        row: string;
        likes: number;
        sold_out: string | null;
        image_url: string | null;
        touched_at: string | null;
        version: number | null;
      }>(
        `SELECT d.row, (SELECT COUNT(*) FROM likes l WHERE l.dining_id = d.id) AS likes,
                o.sold_out, o.image_url, o.touched_at, o.version
           FROM dinings d LEFT JOIN owned o ON o.id = d.id ORDER BY d.position`,
      )
      .toArray()
      .map(({ row, likes, ...override }) => {
        const fields = JSON.parse(row) as Omit<DiningRow, 'likes'>;
        if (owned && override.version !== null) {
          fields.sold_out = override.sold_out;
          fields.image_url = override.image_url;
          // Java는 품절·사진 변경 때 updated_at도 갱신한다. MySQL 쪽 변경이 더 늦으면 그 값을 쓴다.
          if (override.touched_at !== null && (fields.updated_at === null || override.touched_at > fields.updated_at)) {
            fields.updated_at = override.touched_at;
          }
        }
        return { ...fields, likes: Number(likes) };
      });
    const liked =
      userId === null
        ? []
        : this.sql
            .exec<{ dining_id: number }>(
              'SELECT l.dining_id FROM likes l JOIN dinings d ON d.id = l.dining_id WHERE l.user_id = ?',
              userId,
            )
            .toArray()
            .map((row) => Number(row.dining_id));
    return {
      syncedAt: syncedAt === null ? null : Number(syncedAt),
      imported: this.meta('likes_imported') === '1',
      rows,
      liked,
    };
  }

  /** bridge 행으로 식단 집합을 맞춘다(likes 제외). 사라진 식단의 좋아요는 남겨 둔다(MySQL과 같은 고아 행). */
  sync(date: string, rows: DiningRow[], now: number): { changed: boolean; imported: boolean } {
    return this.transaction(() => {
      const current = this.meta('date');
      if (current !== null && current !== date) throw new Error('Dining object date mismatch');
      const existing = new Map(
        this.sql
          .exec<{ id: number; position: number; row: string }>('SELECT id, position, row FROM dinings')
          .toArray()
          .map((row) => [Number(row.id), row]),
      );
      let changed = false;
      rows.forEach(({ likes: _likes, ...fields }, position) => {
        const row = JSON.stringify(fields);
        const previous = existing.get(fields.id);
        existing.delete(fields.id);
        if (previous && previous.row === row && Number(previous.position) === position) return;
        this.sql.exec('INSERT OR REPLACE INTO dinings (id, position, row) VALUES (?, ?, ?)', fields.id, position, row);
        changed = true;
      });
      for (const id of existing.keys()) {
        this.sql.exec('DELETE FROM dinings WHERE id = ?', id);
        changed = true;
      }
      this.setMeta('date', date);
      this.setMeta('synced_at', String(now));
      return { changed, imported: this.meta('likes_imported') === '1' };
    });
  }

  /** MySQL dining_likes 가져오기. insert-or-ignore라 반복해도 같은 결과다. */
  importLikes(pairs: LikePair[]): { inserted: number } {
    return this.transaction(() => {
      let inserted = 0;
      for (const pair of pairs) {
        inserted += this.sql
          .exec(
            'INSERT OR IGNORE INTO likes (dining_id, user_id) VALUES (?, ?) RETURNING 1',
            pair.dining_id,
            pair.user_id,
          )
          .toArray().length;
      }
      this.setMeta('likes_imported', '1');
      return { inserted };
    });
  }

  /** Java DiningService.likeDining 순서: 중복 좋아요 → 식단 존재 → 저장. */
  like(userId: number, diningId: number): LikeResult {
    return this.transaction(() => {
      if (this.meta('likes_imported') !== '1') return 'NOT_READY';
      if (this.hasLike(userId, diningId)) return 'DUPLICATE_LIKE';
      if (!this.hasDining(diningId)) return 'MENU_NOT_FOUND';
      this.sql.exec('INSERT INTO likes (dining_id, user_id) VALUES (?, ?)', diningId, userId);
      return 'OK';
    });
  }

  /** Java DiningService.likeDiningCancel 순서: 좋아요 존재 → 식단 존재 → 삭제. */
  cancel(userId: number, diningId: number): LikeResult {
    return this.transaction(() => {
      if (this.meta('likes_imported') !== '1') return 'NOT_READY';
      if (!this.hasLike(userId, diningId)) return 'LIKE_NOT_FOUND';
      if (!this.hasDining(diningId)) return 'MENU_NOT_FOUND';
      this.sql.exec('DELETE FROM likes WHERE dining_id = ? AND user_id = ?', diningId, userId);
      return 'OK';
    });
  }

  /**
   * coop 소유 값을 반영한다. null이면 소유권 전환 전(또는 되돌림)이므로 MySQL 값을 쓴다.
   * 늦게 도착한 이전 버전은 무시한다.
   */
  applyOwned(entries: OwnedEntry[] | null): void {
    this.transaction(() => {
      if (entries === null) {
        this.setMeta('owned', null);
        return;
      }
      for (const entry of entries) {
        this.sql.exec(
          `INSERT INTO owned (id, sold_out, image_url, touched_at, version) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET sold_out = excluded.sold_out, image_url = excluded.image_url,
               touched_at = excluded.touched_at, version = excluded.version
             WHERE excluded.version > owned.version`,
          entry.id,
          entry.sold_out,
          entry.image_url,
          entry.touched_at,
          entry.version,
        );
      }
      this.setMeta('owned', '1');
    });
  }

  /** 날짜 DO가 가진 식단의 고정 정보(id·date·type·place). */
  diningMeta(id: number): Pick<DiningRow, 'id' | 'date' | 'type' | 'place'> | null {
    const [found] = this.sql.exec<{ row: string }>('SELECT row FROM dinings WHERE id = ?', id).toArray();
    if (!found) return null;
    const { date, type, place } = JSON.parse(found.row) as DiningRow;
    return { id, date, type, place };
  }

  /** 아직 KV에 쓰지 않은 스냅샷. 적재·좋아요 가져오기 전에는 0개 좋아요를 공개하지 않도록 null이다. */
  pendingSnapshot(): { date: string; value: string } | null {
    const date = this.meta('date');
    const view = this.view(null);
    if (date === null || view.syncedAt === null || !view.imported) return null;
    const value = JSON.stringify(view.rows);
    return value === this.meta('kv_value') ? null : { date, value };
  }

  markPublished(value: string | null): void {
    this.setMeta('kv_value', value);
  }

  remember(date: string, ids: number[]): void {
    this.transaction(() => {
      for (const id of ids) this.sql.exec('INSERT OR REPLACE INTO dining_index (id, date) VALUES (?, ?)', id, date);
    });
  }

  locate(id: number): string | null {
    const [row] = this.sql.exec<{ date: string }>('SELECT date FROM dining_index WHERE id = ?', id).toArray();
    return row?.date ?? null;
  }

  locateMany(ids: number[]): Record<number, string> {
    const found: Record<number, string> = {};
    for (const id of ids) {
      const date = this.locate(id);
      if (date !== null) found[id] = date;
    }
    return found;
  }
}
