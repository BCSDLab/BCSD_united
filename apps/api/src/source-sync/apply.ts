import type { Dataset } from './contract';

export interface Statement {
  sql: string;
  args: (string | number | null)[];
}
const j = (name: string) => `json_extract(s.payload,'$.${name}')`;
const fields = (names: string[]) => names.map(j).join(',');

/** SQL identifiers and JSON paths are fixed here; checkpoint interpolation accepts digits only. */
export function applyStatements(dataset: Dataset, checkpoint: string): Statement[] {
  if (
    !['dining', 'articles', 'lectures', 'semesters', 'versions', 'citybus', 'weather'].includes(dataset) ||
    !/^[1-9]\d{12,14}$/.test(checkpoint)
  )
    throw new TypeError('Invalid source dataset or checkpoint');
  const source = `FROM native_source_sync_row s WHERE s.dataset='${dataset}' AND s.checkpoint='${checkpoint}'`;
  const query = (sql: string): Statement => ({ sql, args: [] });
  const unique = (keys: string[]) =>
    query(`INSERT INTO native_source_sync_guard(valid) SELECT CASE WHEN NOT EXISTS
    (SELECT 1 ${source} GROUP BY ${fields(keys)} HAVING count(*)>1) THEN 1 ELSE 0 END`);
  switch (dataset) {
    case 'weather':
      return [
        unique(['id']),
        query(`INSERT INTO native_transport_cache(id,payload,expires_at,updated_at)
        SELECT ${j('id')},json(json_extract(s.payload,'$.payload')),${j('expires_at')},${j('updated_at')} ${source} ORDER BY s.ordinal
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        WHERE excluded.updated_at >= native_transport_cache.updated_at`),
      ];
    case 'dining':
      return [
        unique(['date', 'type', 'place']),
        query(`INSERT INTO dining_menus(date,type,place,price_card,price_cash,kcal,menu,is_changed,image_url)
        SELECT ${fields(['date', 'type', 'place', 'price_card', 'price_cash', 'kcal', 'menu', 'is_changed', 'image_url'])} ${source} ORDER BY s.ordinal
        ON CONFLICT(date,type,place) DO UPDATE SET price_card=excluded.price_card,price_cash=excluded.price_cash,kcal=excluded.kcal,menu=excluded.menu,is_changed=excluded.is_changed,image_url=COALESCE(excluded.image_url,dining_menus.image_url)`),
      ];
    case 'citybus':
      return [
        unique(['id']),
        query(`INSERT INTO citybus_timetables(id,bus_info,bus_timetables,updated_at)
        SELECT ${j('id')},json(json_extract(s.payload,'$.bus_info')),json(json_extract(s.payload,'$.bus_timetables')),${j('updated_at')} ${source} ORDER BY s.ordinal
        ON CONFLICT(id) DO UPDATE SET bus_info=excluded.bus_info,bus_timetables=excluded.bus_timetables,updated_at=excluded.updated_at`),
      ];
    case 'semesters':
      return [
        unique(['semester']),
        query(`INSERT INTO semester(semester,year,term) SELECT ${fields(['semester', 'year', 'term'])} ${source} ORDER BY s.ordinal
        ON CONFLICT(semester) DO UPDATE SET year=excluded.year,term=excluded.term`),
      ];
    case 'versions':
      return [
        unique(['version']),
        query(`UPDATE versions SET title=(SELECT ${j('title')} ${source} AND ${j('version')}=versions.version LIMIT 1),
        is_previous=(SELECT ${j('is_previous')} ${source} AND ${j('version')}=versions.version LIMIT 1),
        content=(SELECT ${j('content')} ${source} AND ${j('version')}=versions.version LIMIT 1)
        WHERE type='timetable' AND EXISTS(SELECT 1 ${source} AND ${j('version')}=versions.version)`),
        query(`INSERT INTO versions(version,type,title,is_previous,content)
        SELECT ${fields(['version', 'type', 'title', 'is_previous', 'content'])} ${source}
        AND NOT EXISTS(SELECT 1 FROM versions v WHERE v.type='timetable' AND v.version=${j('version')}) ORDER BY s.ordinal`),
      ];
    case 'articles': {
      const mapped = `(SELECT m.article_id FROM native_source_sync_article_match m WHERE m.checkpoint=s.checkpoint AND m.ordinal=s.ordinal)`;
      const ordinal = `(SELECT m.ordinal FROM native_source_sync_article_match m WHERE m.checkpoint='${checkpoint}' AND m.article_id=new_articles.id)`;
      const identity = `SELECT 1 FROM native_source_article_identity i WHERE i.board_id=${j('board_id')} AND i.portal_num=${j('portal_num')}`;
      const without = `AND NOT EXISTS(${identity})`;
      return [
        unique(['board_id', 'portal_num']),
        query(
          `INSERT INTO native_source_sync_guard(valid) SELECT CASE WHEN NOT EXISTS(SELECT 1 ${source} AND NOT EXISTS(SELECT 1 FROM boards b WHERE b.id=${j('board_id')})) THEN 1 ELSE 0 END`,
        ),
        query(`INSERT INTO native_source_article_identity(board_id,portal_num,article_id)
          SELECT a.board_id,k.portal_num,a.id FROM new_articles a JOIN new_koreatech_articles k ON k.article_id=a.id
          WHERE NOT EXISTS(SELECT 1 FROM native_source_article_identity i WHERE i.article_id=a.id)`),
        query(`INSERT INTO native_source_sync_article_match(checkpoint,ordinal,article_id)
          SELECT s.checkpoint,s.ordinal,(SELECT i.article_id FROM native_source_article_identity i WHERE i.board_id=${j('board_id')} AND i.portal_num=${j('portal_num')})
          ${source} AND EXISTS(${identity})`),
        query(`INSERT INTO native_source_sync_article_match(checkpoint,ordinal,article_id)
          SELECT s.checkpoint,s.ordinal,(SELECT COALESCE(max(id),0) FROM new_articles)+row_number() OVER(ORDER BY s.ordinal)
          ${source} ${without}`),
        query(`INSERT INTO native_source_sync_article_new(checkpoint,article_id)
          SELECT s.checkpoint,${mapped} ${source} ${without}`),
        query(`INSERT INTO new_articles(id,board_id,title,content,is_notice,is_deleted)
          SELECT ${mapped},${fields(['board_id', 'title', 'content', 'is_notice', 'is_deleted'])} ${source} ${without} ORDER BY s.ordinal`),
        query(`INSERT INTO native_source_article_identity(board_id,portal_num,article_id)
          SELECT ${j('board_id')},${j('portal_num')},${mapped} ${source} ${without} ORDER BY s.ordinal`),
        query(`UPDATE new_articles SET title=(SELECT ${j('title')} ${source} AND s.ordinal=${ordinal}),
          content=(SELECT ${j('content')} ${source} AND s.ordinal=${ordinal}),
          is_notice=(SELECT ${j('is_notice')} ${source} AND s.ordinal=${ordinal}),
          is_deleted=(SELECT ${j('is_deleted')} ${source} AND s.ordinal=${ordinal})
          WHERE id IN(SELECT article_id FROM native_source_sync_article_match WHERE checkpoint='${checkpoint}')`),
        query(`INSERT INTO new_koreatech_articles(article_id,author,portal_num,portal_hit,url,registered_at,is_deleted)
          SELECT ${mapped},${fields(['author', 'portal_num', 'portal_hit', 'url', 'registered_at', 'is_deleted'])} ${source} ORDER BY s.ordinal
          ON CONFLICT(article_id) DO UPDATE SET author=excluded.author,portal_num=excluded.portal_num,portal_hit=excluded.portal_hit,url=excluded.url,registered_at=excluded.registered_at,is_deleted=excluded.is_deleted`),
        query(`INSERT OR IGNORE INTO native_community_outbox(id,kind,payload,created_at)
          SELECT 'source-article:'||article_id||':'||user_id,'community.push',
          json_object('userId',user_id,'title',title,'message','방금 등록된 '||keyword||' 공지를 확인해보세요!',
            'mobileAppPath','KEYWORD','schemeUri','keyword?id='||article_id||'&keyword='||keyword||'&board-id='||board_id,'type','MESSAGE'),
          unixepoch()*1000
          FROM (
            SELECT a.id article_id,a.title,a.board_id,m.user_id,k.keyword,
              row_number() OVER(PARTITION BY a.id,m.user_id ORDER BY length(k.keyword) DESC,m.id ASC) ranking
            FROM native_source_sync_article_new n JOIN new_articles a ON a.id=n.article_id
            JOIN article_keywords k ON k.category='KOREATECH' AND instr(a.title,k.keyword)>0 AND k.is_deleted=0
            JOIN article_keyword_user_map m ON m.keyword_id=k.id AND m.is_deleted=0
            JOIN users u ON u.id=m.user_id AND u.is_deleted=0 AND u.device_token IS NOT NULL
            WHERE n.checkpoint='${checkpoint}' AND a.is_deleted=0
            AND EXISTS(SELECT 1 FROM notification_subscribe ns WHERE ns.user_id=u.id AND ns.subscribe_type='ARTICLE_KEYWORD' AND ns.detail_type IS NULL)
          ) WHERE ranking=1 RETURNING id,kind`),
        query(`INSERT INTO native_source_sync_guard(valid) SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM native_source_sync_row s, json_each(s.payload,'$.attachments') a
          WHERE s.dataset='articles' AND s.checkpoint='${checkpoint}' GROUP BY s.ordinal,json_extract(a.value,'$.hash') HAVING count(*)>1) THEN 1 ELSE 0 END`),
        query(`UPDATE article_attachments SET is_deleted=1 WHERE article_id IN (
          SELECT article_id FROM native_source_sync_article_match WHERE checkpoint='${checkpoint}')
          AND NOT EXISTS(SELECT 1 FROM native_source_sync_article_match m
          JOIN native_source_sync_row s ON s.dataset='articles' AND s.checkpoint=m.checkpoint AND s.ordinal=m.ordinal
          JOIN json_each(s.payload,'$.attachments') a
          WHERE m.checkpoint='${checkpoint}' AND m.article_id=article_attachments.article_id
          AND json_extract(a.value,'$.hash')=lower(hex(article_attachments.hash)))`),
        query(`INSERT INTO article_attachments(article_id,hash,url,name,is_deleted)
          SELECT ${mapped},unhex(json_extract(a.value,'$.hash')),json_extract(a.value,'$.url'),json_extract(a.value,'$.name'),json_extract(a.value,'$.is_deleted')
          FROM native_source_sync_row s,json_each(s.payload,'$.attachments') a WHERE s.dataset='articles' AND s.checkpoint='${checkpoint}' ORDER BY s.ordinal
          ON CONFLICT(article_id,hash) DO UPDATE SET url=excluded.url,name=excluded.name,is_deleted=excluded.is_deleted`),
        query(
          `DELETE FROM native_article_ngram WHERE article_id IN (SELECT article_id FROM native_source_sync_article_match WHERE checkpoint='${checkpoint}')`,
        ),
        query(`INSERT INTO native_article_ngram(article_id,position,token)
          SELECT m.article_id,json_extract(g.value,'$.position'),json_extract(g.value,'$.token')
          FROM native_source_sync_article_gram a JOIN native_source_sync_article_match m ON m.checkpoint=a.checkpoint AND m.ordinal=a.ordinal,
          json_each(a.grams) g WHERE a.checkpoint='${checkpoint}'`),
        query(`DELETE FROM native_source_sync_article_match WHERE checkpoint='${checkpoint}'`),
        query(`DELETE FROM native_source_sync_article_gram WHERE checkpoint='${checkpoint}'`),
        query(`DELETE FROM native_source_sync_article_new WHERE checkpoint='${checkpoint}'`),
      ];
    }
    case 'lectures': {
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
      ];
      const fp = `json_array(${fields(lectureFields)})`;
      const oldFp = `json_array(${lectureFields.map((name) => `l."${name}"`).join(',')})`;
      const unmatched = `NOT EXISTS(SELECT 1 FROM native_source_sync_lecture_match m WHERE m.checkpoint=s.checkpoint AND m.ordinal=s.ordinal)`;
      const linked = `NOT EXISTS(SELECT 1 FROM native_source_sync_lecture_match m WHERE m.lecture_id=l.id)`;
      const natural = `l.semester_date=${j('semester_date')} AND l.code=${j('code')} AND l.class=${j('class')}`;
      const ordinal = `(SELECT m.ordinal FROM native_source_sync_lecture_match m WHERE m.checkpoint='${checkpoint}' AND m.lecture_id=lectures.id)`;
      const sourceCount = `(SELECT count(*) FROM native_source_sync_row t WHERE t.dataset='lectures' AND t.checkpoint='${checkpoint}' AND json_extract(t.payload,'$.semester_date')=${j('semester_date')} AND json_extract(t.payload,'$.code')=${j('code')} AND json_extract(t.payload,'$.class')=${j('class')} AND NOT EXISTS(SELECT 1 FROM native_source_sync_lecture_match m WHERE m.checkpoint=t.checkpoint AND m.ordinal=t.ordinal))`;
      return [
        query(
          `UPDATE native_source_sync_state SET old_max_id=(SELECT COALESCE(max(id),0) FROM lectures) WHERE dataset='lectures'`,
        ),
        query(`INSERT INTO native_source_sync_lecture_match(checkpoint,ordinal,lecture_id)
          WITH sr AS (SELECT s.ordinal,${fp} fingerprint,row_number() OVER(PARTITION BY ${fp} ORDER BY s.ordinal) rn ${source}),
          lr AS (SELECT l.id,${oldFp} fingerprint,row_number() OVER(PARTITION BY ${oldFp} ORDER BY l.id) rn FROM lectures l
            WHERE l.semester_date IN (SELECT DISTINCT ${j('semester_date')} ${source}))
          SELECT '${checkpoint}',sr.ordinal,lr.id FROM sr JOIN lr ON sr.fingerprint=lr.fingerprint AND sr.rn=lr.rn`),
        query(`INSERT INTO native_source_sync_guard(valid) SELECT CASE WHEN NOT EXISTS (
          SELECT 1 ${source} AND ${unmatched} AND EXISTS(SELECT 1 FROM lectures l WHERE ${natural} AND ${linked})
          AND (${sourceCount}>1 OR (SELECT count(*) FROM lectures l WHERE ${natural} AND ${linked})>1)
          ) THEN 1 ELSE 0 END`),
        query(`INSERT INTO native_source_sync_lecture_match(checkpoint,ordinal,lecture_id)
          SELECT s.checkpoint,s.ordinal,(SELECT l.id FROM lectures l WHERE ${natural} AND ${linked})
          ${source} AND ${unmatched} AND ${sourceCount}=1
          AND (SELECT count(*) FROM lectures l WHERE ${natural} AND ${linked})=1`),
        query(`INSERT INTO native_source_sync_guard(valid) SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM lectures l WHERE
          NOT EXISTS(SELECT 1 FROM native_source_sync_lecture_match m WHERE m.lecture_id=l.id)
          AND EXISTS(SELECT 1 FROM timetable_lecture t WHERE t.lectures_id=l.id)) THEN 1 ELSE 0 END`),
        query(`UPDATE lectures SET ${lectureFields.map((name) => `"${name}"=(SELECT ${j(name)} ${source} AND s.ordinal=${ordinal})`).join(',')}
          WHERE id IN(SELECT lecture_id FROM native_source_sync_lecture_match WHERE checkpoint='${checkpoint}')`),
        query(`INSERT INTO lectures(${lectureFields.map((name) => `"${name}"`).join(',')})
          SELECT ${fields(lectureFields)} ${source} AND ${unmatched} ORDER BY s.ordinal`),
        query(`DELETE FROM lectures WHERE id<=(SELECT old_max_id FROM native_source_sync_state WHERE dataset='lectures')
          AND id NOT IN(SELECT lecture_id FROM native_source_sync_lecture_match WHERE checkpoint='${checkpoint}')`),
        query(`DELETE FROM native_source_sync_lecture_match WHERE checkpoint='${checkpoint}'`),
      ];
    }
  }
}
