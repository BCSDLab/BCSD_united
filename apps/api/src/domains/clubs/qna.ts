import { and, eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import { canCreateQna, canDeleteQna, integer, localDateTime, text } from '@api/domains/clubs/behavior';
import { body, clubId, forbidden, getClub, manager, missing, requireStudent } from '@api/domains/clubs/shared';

interface QnaResponse {
  id: number;
  author_id: number | null;
  nickname: string | null;
  content: string;
  created_at: string;
  children: QnaResponse[];
}

export function registerQna(app: Hono<ApiEnv>): void {
  app.get('/clubs/:clubId/qna', async c => {
    const id = clubId(c);
    const rows = await c.get('db').select({ qna: schema.club_qna, nickname: schema.users.nickname, anonymous: schema.users.anonymous_nickname, userId: schema.users.id })
      .from(schema.club_qna).leftJoin(schema.users, and(eq(schema.club_qna.author_id, schema.users.id), eq(schema.users.is_deleted, false)))
      .where(sql`${schema.club_qna.id} IN (WITH RECURSIVE tree(id) AS (SELECT id FROM ${schema.club_qna} WHERE club_id=${id} UNION SELECT q.id FROM ${schema.club_qna} q JOIN tree t ON q.parent_id=t.id) SELECT id FROM tree)`);
    const children = new Map<number, typeof rows>();
    for (const row of rows) if (row.qna.parent_id !== null) {
      const items = children.get(row.qna.parent_id) ?? [];
      items.push(row);
      children.set(row.qna.parent_id, items);
    }
    const convert = (row: typeof rows[number]): QnaResponse => ({
      id: row.qna.id, author_id: row.userId, nickname: row.userId === null ? '탈퇴한 회원' : row.nickname ?? row.anonymous,
      content: row.qna.content, created_at: localDateTime(row.qna.created_at).slice(0, 16).replaceAll('-', '.').replace('T', ' '),
      children: (children.get(row.qna.id) ?? []).map(convert),
    });
    const roots = rows.filter(row => row.qna.club_id === id && row.qna.parent_id === null).sort((a, b) => b.qna.created_at.localeCompare(a.qna.created_at));
    return c.json({ root_count: roots.length, total_count: rows.filter(row => row.qna.club_id === id).length, qnas: roots.map(convert) });
  });

  app.post('/clubs/:clubId/qna', async c => {
    const request = await body(c);
    const content = text(request, 'content', 255, true)!;
    const parentId = request.parent_id == null ? null : integer(request.parent_id, 'parent_id');
    const user = await requireStudent(c);
    const db = c.get('db');
    const id = clubId(c);
    await getClub(db, id);
    const isManager = await manager(db, id, user);
    if (!canCreateQna(isManager, parentId)) forbidden();
    if (parentId !== null) {
      const [parent] = await db.select({ id: schema.club_qna.id }).from(schema.club_qna).where(eq(schema.club_qna.id, parentId));
      if (!parent) missing('동아리 QNA가 존재하지 않습니다.');
    }
    await db.insert(schema.club_qna).values({ club_id: id, author_id: user, parent_id: parentId, content, is_manager: isManager, is_deleted: false });
    return c.body(null, 201);
  });

  app.delete('/clubs/:clubId/qna/:qnaId', async c => {
    const user = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    const id = integer(c.req.param('qnaId'), 'qnaId');
    const [qna] = await db.select().from(schema.club_qna).where(eq(schema.club_qna.id, id));
    if (!qna) missing('동아리 QNA가 존재하지 않습니다.');
    if (!canDeleteQna(qna.author_id, user, await manager(db, clubId(c), user))) forbidden();
    await db.run(sql`WITH RECURSIVE descendants(id) AS (SELECT ${id} UNION ALL SELECT q.id FROM ${schema.club_qna} q JOIN descendants d ON q.parent_id=d.id) DELETE FROM ${schema.club_qna} WHERE id IN (SELECT id FROM descendants)`);
    return c.body(null, 204);
  });
}
