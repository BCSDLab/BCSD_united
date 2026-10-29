import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { coordinateRequest } from '@api/coordination';
import { executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  activeParticipant,
  beginGuard,
  body,
  displayNickname,
  endGuard,
  eventStatement,
  fail,
  gate,
  getPost,
  getUser,
  integer,
  localDateTime,
  locationName,
  requireParticipant,
  signalEvents,
  utcText,
  type Notification,
} from '@api/domains/callvan/core';

export function chatDateTime(createdAt: string): { date: string; time: string } {
  const local = localDateTime(createdAt)!;
  const hour = Number(local.slice(11, 13));
  return {
    date: `${local.slice(0, 4)}. ${local.slice(5, 7)}. ${local.slice(8, 10)}`,
    time: `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${local.slice(14, 16)}`,
  };
}

export function registerMessages(app: Hono<ApiEnv>): void {
  app.get('/callvan/posts/:postId/chat', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const postId = integer(c.req.param('postId'));
    const db = c.get('db');
    await requireParticipant(db, postId, userId);
    const post = await getPost(db, postId);
    const messages = await db.all<typeof schema.callvan_chat_message.$inferSelect>(
      sql`SELECT * FROM ${schema.callvan_chat_message} WHERE callvan_chat_room_id = ${post.chat_room_id} AND is_deleted = 0 ORDER BY created_at ASC, id ASC`,
    );
    return c.json({
      room_name: `${locationName(post.departure_type, post.departure_custom_name)} -> ${locationName(post.arrival_type, post.arrival_custom_name)} (${post.departure_time.slice(0, 5)}) (${post.max_participants}명)`,
      messages: messages.map((message) => ({
        user_id: message.sender_id,
        sender_nickname: message.sender_nickname,
        content: message.content,
        ...chatDateTime(message.created_at),
        is_image: Boolean(message.is_image),
        is_left_user: Boolean(message.is_left_user),
        is_mine: message.sender_id === userId,
      })),
    });
  });

  app.post('/callvan/posts/:postId/chat', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const postId = integer(c.req.param('postId'));
    const coordinated = await coordinateRequest(c, `callvan:${postId}`);
    if (coordinated) return coordinated;
    const input = await body(c);
    if (typeof input.content !== 'string' || typeof input.is_image !== 'boolean') fail('INVALID_REQUEST_BODY');
    const db = c.get('db');
    await requireParticipant(db, postId, userId);
    const post = await getPost(db, postId);
    const user = await getUser(db, userId);
    const nickname = displayNickname(user);
    const now = utcText();
    const key = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const result = await executeAtomic(db, [
      beginGuard(
        key,
        sql`${activeParticipant(postId, userId)} AND EXISTS (SELECT 1 FROM ${schema.callvan_post} WHERE id = ${postId} AND is_deleted = 0)`,
      ),
      sql`INSERT INTO ${schema.callvan_chat_message} (callvan_chat_room_id, sender_id, sender_nickname, message_type, content, is_image, is_left_user, is_deleted, created_at, updated_at) SELECT ${post.chat_room_id}, ${userId}, ${nickname}, ${input.is_image ? 'IMAGE' : 'TEXT'}, ${input.content}, ${input.is_image ? 1 : 0}, 0, 0, ${now}, ${now} WHERE ${gate(key)}`,
      eventStatement(
        key,
        eventId,
        postId,
        'NEW_MESSAGE',
        { sender_id: userId, sender_nickname: nickname, content: input.content, is_image: input.is_image },
        now,
      ),
      endGuard(key),
    ]);
    if (!result[0]?.meta.changes) {
      // 글이 없으면 404, 있으면 참여자가 아닌 것이다.
      await getPost(db, postId);
      fail('FORBIDDEN_PARTICIPANT');
    }
    await signalEvents(c.env, [eventId]);
    return c.body(null, 201);
  });

  app.get('/callvan/notifications', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const notifications = await c
      .get('db')
      .all<Notification>(
        sql`SELECT * FROM ${schema.callvan_notification} WHERE recipient_id = ${userId} AND is_deleted = 0 ORDER BY created_at DESC, id DESC`,
      );
    return c.json(
      notifications.map((notification) => ({
        id: notification.id,
        type: notification.notification_type,
        message_preview: notification.message_preview,
        is_read: Boolean(notification.is_read),
        created_at: localDateTime(notification.created_at),
        post_id: notification.callvan_post_id,
        departure: locationName(notification.departure_type, notification.departure_custom_name),
        arrival: locationName(notification.arrival_type, notification.arrival_custom_name),
        departure_date: notification.departure_date,
        departure_time: notification.departure_time,
        current_participants: notification.current_participants,
        max_participants: notification.max_participants,
        sender_nickname: notification.sender_nickname,
        joined_member_nickname: notification.joined_member_nickname,
      })),
    );
  });

  app.post('/callvan/notifications/mark-all-read', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    await c
      .get('db')
      .run(
        sql`UPDATE ${schema.callvan_notification} SET is_read = 1, updated_at = ${utcText()} WHERE recipient_id = ${userId} AND is_deleted = 0`,
      );
    return c.body(null, 204);
  });

  app.post('/callvan/notifications/:notificationId/read', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const id = integer(c.req.param('notificationId'));
    await c
      .get('db')
      .run(
        sql`UPDATE ${schema.callvan_notification} SET is_read = 1, updated_at = ${utcText()} WHERE id = ${id} AND recipient_id = ${userId} AND is_deleted = 0`,
      );
    return c.body(null, 204);
  });

  app.delete('/callvan/notifications', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    await c
      .get('db')
      .run(
        sql`UPDATE ${schema.callvan_notification} SET is_deleted = 1, updated_at = ${utcText()} WHERE recipient_id = ${userId} AND is_deleted = 0`,
      );
    return c.body(null, 204);
  });

  app.delete('/callvan/notifications/:notificationId', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const id = integer(c.req.param('notificationId'));
    await c
      .get('db')
      .run(
        sql`UPDATE ${schema.callvan_notification} SET is_deleted = 1, updated_at = ${utcText()} WHERE id = ${id} AND recipient_id = ${userId} AND is_deleted = 0`,
      );
    return c.body(null, 204);
  });
}
