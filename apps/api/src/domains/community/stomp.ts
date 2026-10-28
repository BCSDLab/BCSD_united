import { sql } from 'drizzle-orm';
import { authenticateToken } from '@api/auth';
import { createDatabase } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError, errorResponse } from '@api/errors';
import type { Bindings, Principal } from '@api/runtime';
import {
  dispatchCommunityChat, getCommunityChatRoom, nextChatTsid, sendCommunityChatMessage,
  type ChatBroker,
} from '@api/domains/community/chat';

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_FRAME_BYTES = 128 * 1024;

function decodeHeader(value: string): string {
  return value.replace(/\\(.)/g, (_, char: string) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 'c') return ':';
    if (char === '\\') return '\\';
    throw new ApiError(400, 'INVALID_REQUEST', 'Invalid STOMP header escape');
  });
}

function encodeHeader(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/:/g, '\\c');
}

export function encodeStomp(frame: StompFrame, version = '1.2'): string {
  const escape = version !== '1.0' && frame.command !== 'CONNECTED' && frame.command !== 'CONNECT';
  const headers = { ...frame.headers, 'content-length': String(encoder.encode(frame.body).byteLength) };
  return `${frame.command}\n${Object.entries(headers).map(([key, value]) => `${escape ? encodeHeader(key) : key}:${escape ? encodeHeader(value) : value}`).join('\n')}\n\n${frame.body}\0`;
}

export function parseStomp(bytes: Uint8Array, version = '1.2'): { frames: StompFrame[]; remainder: Uint8Array } {
  const frames: StompFrame[] = [];
  let start = 0;
  while (start < bytes.length) {
    while (bytes[start] === 10 || bytes[start] === 13) start++;
    if (start === bytes.length) break;
    let lineStart = start;
    const lines: string[] = [];
    let bodyStart = -1;
    for (let index = start; index < bytes.length; index++) {
      if (bytes[index] !== 10) continue;
      const end = bytes[index - 1] === 13 ? index - 1 : index;
      if (end === lineStart) { bodyStart = index + 1; break; }
      lines.push(decoder.decode(bytes.subarray(lineStart, end)));
      lineStart = index + 1;
    }
    if (bodyStart < 0) break;
    const command = lines.shift();
    if (!command || !/^[A-Z]+$/.test(command)) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid STOMP command');
    const escaped = version !== '1.0' && command !== 'CONNECT' && command !== 'CONNECTED';
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon <= 0) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid STOMP header');
      const key = escaped ? decodeHeader(line.slice(0, colon)) : line.slice(0, colon);
      const value = escaped ? decodeHeader(line.slice(colon + 1)) : line.slice(colon + 1);
      if (!(key in headers)) headers[key] = value;
    }
    let end: number;
    if (headers['content-length'] !== undefined) {
      const length = headers['content-length'];
      if (!/^\d+$/.test(length) || Number(length) > MAX_FRAME_BYTES) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid STOMP content-length');
      end = bodyStart + Number(length);
      if (end >= bytes.length) break;
      if (bytes[end] !== 0) throw new ApiError(400, 'INVALID_REQUEST', 'STOMP frame must end with NUL');
    } else {
      end = bytes.indexOf(0, bodyStart);
      if (end < 0) break;
    }
    if (end - start > MAX_FRAME_BYTES) throw new ApiError(413, 'INVALID_REQUEST', 'STOMP frame is too large');
    frames.push({ command, headers, body: decoder.decode(bytes.subarray(bodyStart, end)) });
    start = end + 1;
  }
  const remainder = bytes.slice(start);
  if (remainder.length > MAX_FRAME_BYTES) throw new ApiError(413, 'INVALID_REQUEST', 'STOMP frame is too large');
  return { frames, remainder };
}

export function parseChatDestination(destination: string, publish = false): { articleId: number; roomId: number } {
  const match = (publish ? /^\/app\/chat\/(\d+)\/(\d+)$/ : /^\/topic\/chat\/(\d+)\/(\d+)$/).exec(destination);
  if (!match) throw new ApiError(400, 'INVALID_REQUEST', `올바르지 않은 구독 경로입니다: ${destination}`);
  const articleId = Number(match[1]);
  const roomId = Number(match[2]);
  if (!Number.isSafeInteger(articleId) || !Number.isSafeInteger(roomId) || articleId <= 0 || roomId <= 0) {
    throw new ApiError(400, 'INVALID_REQUEST', `올바르지 않은 구독 경로입니다: ${destination}`);
  }
  return { articleId, roomId };
}

