import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { createDatabase, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';
import { deliverNotification } from '@api/domains/misc/notifications';

export interface ChatRoom {
  article_id: number;
  chatroom_id: number;
  article_author_id: number;
  item_owner_id: number;
  created_at: string;
}
export interface ChatMessage {
  user_id: number;
  user_nickname: string | null;
  content: string | null;
  timestamp: string;
  is_image: boolean | null;
}
interface StoredMessage {
  id: string;
  user_id: number;
  nick_name: string | null;
  contents: string | null;
  created_at: string;
  is_image: number | null;
  is_read: number;
}
export interface ChatBroker {
  nextId(): Promise<string>;
  subscriptionCount(destination: string): number;
  hasActiveSession(userId: number): boolean;
  publish(destination: string, body: unknown): void;
  scheduleNotification(id: string): void;
}

export function chatPartner(room: ChatRoom, userId: number): number {
  if (userId === room.article_author_id) return room.item_owner_id;
  if (userId === room.item_owner_id) return room.article_author_id;
  throw new ApiError(403, 'FORBIDDEN_AUTHOR', '게시글 접근 권한이 없습니다.');
}

export function nextChatTsid(now: number, previous: string | null): string {
  const candidate = (BigInt(now) - 1577836800000n) << 22n;
  const last = previous === null ? -1n : BigInt(previous);
  return (candidate > last ? candidate : last + 1n).toString();
}

export function compareChatMessageIds(a: string, b: string): number {
  const first = BigInt(a);
  const second = BigInt(b);
  return first < second ? -1 : first > second ? 1 : 0;
}

export function chatLocalTime(utc: string): string {
  return new Date(new Date(utc.endsWith('Z') ? utc : `${utc.replace(' ', 'T')}Z`).getTime() + 9 * 3600000)
    .toISOString()
    .slice(0, -1);
}

export function chatMessageResponse(message: StoredMessage): ChatMessage {
  return {
    user_id: message.user_id,
    user_nickname: message.nick_name,
    content: message.contents,
    timestamp: chatLocalTime(message.created_at),
    is_image: message.is_image === null ? null : Boolean(message.is_image),
  };
}

export async function getCommunityChatRoom(db: Database, articleId: number, roomId: number, userId: number) {
  const [room] = await db.all<ChatRoom>(sql`SELECT article_id,chatroom_id,article_author_id,item_owner_id,created_at
    FROM ${schema.lost_item_chat_room} WHERE article_id=${articleId} AND chatroom_id=${roomId}`);
  if (!room) throw new ApiError(404, 'NOT_FOUND_LOST_ITEM_CHATROOM', '분실물 게시글 채팅방이 존재하지 않습니다.');
  chatPartner(room, userId);
  return room;
}

async function isBlocked(db: Database, userId: number, otherId: number): Promise<boolean> {
  const rows = await db.all(sql`SELECT 1 FROM ${schema.lost_item_chat_user_block} WHERE is_active=1 AND
    ((blocker_user_id=${userId} AND blocked_user_id=${otherId}) OR
    (blocker_user_id=${otherId} AND blocked_user_id=${userId})) LIMIT 1`);
  return rows.length > 0;
}

async function roomDetail(db: Database, room: ChatRoom, userId: number) {
  if (await isBlocked(db, userId, chatPartner(room, userId))) {
    throw new ApiError(403, 'FORBIDDEN_BLOCKED_USER', '차단된 사용자입니다.');
  }
  const [article] = await db.all<{ title: string; author_id: number | null; profile_image_url: string | null }>(sql`
    SELECT a.title,u.id author_id,u.profile_image_url FROM ${schema.new_articles} a
    JOIN ${schema.lost_item_articles} l ON l.article_id=a.id
    LEFT JOIN ${schema.users} u ON u.id=l.author_id AND u.is_deleted=0
    WHERE a.id=${room.article_id} AND a.is_deleted=0`);
  if (!article) throw new ApiError(404, 'NOT_FOUND_ARTICLE', '게시글이 존재하지 않습니다.');
  if (article.author_id === null) throw new ApiError(404, 'NOT_FOUND_CHAT_PARTNER', '채팅 상대방이 존재하지 않습니다.');
  return {
    article_id: room.article_id,
    chat_room_id: room.chatroom_id,
    user_id: userId,
    article_title: article.title,
    chat_partner_profile_image: article.profile_image_url,
  };
}

export async function listCommunityChatRooms(db: Database, userId: number) {
  const rows = await db.all<ChatRoom & { title: string; image_url: string | null }>(sql`
    SELECT r.article_id,r.chatroom_id,r.article_author_id,r.item_owner_id,r.created_at,a.title,
      (SELECT min(i.image_url) FROM ${schema.lost_item_images} i WHERE i.lost_item_id=l.id AND i.is_deleted=0) image_url
    FROM ${schema.lost_item_chat_room} r
    JOIN ${schema.new_articles} a ON a.id=r.article_id AND a.is_deleted=0
    JOIN ${schema.lost_item_articles} l ON l.article_id=a.id
    JOIN ${schema.users} u ON u.id=r.item_owner_id AND u.is_deleted=0
    WHERE (r.article_author_id=${userId} OR r.item_owner_id=${userId})
      AND NOT EXISTS (SELECT 1 FROM ${schema.lost_item_chat_user_block} b WHERE b.is_active=1 AND
       ((b.blocker_user_id=r.article_author_id AND b.blocked_user_id=r.item_owner_id) OR
        (b.blocker_user_id=r.item_owner_id AND b.blocked_user_id=r.article_author_id)))`);
  const result = [];
  for (const room of rows) {
    const [last] = await db.all<StoredMessage>(sql`SELECT * FROM ${schema.native_chat_message}
      WHERE article_id=${room.article_id} AND chatroom_id=${room.chatroom_id}
      ORDER BY length(id) DESC,id DESC LIMIT 1`);
    if (!last && room.article_author_id === userId) continue;
    const [unread] = await db.all<{ count: number }>(sql`SELECT count(*) count FROM ${schema.native_chat_message}
      WHERE article_id=${room.article_id} AND chatroom_id=${room.chatroom_id} AND user_id<>${userId} AND is_read=0`);
    result.push({
      article_title: room.title,
      recent_message_content: last ? (last.is_image ? '사진' : last.contents) : '대화를 시작해보세요!',
      lost_item_image_url: room.image_url,
      unread_message_count: unread?.count ?? 0,
      last_message_at: chatLocalTime(last?.created_at ?? room.created_at),
      article_id: room.article_id,
      chat_room_id: room.chatroom_id,
    });
  }
  return result.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

async function history(db: Database, articleId: number, roomId: number, userId: number, polling: boolean) {
  if (polling) {
    await db.run(sql`INSERT INTO ${schema.native_chat_polling_session} (article_id,chatroom_id,user_id,expires_at)
      VALUES (${articleId},${roomId},${userId},${Date.now() + 20000})
      ON CONFLICT(article_id,chatroom_id,user_id) DO UPDATE SET expires_at=excluded.expires_at`);
  }
  await db.run(sql`UPDATE ${schema.native_chat_message} SET is_read=1
    WHERE article_id=${articleId} AND chatroom_id=${roomId} AND user_id<>${userId} AND is_read=0`);
  const messages = await db.all<StoredMessage>(sql`SELECT * FROM ${schema.native_chat_message}
    WHERE article_id=${articleId} AND chatroom_id=${roomId} ORDER BY length(id),id`);
  return messages.map(chatMessageResponse);
}

export async function sendCommunityChatMessage(
  env: Bindings,
  broker: ChatBroker,
  room: ChatRoom,
  userId: number,
  input: Record<string, unknown>,
  socket: boolean,
): Promise<ChatMessage> {
  const db = createDatabase(env.DB);
  const otherId = chatPartner(room, userId);
  const destination = `/topic/chat/${room.article_id}/${room.chatroom_id}`;
  const [online] = await db.all(sql`SELECT 1 FROM ${schema.native_chat_polling_session}
    WHERE article_id=${room.article_id} AND chatroom_id=${room.chatroom_id} AND user_id=${otherId} AND expires_at>${Date.now()}`);
  const read = socket ? broker.subscriptionCount(destination) === 2 : Boolean(online);
  const id = await broker.nextId();
  const now = new Date().toISOString();
  const content = typeof input.content === 'string' ? input.content : null;
  const nickname = typeof input.user_nickname === 'string' ? input.user_nickname : null;
  const image = typeof input.is_image === 'boolean' ? input.is_image : null;
  const notify = socket ? !broker.hasActiveSession(otherId) : !online;
  const messageInsert = db.insert(schema.native_chat_message).values({
    id,
    article_id: room.article_id,
    chatroom_id: room.chatroom_id,
    user_id: userId,
    is_read: read,
    is_deleted: false,
    is_image: image,
    nick_name: nickname,
    contents: content,
    created_at: now,
  });
  if (notify) {
    await db.batch([
      messageInsert,
      db.insert(schema.native_chat_outbox).values({
        id,
        message_id: id,
        receiver_id: otherId,
        payload: JSON.stringify({ articleId: room.article_id, roomId: room.chatroom_id, senderId: userId, content }),
        created_at: Date.now(),
        delivered_at: null,
      }),
    ]);
    broker.scheduleNotification(id);
  } else {
    await messageInsert;
  }
  const response: ChatMessage = {
    user_id: userId,
    user_nickname: nickname,
    content,
    timestamp: chatLocalTime(now),
    is_image: image,
  };
  if (socket) {
    broker.publish(destination, {
      ...response,
      timestamp: typeof input.timestamp === 'string' ? input.timestamp : null,
    });
    broker.publish(`/topic/chatroom/list/${otherId}`, await listCommunityChatRooms(db, otherId));
  }
  return response;
}

export async function dispatchCommunityChat(env: Bindings, broker: ChatBroker, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const userId = Number(request.headers.get('X-Community-User'));
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new ApiError(401, 'UNAUTHORIZED_USER', '인증이 필요합니다.');
  const db = createDatabase(env.DB);
  if (request.method === 'GET' && url.pathname === '/chatroom/lost-item') {
    return Response.json(await listCommunityChatRooms(db, userId));
  }
  const match = /^\/(v2\/)?chatroom\/lost-item\/(\d+)(?:\/(\d+))?(?:\/(messages|leave|block|unblock))?$/.exec(
    url.pathname,
  );
  if (!match) throw new ApiError(404, 'NO_HANDLER_FOUND', '유효하지 않은 API 경로입니다.');
  const articleId = Number(match[2]);
  let roomId = Number(match[3]);
  const action = match[4];
  if (!match[3] && request.method === 'POST') {
    const [existing] = await db.all<ChatRoom>(sql`SELECT * FROM ${schema.lost_item_chat_room}
      WHERE article_id=${articleId} AND item_owner_id=${userId}`);
    if (existing) return Response.json(await roomDetail(db, existing, userId), { status: 201 });
    const [article] = await db.all<{
      author_id: number | null;
    }>(sql`SELECT u.id author_id FROM ${schema.lost_item_articles} l
      JOIN ${schema.new_articles} a ON a.id=l.article_id AND a.is_deleted=0
      LEFT JOIN ${schema.users} u ON u.id=l.author_id AND u.is_deleted=0
      WHERE l.article_id=${articleId}`);
    if (!article) throw new ApiError(404, 'NOT_FOUND_ARTICLE', '게시글이 존재하지 않습니다.');
    if (article.author_id === null) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
    if (article.author_id === userId)
      throw new ApiError(400, 'INVALID_SELF_CHAT', '자신이 올린 게시글에 메시지를 보낼 수 없습니다.');
    await db.run(sql`INSERT INTO ${schema.lost_item_chat_room}
      (_id,article_id,chatroom_id,article_author_id,item_owner_id,created_at,messages)
      SELECT ${crypto.randomUUID()},${articleId},coalesce(max(chatroom_id),0)+1,${article.author_id},${userId},${new Date().toISOString()},'[]'
      FROM ${schema.lost_item_chat_room} WHERE article_id=${articleId}
      ON CONFLICT(article_id,item_owner_id) DO NOTHING`);
    const [created] = await db.all<ChatRoom>(sql`SELECT * FROM ${schema.lost_item_chat_room}
      WHERE article_id=${articleId} AND item_owner_id=${userId}`);
    if (!created) throw new Error('Chat room insert did not produce a room');
    roomId = created.chatroom_id;
  }
  const room = await getCommunityChatRoom(db, articleId, roomId, userId);
  if (!action)
    return Response.json(await roomDetail(db, room, userId), { status: request.method === 'POST' ? 201 : 200 });
  if (action === 'block' || action === 'unblock') {
    if (action === 'block') {
      await db.run(sql`INSERT INTO ${schema.lost_item_chat_user_block} (_id,blocker_user_id,blocked_user_id,is_active,created_at)
        VALUES (${crypto.randomUUID()},${userId},${chatPartner(room, userId)},1,${new Date().toISOString()})
        ON CONFLICT(blocker_user_id,blocked_user_id) DO UPDATE SET is_active=1`);
    } else {
      await db.run(sql`UPDATE ${schema.lost_item_chat_user_block} SET is_active=0
        WHERE blocker_user_id=${userId} AND blocked_user_id=${chatPartner(room, userId)}`);
    }
    return new Response(null, { status: action === 'block' ? 201 : 200 });
  }
  if (action === 'leave') {
    await db.run(sql`DELETE FROM ${schema.native_chat_polling_session}
      WHERE article_id=${articleId} AND chatroom_id=${roomId} AND user_id=${userId}`);
    return new Response(null, { status: 200 });
  }
  if (request.method === 'GET') return Response.json(await history(db, articleId, roomId, userId, Boolean(match[1])));
  const input: unknown = await request.json();
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new ApiError(400, 'INVALID_REQUEST', '잘못된 요청입니다.');
  return Response.json(
    await sendCommunityChatMessage(env, broker, room, userId, input as Record<string, unknown>, false),
  );
}

export function registerCommunityChat(app: Hono<ApiEnv>): void {
  const paths = [
    ['POST', '/chatroom/lost-item/:articleId'],
    ['GET', '/chatroom/lost-item/:articleId/:chatRoomId'],
    ['GET', '/chatroom/lost-item/:articleId/:chatRoomId/messages'],
    ['GET', '/chatroom/lost-item'],
    ['POST', '/chatroom/lost-item/:articleId/:chatRoomId/block'],
    ['DELETE', '/chatroom/lost-item/:articleId/:chatRoomId/unblock'],
    ['GET', '/v2/chatroom/lost-item/:articleId/:chatRoomId/messages'],
    ['POST', '/v2/chatroom/lost-item/:articleId/:chatRoomId/messages'],
    ['POST', '/v2/chatroom/lost-item/:articleId/:chatRoomId/leave'],
  ] as const;
  for (const [method, path] of paths) {
    app.on(method, path, async (c) => {
      const principal = requirePrincipal(c, ['GENERAL', 'STUDENT', 'COUNCIL']);
      const headers = new Headers(c.req.raw.headers);
      headers.set('X-Community-User', String(principal.id));
      const stub = c.env.COMMUNITY_CHAT.get(c.env.COMMUNITY_CHAT.idFromName('lost-item-chat'));
      return stub.fetch(new Request(c.req.raw, { headers }));
    });
  }
  app.get('/ws-stomp', (c) =>
    c.env.COMMUNITY_CHAT.get(c.env.COMMUNITY_CHAT.idFromName('lost-item-chat')).fetch(c.req.raw),
  );
}

export async function handleCommunityChatJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'community.chat.notification') return false;
  const db = createDatabase(env.DB);
  const [event] = await db.all<{ id: string; receiver_id: number; payload: string }>(sql`
    SELECT id,receiver_id,payload FROM ${schema.native_chat_outbox} WHERE id=${job.key} AND delivered_at IS NULL`);
  if (!event) return true;
  const data = JSON.parse(event.payload) as {
    articleId: number;
    roomId: number;
    senderId: number;
    content: string | null;
  };
  const [recipient] = await db.all<{ device_token: string | null }>(sql`SELECT u.device_token FROM ${schema.users} u
    WHERE u.id=${event.receiver_id} AND u.is_deleted=0 AND EXISTS
    (SELECT 1 FROM ${schema.notification_subscribe} s WHERE s.user_id=u.id AND s.subscribe_type='LOST_ITEM_CHAT' AND s.detail_type IS NULL)`);
  if (recipient?.device_token !== null && recipient?.device_token !== undefined) {
    const [sender] = await db.all<{ nickname: string | null }>(
      sql`SELECT nickname FROM ${schema.users} WHERE id=${data.senderId} AND is_deleted=0`,
    );
    if (!sender) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
    const title = `${sender.nickname ?? 'null'}님의 메시지`;
    const scheme = `chat?articleId=${data.articleId}&chatRoomId=${data.roomId}`;
    await deliverNotification(env, {
      userId: event.receiver_id,
      title,
      message: data.content ?? '',
      mobileAppPath: 'CHAT',
      schemeUri: scheme,
      type: 'MESSAGE',
    });
  }
  await db.run(
    sql`UPDATE ${schema.native_chat_outbox} SET delivered_at=${Date.now()} WHERE id=${event.id} AND delivered_at IS NULL`,
  );
  return true;
}

export async function runCommunityChatCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (Math.floor(scheduledTime / 60000) % 5 !== 0) return;
  const db = createDatabase(env.DB);
  await db.run(sql`DELETE FROM ${schema.native_chat_polling_session} WHERE expires_at<=${scheduledTime}`);
  const events = await db.all<{ id: string }>(
    sql`SELECT id FROM ${schema.native_chat_outbox} WHERE delivered_at IS NULL ORDER BY created_at LIMIT 100`,
  );
  for (const event of events) await env.JOBS.send({ kind: 'community.chat.notification', key: event.id, payload: {} });
}
