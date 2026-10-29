import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '@api/errors';
import {
  chatLocalTime,
  chatMessageResponse,
  chatPartner,
  compareChatMessageIds,
  nextChatTsid,
  type ChatRoom,
} from '@api/domains/community/chat';

const room: ChatRoom = {
  article_id: 14465,
  chatroom_id: 1,
  article_author_id: 5665,
  item_owner_id: 7132,
  created_at: '2025-01-18T11:08:10.000Z',
};

test('chat partner selection is symmetric and excludes nonparticipants', () => {
  assert.equal(chatPartner(room, 5665), 7132);
  assert.equal(chatPartner(room, 7132), 5665);
  assert.throws(
    () => chatPartner(room, 9000),
    (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN_AUTHOR',
  );
});

test('TSID generation preserves all bits beyond the JavaScript safe integer range', () => {
  const now = Date.UTC(2026, 9, 28);
  const first = nextChatTsid(now, null);
  assert.equal(BigInt(first), (BigInt(now) - 1577836800000n) << 22n);
  assert.ok(BigInt(first) > BigInt(Number.MAX_SAFE_INTEGER));
  const second = nextChatTsid(now, first);
  assert.equal(BigInt(second) - BigInt(first), 1n);
  const afterClockRollback = nextChatTsid(now - 10000, second);
  assert.equal(BigInt(afterClockRollback), BigInt(second) + 1n);
  assert.equal(BigInt(nextChatTsid(now + 1, afterClockRollback)), BigInt(first) + (1n << 22n));
});

test('imported and native message IDs sort numerically without rounding or lexical errors', () => {
  const ids = ['9007199254740993', '10', '9007199254740992', '9', '1032000000000000001'];
  assert.deepEqual(ids.sort(compareChatMessageIds), [
    '9',
    '10',
    '9007199254740992',
    '9007199254740993',
    '1032000000000000001',
  ]);
  assert.equal(compareChatMessageIds('1032000000000000001', '1032000000000000001'), 0);
});

test('persisted UTC instants produce source KST LocalDateTime on every host timezone', () => {
  assert.equal(chatLocalTime('2025-01-18T15:08:10.644Z'), '2025-01-19T00:08:10.644');
  assert.equal(chatLocalTime('2025-01-18 15:08:10.644'), '2025-01-19T00:08:10.644');
});

test('history returns the original message DTO without leaking internal read and sequence state', () => {
  assert.deepEqual(
    chatMessageResponse({
      id: '1032000000000000001',
      user_id: 5665,
      nick_name: '코인',
      contents: 'https://static.example/image.jpg',
      created_at: '2025-01-18T11:08:10.644Z',
      is_image: 1,
      is_read: 0,
    }),
    {
      user_id: 5665,
      user_nickname: '코인',
      content: 'https://static.example/image.jpg',
      timestamp: '2025-01-18T20:08:10.644',
      is_image: true,
    },
  );
  assert.equal(
    chatMessageResponse({
      id: '1',
      user_id: 1,
      nick_name: null,
      contents: null,
      created_at: '2025-01-01T00:00:00.000Z',
      is_image: null,
      is_read: 1,
    }).is_image,
    null,
  );
});
