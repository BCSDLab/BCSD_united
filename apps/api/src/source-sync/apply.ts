import { ngrams } from '@api/domains/community/search';
import { canonicalKey, rowKey, type Dataset, type Delta, type Key } from './contract';

export interface Statement {
  sql: string;
  args: (string | number | null)[];
}
type Row = Record<string, unknown>;
const statement = (sql: string, ...args: Statement['args']): Statement => ({ sql, args });
const lectureFields = [
  'semester_date',
  'code',
  'name',
  'grades',
  'class',
  'regular_number',
  'department',
  'target',
  'professor',
  'is_english',
  'design_score',
  'is_elearning',
  'class_time',
] as const;
const articleFields = ['title', 'content', 'is_notice', 'is_deleted'] as const;
const portalFields = ['author', 'portal_hit', 'url', 'registered_at', 'is_deleted'] as const;
const diningFields = ['price_card', 'price_cash', 'kcal', 'menu', 'is_changed', 'image_url'] as const;
const attachmentFields = ['url', 'name', 'is_deleted'] as const;
const versionFields = ['version', 'title', 'is_previous', 'content'] as const;
function fields(row: Row, names: readonly string[]): Statement['args'] {
  return names.map((name) => row[name] as string | number | null);
}
function setDifferent(table: string, id: number, old: Row, row: Row, names: readonly string[]): Statement[] {
  const changed = names.filter((name) => old[name] !== row[name]);
  return changed.length
    ? [
        statement(
          `UPDATE ${table} SET ${changed.map((name) => `"${name}"=?`).join(',')} WHERE id=?`,
          ...fields(row, changed),
          id,
        ),
      ]
    : [];
}
async function all(db: D1Database, sql: string, ...args: Statement['args']): Promise<Row[]> {
  const result = await db
    .prepare(sql)
    .bind(...args)
    .all<Row>();
  return result.results;
}
async function articleIdentity(db: D1Database, key: Key): Promise<{ id: number; needsIdentity: boolean } | undefined> {
  const tracked = await all(
    db,
    'SELECT article_id id FROM native_source_article_identity WHERE board_id=? AND portal_num=?',
    ...key,
  );
  if (tracked.length) return { id: tracked[0]!.id as number, needsIdentity: false };
  const legacy = await all(
    db,
    `SELECT a.id FROM new_koreatech_articles k JOIN new_articles a ON a.id=k.article_id
    WHERE k.portal_num=? AND a.board_id=? LIMIT 2`,
    key[1]!,
    key[0]!,
  );
  if (legacy.length > 1) throw new Conflict('AMBIGUOUS_ARTICLE');
  return legacy.length ? { id: legacy[0]!.id as number, needsIdentity: true } : undefined;
}
export async function readKey(db: D1Database, dataset: Dataset, key: Key): Promise<Row[]> {
  switch (dataset) {
    case 'dining':
      return all(
        db,
        `SELECT date,type,place,price_card,price_cash,kcal,menu,is_changed,image_url FROM dining_menus WHERE date=? AND type=? COLLATE NOCASE AND place=? COLLATE NOCASE`,
        ...key,
      );
    case 'semesters':
      return all(db, 'SELECT semester,year,term FROM semester WHERE semester=?', ...key);
    case 'lectures':
      return all(
        db,
        `SELECT ${lectureFields.map((field) => `"${field}"`).join(',')} FROM lectures WHERE semester_date=? COLLATE NOCASE AND code=? COLLATE NOCASE AND class=? COLLATE NOCASE ORDER BY id`,
        ...key,
      );
    case 'versions':
      return (
        await all(
          db,
          `SELECT version,type,title,is_previous,content FROM versions WHERE type='timetable' COLLATE NOCASE ORDER BY id LIMIT 1001`,
        )
      ).map((row) => ({ ...row, type: 'timetable' }));
    case 'citybus':
      return (
        await all(db, 'SELECT id,bus_info,bus_timetables,updated_at FROM citybus_timetables WHERE id=?', ...key)
      ).map((row) => ({
        ...row,
        bus_info: JSON.parse(row.bus_info as string),
        bus_timetables: JSON.parse(row.bus_timetables as string),
      }));
    case 'weather':
      return (
        await all(db, 'SELECT id,payload,expires_at,updated_at FROM native_transport_cache WHERE id=?', ...key)
      ).map((row) => ({ ...row, payload: JSON.parse(row.payload as string) }));
    case 'articles': {
      const identity = await articleIdentity(db, key);
      if (!identity) return [];
      const tombstone = await all(
        db,
        'SELECT 1 FROM native_source_sync_tombstone WHERE board_id=? AND portal_num=?',
        ...key,
      );
      if (tombstone.length) return [];
      const rows = await all(
        db,
        `SELECT a.id,a.board_id,k.portal_num,a.title,a.content,a.is_notice,a.is_deleted,
        k.author,k.portal_hit,k.url,k.registered_at FROM new_articles a
        JOIN new_koreatech_articles k ON k.article_id=a.id WHERE a.id=?`,
        identity.id,
      );
      if (rows.length !== 1) throw new Conflict('ARTICLE_IDENTITY_MISSING');
      if (rows[0]!.board_id !== key[0] || rows[0]!.portal_num !== key[1])
        throw new Conflict('ARTICLE_IDENTITY_MISMATCH');
      const attachments = await all(
        db,
        'SELECT lower(hex(hash)) hash,url,name,is_deleted FROM article_attachments WHERE article_id=? ORDER BY hash LIMIT 1001',
        identity.id,
      );
      if (attachments.length > 1000) throw new Conflict('ATTACHMENTS_TOO_LARGE');
      const { id: _id, ...row } = rows[0]!;
      return [{ ...row, attachments }];
    }
  }
}
/** Read up to 100 requested keys in one indexed SQLite query, not one D1 round-trip per key. */
export async function readBaseline(db: D1Database, dataset: Dataset, keys: Key[]): Promise<Row[]> {
  if (dataset === 'versions') {
    const rows = await readKey(db, dataset, keys[0]!);
    if (rows.length > 1000) throw new BaselineTooLarge();
    return rows;
  }
  const requested = 'FROM json_each(?) r';
  const part = (index: number) => `json_extract(r.value,'$[${index}]')`;
  let query: string;
  switch (dataset) {
    case 'dining':
      query = `SELECT t.date,t.type,t.place,t.price_card,t.price_cash,t.kcal,t.menu,t.is_changed,t.image_url
        ${requested} CROSS JOIN dining_menus t WHERE t.date=${part(0)}
        AND t.type=${part(1)} COLLATE NOCASE AND t.place=${part(2)} COLLATE NOCASE`;
      break;
    case 'semesters':
      query = `SELECT t.semester,t.year,t.term ${requested} CROSS JOIN semester t WHERE t.semester=${part(0)}`;
      break;
    case 'lectures':
      query = `SELECT ${lectureFields.map((field) => `t."${field}"`).join(',')}
        ${requested} CROSS JOIN lectures t WHERE t.semester_date=${part(0)} COLLATE NOCASE
        AND t.code=${part(1)} COLLATE NOCASE AND t.class=${part(2)} COLLATE NOCASE LIMIT 5001`;
      break;
    case 'citybus':
      query = `SELECT t.id,t.bus_info,t.bus_timetables,t.updated_at
        ${requested} CROSS JOIN citybus_timetables t WHERE t.id=${part(0)}`;
      break;
    case 'weather':
      query = `SELECT t.id,t.payload,t.expires_at,t.updated_at
        ${requested} CROSS JOIN native_transport_cache t WHERE t.id=${part(0)}`;
      break;
    case 'articles':
      query = `SELECT a.board_id,k.portal_num,a.title,a.content,a.is_notice,a.is_deleted,
        k.author,k.portal_hit,k.url,k.registered_at,
        (SELECT json_group_array(json_object('hash',lower(hex(x.hash)),'url',x.url,
          'name',x.name,'is_deleted',x.is_deleted)) FROM article_attachments x
          WHERE x.article_id=a.id) attachments
        ${requested} CROSS JOIN new_koreatech_articles k INDEXED BY native_source_sync_portal_key
        JOIN new_articles a ON a.id=k.article_id
        WHERE k.portal_num=${part(1)} AND a.board_id=${part(0)}
        AND NOT EXISTS(SELECT 1 FROM native_source_sync_tombstone t
          WHERE t.board_id=a.board_id AND t.portal_num=k.portal_num) LIMIT 101`;
      break;
  }
  const rows = await all(db, query, JSON.stringify(keys));
  if (dataset === 'lectures' && rows.length > 5000) throw new BaselineTooLarge();
  if (dataset === 'articles') {
    const found = new Set<string>();
    for (const row of rows) {
      const key = canonicalKey(dataset, rowKey(dataset, row));
      if (found.has(key)) throw new Conflict('AMBIGUOUS_ARTICLE');
      found.add(key);
      row.attachments = JSON.parse(row.attachments as string);
    }
    if (rows.length > keys.length) throw new Conflict('AMBIGUOUS_ARTICLE');
  } else if (dataset === 'citybus')
    for (const row of rows) {
      row.bus_info = JSON.parse(row.bus_info as string);
      row.bus_timetables = JSON.parse(row.bus_timetables as string);
    }
  else if (dataset === 'weather') for (const row of rows) row.payload = JSON.parse(row.payload as string);
  return rows;
}
export class BaselineTooLarge extends Error {}
function simpleUpsert(
  table: string,
  keyFields: readonly string[],
  updateFields: readonly string[],
  row: Row,
  preserveImage = false,
): Statement {
  const names = [...keyFields, ...updateFields];
  const assigned = updateFields
    .map(
      (name) =>
        `"${name}"=${preserveImage && name === 'image_url' ? `COALESCE(excluded."${name}",${table}."${name}")` : `excluded."${name}"`}`,
    )
    .join(',');
  const distinct = updateFields
    .map(
      (name) =>
        `${table}."${name}" IS NOT ${preserveImage && name === 'image_url' ? `COALESCE(excluded."${name}",${table}."${name}")` : `excluded."${name}"`}`,
    )
    .join(' OR ');
  return statement(
    `INSERT INTO ${table}(${names.map((name) => `"${name}"`).join(',')}) VALUES(${names.map(() => '?').join(',')}) ON CONFLICT(${keyFields.map((name) => `"${name}"`).join(',')}) DO UPDATE SET ${assigned} WHERE ${distinct}`,
    ...fields(row, names),
  );
}
function articleStatements(row: Row, old: Row | undefined, id: number | undefined): Statement[] {
  const result: Statement[] = [];
  const board = row.board_id as number;
  const portal = row.portal_num as number;
  if (id === undefined) {
    result.push(
      statement(
        'INSERT INTO new_articles(board_id,title,content,is_notice,is_deleted) VALUES(?,?,?,?,?)',
        board,
        ...fields(row, articleFields),
      ),
    );
    result.push(
      statement(
        'INSERT INTO native_source_article_identity(board_id,portal_num,article_id) VALUES(?,?,(SELECT max(id) FROM new_articles))',
        board,
        portal,
      ),
    );
  } else if (old) result.push(...setDifferent('new_articles', id, old, row, articleFields));
  const articleId =
    id !== undefined
      ? '?'
      : '(SELECT article_id FROM native_source_article_identity WHERE board_id=? AND portal_num=?)';
  const identity = id !== undefined ? [id] : [board, portal];
  if (!old)
    result.push(
      statement(
        `INSERT INTO new_koreatech_articles(article_id,author,portal_num,portal_hit,url,registered_at,is_deleted) VALUES(${articleId},?,?,?,?,?,?)`,
        ...identity,
        row.author as string,
        portal,
        row.portal_hit as number,
        row.url as string,
        row.registered_at as string | null,
        row.is_deleted as number,
      ),
    );
  else if (id !== undefined)
    result.push(
      ...setDifferent('new_koreatech_articles', id, old, row, portalFields).map((entry) => ({
        ...entry,
        sql: entry.sql.replace('WHERE id=?', 'WHERE article_id=?'),
      })),
    );
  if (id === undefined && row.is_deleted === 0)
    result.push(
      statement(
        `INSERT OR IGNORE INTO native_community_outbox(id,kind,payload,created_at)
    SELECT 'source-article:'||article_id||':'||user_id,'community.push',
      json_object('userId',user_id,'title',title,'message','방금 등록된 '||keyword||' 공지를 확인해보세요!',
        'mobileAppPath','KEYWORD','schemeUri','keyword?id='||article_id||'&keyword='||keyword||'&board-id='||board_id,'type','MESSAGE'),
      unixepoch()*1000 FROM (
      SELECT a.id article_id,a.title,a.board_id,m.user_id,k.keyword,
        row_number() OVER(PARTITION BY a.id,m.user_id ORDER BY length(k.keyword) DESC,m.id ASC) ranking
      FROM new_articles a JOIN article_keywords k ON k.category='KOREATECH' AND instr(a.title,k.keyword)>0 AND k.is_deleted=0
      JOIN article_keyword_user_map m ON m.keyword_id=k.id AND m.is_deleted=0
      JOIN users u ON u.id=m.user_id AND u.is_deleted=0 AND u.device_token IS NOT NULL
      WHERE a.id=${articleId} AND EXISTS(SELECT 1 FROM notification_subscribe ns
        WHERE ns.user_id=u.id AND ns.subscribe_type='ARTICLE_KEYWORD' AND ns.detail_type IS NULL)
    ) WHERE ranking=1 RETURNING id,kind`,
        ...identity,
      ),
    );
  const oldAttachments = new Map(((old?.attachments ?? []) as Row[]).map((entry) => [entry.hash as string, entry]));
  const newAttachments = new Set<string>();
  for (const item of row.attachments as Row[]) {
    const hash = item.hash as string;
    newAttachments.add(hash);
    const existing = oldAttachments.get(hash);
    if (!existing)
      result.push(
        statement(
          `INSERT INTO article_attachments(article_id,hash,url,name,is_deleted) VALUES(${articleId},unhex(?),?,?,?)`,
          ...identity,
          hash,
          ...fields(item, attachmentFields),
        ),
      );
    else {
      const changed = attachmentFields.filter((name) => existing[name] !== item[name]);
      if (changed.length)
        result.push(
          statement(
            `UPDATE article_attachments SET ${changed.map((name) => `"${name}"=?`).join(',')} WHERE article_id=${articleId} AND hash=unhex(?)`,
            ...fields(item, changed),
            ...identity,
            hash,
          ),
        );
    }
  }
  for (const [hash] of oldAttachments) {
    if (!newAttachments.has(hash))
      result.push(
        statement(`DELETE FROM article_attachments WHERE article_id=${articleId} AND hash=unhex(?)`, ...identity, hash),
      );
  }
  if (!old || old.title !== row.title) {
    const grams = ngrams(row.title as string);
    const payload = JSON.stringify(grams);
    result.push(
      statement(
        `DELETE FROM native_article_ngram WHERE article_id=${articleId}
      AND NOT EXISTS (SELECT 1 FROM json_each(?) g WHERE json_extract(g.value,'$.position')=native_article_ngram.position)`,
        ...identity,
        payload,
      ),
    );
    result.push(
      statement(
        `INSERT INTO native_article_ngram(article_id,position,token)
      SELECT ${articleId},json_extract(g.value,'$.position'),json_extract(g.value,'$.token') FROM json_each(?) g WHERE true
      ON CONFLICT(article_id,position) DO UPDATE SET token=excluded.token WHERE native_article_ngram.token IS NOT excluded.token`,
        ...identity,
        payload,
      ),
    );
  }
  result.push(statement('DELETE FROM native_source_sync_tombstone WHERE board_id=? AND portal_num=?', board, portal));
  return result;
}
function fingerprint(row: Row, names: readonly string[]): string {
  return JSON.stringify(names.map((name) => row[name]));
}
interface Match {
  id: number;
  row: Row;
  linked?: boolean;
}
function groupStatements(dataset: 'lectures' | 'versions', incoming: Row[], existing: Match[]): Statement[] {
  const result: Statement[] = [];
  const names = dataset === 'lectures' ? lectureFields : versionFields;
  const used = new Set<number>();
  const unmatched: Row[] = [];
  const buckets = new Map<string, Match[]>();
  const positions = new Map<string, number>();
  for (const candidate of existing) {
    const key = fingerprint(candidate.row, names);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  }
  if (dataset === 'lectures' && incoming.length < existing.length)
    for (const bucket of buckets.values()) bucket.sort((a, b) => Number(b.linked) - Number(a.linked) || a.id - b.id);
  for (const row of incoming) {
    const key = fingerprint(row, names);
    const index = positions.get(key) ?? 0;
    const match = buckets.get(key)?.[index];
    if (match) {
      used.add(match.id);
      positions.set(key, index + 1);
    } else unmatched.push(row);
  }
  let remainder = existing.filter((candidate) => !used.has(candidate.id));
  if (
    dataset === 'versions' &&
    new Set(existing.map((item) => String(item.row.version).replace(/[A-Z]/g, (letter) => letter.toLowerCase())))
      .size !== existing.length
  )
    throw new Conflict('AMBIGUOUS_GROUP');
  // Stable versions match their version key even when their contents change.
  if (dataset === 'versions') {
    for (let index = unmatched.length - 1; index >= 0; index--) {
      const row = unmatched[index]!;
      const candidates = remainder.filter(
        (item) =>
          String(item.row.version).replace(/[A-Z]/g, (letter) => letter.toLowerCase()) ===
          String(row.version).replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
      );
      if (candidates.length !== 1) continue;
      const match = candidates[0]!;
      result.push(...setDifferent('versions', match.id, match.row, row, names));
      remainder = remainder.filter((item) => item !== match);
      unmatched.splice(index, 1);
    }
  }
  if (unmatched.length === 1 && remainder.length === 1) {
    const match = remainder.pop()!;
    result.push(...setDifferent(dataset, match.id, match.row, unmatched.pop()!, names));
  } else if (unmatched.length && remainder.length) throw new Conflict('AMBIGUOUS_GROUP');
  for (const item of remainder) {
    if (dataset === 'lectures') {
      result.push(
        statement(
          `INSERT INTO native_source_sync_v2_guard(valid)
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM timetable_lecture WHERE lectures_id=?) THEN 1 ELSE 0 END`,
          item.id,
        ),
      );
      result.push(statement('DELETE FROM lectures WHERE id=?', item.id));
    } else result.push(statement('DELETE FROM versions WHERE id=?', item.id));
  }
  for (const row of unmatched) {
    const columns =
      dataset === 'lectures' ? lectureFields : (['version', 'type', 'title', 'is_previous', 'content'] as const);
    result.push(
      statement(
        `INSERT INTO ${dataset}(${columns.map((name) => `"${name}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        ...fields(row, columns),
      ),
    );
  }
  return result;
}
export class Conflict extends Error {}
export async function applyDelta(db: D1Database, payload: Delta): Promise<Statement[]> {
  const { dataset, upserts, deletes } = payload;
  const result: Statement[] = [];
  let existingGroupRows = 0;
  const groups = new Map<string, { key: Key; rows: Row[] }>();
  for (const row of upserts) {
    const key = rowKey(dataset, row);
    const canonical = canonicalKey(dataset, key);
    const group = groups.get(canonical);
    if (group) group.rows.push(row);
    else groups.set(canonical, { key, rows: [row] });
  }
  for (const { key, rows } of groups.values()) {
    if (dataset === 'lectures' || dataset === 'versions') {
      const query =
        dataset === 'lectures'
          ? `SELECT id,EXISTS(SELECT 1 FROM timetable_lecture t WHERE t.lectures_id=lectures.id) linked,
          ${lectureFields.map((name) => `"${name}"`).join(',')} FROM lectures WHERE semester_date=? COLLATE NOCASE AND code=? COLLATE NOCASE AND class=? COLLATE NOCASE ORDER BY id LIMIT 1001`
          : `SELECT id,version,title,is_previous,content FROM versions WHERE type='timetable' COLLATE NOCASE ORDER BY id LIMIT 1001`;
      const existing = (await all(db, query, ...(dataset === 'lectures' ? key : []))).map(({ id, linked, ...row }) => ({
        id: id as number,
        linked: Boolean(linked),
        row,
      }));
      existingGroupRows += existing.length;
      if (existingGroupRows > 1000) throw new Conflict('GROUP_TOO_LARGE');
      result.push(...groupStatements(dataset, rows, existing));
      continue;
    }
    const row = rows[0]!;
    if (dataset === 'articles') {
      const identity = await articleIdentity(db, key);
      const id = identity?.id;
      if (identity?.needsIdentity)
        result.push(
          statement(
            'INSERT INTO native_source_article_identity(board_id,portal_num,article_id) VALUES(?,?,?)',
            ...key,
            id!,
          ),
        );
      const existing = id !== undefined ? (await readKey(db, dataset, key))[0] : undefined;
      // Tombstoned identities keep their article ID for a future resurrection.
      if (id !== undefined && !existing) {
        const joined = await all(
          db,
          `SELECT a.title,a.content,a.is_notice,a.is_deleted,k.author,k.portal_hit,k.url,k.registered_at
          FROM new_articles a JOIN new_koreatech_articles k ON k.article_id=a.id WHERE a.id=?`,
          id,
        );
        if (joined.length !== 1) throw new Conflict('ARTICLE_IDENTITY_MISSING');
        const attachments = await all(
          db,
          'SELECT lower(hex(hash)) hash,url,name,is_deleted FROM article_attachments WHERE article_id=? LIMIT 1001',
          id,
        );
        if (attachments.length > 1000) throw new Conflict('ATTACHMENTS_TOO_LARGE');
        result.push(...articleStatements(row, { ...joined[0], attachments }, id));
      } else result.push(...articleStatements(row, existing, id));
    } else if (dataset === 'dining')
      result.push(simpleUpsert('dining_menus', ['date', 'type', 'place'], diningFields, row, true));
    else if (dataset === 'semesters') result.push(simpleUpsert('semester', ['semester'], ['year', 'term'], row));
    else if (dataset === 'citybus')
      result.push(
        simpleUpsert('citybus_timetables', ['id'], ['bus_info', 'bus_timetables', 'updated_at'], {
          ...row,
          bus_info: JSON.stringify(row.bus_info),
          bus_timetables: JSON.stringify(row.bus_timetables),
        }),
      );
    else if (dataset === 'weather')
      result.push(
        statement(
          `INSERT INTO native_transport_cache(id,payload,expires_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,updated_at=excluded.updated_at
      WHERE excluded.updated_at>=native_transport_cache.updated_at AND
      (native_transport_cache.payload IS NOT excluded.payload OR native_transport_cache.expires_at IS NOT excluded.expires_at)`,
          row.id as string,
          JSON.stringify(row.payload),
          row.expires_at as number | null,
          row.updated_at as number,
        ),
      );
  }
  for (const key of deletes) {
    switch (dataset) {
      case 'dining':
        result.push(
          statement(
            'DELETE FROM dining_menus WHERE date=? AND type=? COLLATE NOCASE AND place=? COLLATE NOCASE',
            ...key,
          ),
        );
        break;
      case 'semesters':
        result.push(statement('DELETE FROM semester WHERE semester=?', ...key));
        break;
      case 'citybus':
        result.push(statement('DELETE FROM citybus_timetables WHERE id=?', ...key));
        break;
      case 'weather':
        result.push(statement('DELETE FROM native_transport_cache WHERE id=?', ...key));
        break;
      case 'articles': {
        const identity = await articleIdentity(db, key);
        if (identity) {
          const id = identity.id;
          const attachmentCount = await all(db, 'SELECT 1 FROM article_attachments WHERE article_id=? LIMIT 1001', id);
          if (attachmentCount.length > 1000) throw new Conflict('ATTACHMENTS_TOO_LARGE');
          result.push(
            statement(
              `INSERT INTO native_source_sync_v2_guard(valid)
            SELECT CASE WHEN (SELECT count(*) FROM
              (SELECT 1 FROM article_attachments WHERE article_id=? LIMIT 1001))<=1000 THEN 1 ELSE 0 END`,
              id,
            ),
          );
          if (identity.needsIdentity)
            result.push(
              statement(
                'INSERT INTO native_source_article_identity(board_id,portal_num,article_id) VALUES(?,?,?)',
                ...key,
                id,
              ),
            );
          result.push(statement('UPDATE new_articles SET is_deleted=1 WHERE id=? AND is_deleted<>1', id));
          result.push(
            statement('UPDATE new_koreatech_articles SET is_deleted=1 WHERE article_id=? AND is_deleted<>1', id),
          );
          result.push(
            statement('UPDATE article_attachments SET is_deleted=1 WHERE article_id=? AND is_deleted<>1', id),
          );
          result.push(
            statement('INSERT OR IGNORE INTO native_source_sync_tombstone(board_id,portal_num) VALUES(?,?)', ...key),
          );
        }
        break;
      }
      case 'lectures':
      case 'versions': {
        const query =
          dataset === 'lectures'
            ? `SELECT id,EXISTS(SELECT 1 FROM timetable_lecture t WHERE t.lectures_id=lectures.id) linked,
            ${lectureFields.map((name) => `"${name}"`).join(',')} FROM lectures WHERE semester_date=? COLLATE NOCASE AND code=? COLLATE NOCASE AND class=? COLLATE NOCASE ORDER BY id LIMIT 1001`
            : `SELECT id,version,title,is_previous,content FROM versions WHERE type='timetable' COLLATE NOCASE ORDER BY id LIMIT 1001`;
        const existing = (await all(db, query, ...(dataset === 'lectures' ? key : []))).map(
          ({ id, linked, ...row }) => ({ id: id as number, linked: Boolean(linked), row }),
        );
        existingGroupRows += existing.length;
        if (existingGroupRows > 1000) throw new Conflict('GROUP_TOO_LARGE');
        result.push(...groupStatements(dataset, [], existing));
        break;
      }
    }
  }
  return result;
}