export function assertChatListDestination(destination: string, userId: number): void {
  if (destination !== `/topic/chatroom/list/${userId}`) throw new ApiError(403, 'FORBIDDEN_AUTHOR', '게시글 접근 권한이 없습니다.');
}

interface Session {
  id: string;
  principal: Principal | null;
  version: string;
  subscriptions: Record<string, string>;
  status: 'ACTIVE_APP' | 'ACTIVE_CHAT_ROOM' | 'ACTIVE_CHAT_ROOM_LIST' | 'INACTIVE';
  expiresAt: number;
}

export class CommunityChatDurableObject implements ChatBroker {
  private operations: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Bindings) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  async nextId(): Promise<string> {
    let previous = await this.state.storage.get<string>('last-message-id');
    if (previous === undefined) {
      const [last] = await createDatabase(this.env.DB).all<{ id: string }>(sql`
        SELECT id FROM ${schema.native_chat_message} ORDER BY length(id) DESC,id DESC LIMIT 1`);
      previous = last?.id;
    }
    const id = nextChatTsid(Date.now(), previous ?? null);
    await this.state.storage.put('last-message-id', id);
    return id;
  }

  scheduleNotification(id: string): void {
    this.state.waitUntil(this.env.JOBS.send({ kind: 'community.chat.notification', key: id, payload: {} }));
  }

  subscriptionCount(destination: string): number {
    let count = 0;
    for (const socket of this.state.getWebSockets()) {
      const session = socket.deserializeAttachment() as Session;
      if (session.status === 'INACTIVE') continue;
      for (const target of Object.values(session.subscriptions)) if (target === destination) count++;
    }
    return count;
  }

  hasActiveSession(userId: number): boolean {
    return this.state.getWebSockets().some((socket) => {
      const session = socket.deserializeAttachment() as Session;
      return session.principal?.id === userId && session.expiresAt > Date.now()
        && (session.status === 'ACTIVE_CHAT_ROOM' || session.status === 'ACTIVE_CHAT_ROOM_LIST');
    });
  }

  publish(destination: string, body: unknown): void {
    const content = JSON.stringify(body);
    for (const socket of this.state.getWebSockets()) {
      const session = socket.deserializeAttachment() as Session;
      if (session.status === 'INACTIVE') continue;
      for (const [id, target] of Object.entries(session.subscriptions)) {
        if (target !== destination) continue;
        try {
          socket.send(encodeStomp({ command: 'MESSAGE', headers: { destination, subscription: id,
            'message-id': crypto.randomUUID(), 'content-type': 'application/json' }, body: content }, session.version));
        } catch {
          socket.close(1011, 'Message delivery failed');
        }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/ws-stomp') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      const pair = new WebSocketPair();
      const session: Session = { id: crypto.randomUUID(), principal: null, version: '1.2', subscriptions: {},
        status: 'INACTIVE', expiresAt: 0 };
      pair[1].serializeAttachment(session);
      this.state.acceptWebSocket(pair[1]);
      const offered = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((value) => value.trim()) ?? [];
      const protocol = ['v12.stomp', 'v11.stomp', 'v10.stomp'].find((value) => offered.includes(value));
      return new Response(null, { status: 101, webSocket: pair[0], headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {} });
    }
    return this.serial(async () => {
      try {
        return await dispatchCommunityChat(this.env, this, request);
      } catch (error) {
        if (error instanceof ApiError) return errorResponse(error);
        throw error;
      }
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.serial(async () => {
      const session = socket.deserializeAttachment() as Session;
      try {
        const incoming = typeof message === 'string' ? encoder.encode(message) : new Uint8Array(message);
        const pending = await this.state.storage.get<Uint8Array>(`pending:${session.id}`) ?? new Uint8Array();
        const bytes = new Uint8Array(pending.length + incoming.length);
        bytes.set(pending);
        bytes.set(incoming, pending.length);
        const parsed = parseStomp(bytes, session.version);
        if (parsed.remainder.length) await this.state.storage.put(`pending:${session.id}`, parsed.remainder);
        else await this.state.storage.delete(`pending:${session.id}`);
        for (const frame of parsed.frames) {
          await this.processFrame(socket, session, frame);
          if (session.status === 'INACTIVE' && session.principal !== null) break;
        }
        socket.serializeAttachment(session);
      } catch (error) {
        const failure = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_SERVER_ERROR', '메시지 처리 실패');
        socket.send(encodeStomp({ command: 'ERROR', headers: { message: failure.message, 'content-type': 'application/json' },
          body: JSON.stringify({ code: failure.code, message: failure.message, errorTraceId: crypto.randomUUID() }) }, session.version));
        session.status = 'INACTIVE';
        session.subscriptions = {};
        socket.serializeAttachment(session);
        await this.state.storage.delete(`pending:${session.id}`);
        socket.close(1008, failure.code);
      }
    });
  }

  private async processFrame(socket: WebSocket, session: Session, frame: StompFrame): Promise<void> {
    if (frame.command === 'CONNECT' || frame.command === 'STOMP') {
      if (session.principal) throw new ApiError(400, 'INVALID_REQUEST', 'Already connected');
      const token = frame.headers.Authorization;
      if (!token) throw new ApiError(401, 'UNAUTHORIZED_USER', 'Authorization 헤더가 없거나 Bearer 토큰이 아닙니다.');
      const versions = (frame.headers['accept-version'] ?? '1.0').split(',');
      const version = ['1.2', '1.1', '1.0'].find((value) => versions.includes(value));
      if (!version) throw new ApiError(400, 'INVALID_REQUEST', 'Unsupported STOMP version');
      session.principal = await authenticateToken(this.env, token);
      const [user] = await createDatabase(this.env.DB).all<{ device_token: string | null }>(sql`
        SELECT device_token FROM ${schema.users} WHERE id=${session.principal.id} AND is_deleted=0`);
      if (!user) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
      if (user.device_token === null) throw new ApiError(400, 'INVALID_WEBSOCKET_USER_SESSION', '웹소켓 사용자 세션 에러 : deviceToken은 null일 수 없습니다.');
      session.version = version;
      session.status = 'ACTIVE_APP';
      session.expiresAt = Date.now() + 7 * 86400000;
      socket.serializeAttachment(session);
      socket.send(encodeStomp({ command: 'CONNECTED', headers: { version, session: session.id, 'heart-beat': '0,0' }, body: '' }, version));
      return;
    }
    if (!session.principal || session.status === 'INACTIVE') throw new ApiError(401, 'UNAUTHORIZED_USER', '인증이 필요합니다.');
    const userId = session.principal.id;
    const db = createDatabase(this.env.DB);
    if (frame.command === 'SUBSCRIBE') {
      const id = frame.headers.id ?? (session.version === '1.0' ? frame.headers.destination : undefined);
      const destination = frame.headers.destination;
      if (!id || !destination || Object.hasOwn(session.subscriptions, id)) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid subscription');
      if (destination.startsWith('/topic/chatroom/list/')) {
        assertChatListDestination(destination, userId);
        session.status = 'ACTIVE_CHAT_ROOM_LIST';
      } else {
        const target = parseChatDestination(destination);
        await getCommunityChatRoom(db, target.articleId, target.roomId, userId);
        session.status = 'ACTIVE_CHAT_ROOM';
      }
      Object.defineProperty(session.subscriptions, id, { value: destination, writable: true, enumerable: true, configurable: true });
      session.expiresAt = Date.now() + 7 * 86400000;
    } else if (frame.command === 'UNSUBSCRIBE') {
      const id = frame.headers.id ?? frame.headers.destination;
      if (!id || !Object.hasOwn(session.subscriptions, id)) throw new ApiError(400, 'INVALID_REQUEST', 'Unknown subscription');
      delete session.subscriptions[id];
      session.status = 'ACTIVE_APP';
      session.expiresAt = Date.now() + 7 * 86400000;
    } else if (frame.command === 'SEND') {
      const target = parseChatDestination(frame.headers.destination ?? '', true);
      const room = await getCommunityChatRoom(db, target.articleId, target.roomId, userId);
      const body: unknown = JSON.parse(frame.body);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_REQUEST', '잘못된 요청입니다.');
      await sendCommunityChatMessage(this.env, this, room, userId, body as Record<string, unknown>, true);
    } else if (frame.command === 'DISCONNECT') {
      session.subscriptions = {};
      session.status = 'INACTIVE';
    } else {
      throw new ApiError(400, 'INVALID_REQUEST', `Unsupported STOMP command: ${frame.command}`);
    }
    socket.serializeAttachment(session);
    if (frame.headers.receipt) socket.send(encodeStomp({ command: 'RECEIPT', headers: { 'receipt-id': frame.headers.receipt }, body: '' }, session.version));
    if (frame.command === 'DISCONNECT') socket.close(1000, 'Disconnected');
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const session = socket.deserializeAttachment() as Session;
    session.status = 'INACTIVE';
    session.subscriptions = {};
    socket.serializeAttachment(session);
    await this.state.storage.delete(`pending:${session.id}`);
    if (!wasClean) socket.close(code === 1005 || code === 1006 ? 1001 : code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket, 1011, 'WebSocket error', false);
  }
}
