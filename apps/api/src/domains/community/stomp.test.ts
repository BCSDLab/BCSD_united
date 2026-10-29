import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '@api/errors';
import {
  assertChatListDestination,
  encodeStomp,
  parseChatDestination,
  parseStomp,
  type StompFrame,
} from '@api/domains/community/stomp';

const encoder = new TextEncoder();

function combine(first: Uint8Array, second: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);
  return bytes;
}

test('STOMP content-length counts UTF-8 bytes and permits embedded NUL in bodies', () => {
  const frame: StompFrame = {
    command: 'SEND',
    headers: { destination: '/app/chat/14465/1' },
    body: '분실물\0찾았습니다',
  };
  const wire = encodeStomp(frame);
  assert.ok(wire.includes(`content-length:${encoder.encode(frame.body).length}\n`));
  const parsed = parseStomp(encoder.encode(wire));
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0]?.body, frame.body);
  assert.equal(parsed.frames[0]?.headers.destination, frame.headers.destination);
  assert.equal(parsed.remainder.length, 0);
});

test('a frame can be split at every byte including multibyte text and headers', () => {
  const wire = encoder.encode(
    encodeStomp({ command: 'SEND', headers: { destination: '/app/chat/10/2' }, body: '안녕하세요' }),
  );
  for (let split = 0; split < wire.length; split++) {
    const first = parseStomp(wire.slice(0, split));
    assert.equal(first.frames.length, 0);
    const second = parseStomp(combine(first.remainder, wire.slice(split)));
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames[0]?.body, '안녕하세요');
    assert.equal(second.remainder.length, 0);
  }
});

test('heartbeat and coalesced CRLF frames retain ordering and first repeated header', () => {
  const wire =
    '\n\r\nSUBSCRIBE\r\nid:one\r\ndestination:/topic/chat/10/1\r\ndestination:/topic/chat/999/999\r\n\r\n\0' +
    '\nUNSUBSCRIBE\nid:one\n\n\0\n';
  const result = parseStomp(encoder.encode(wire));
  assert.deepEqual(
    result.frames.map((frame) => frame.command),
    ['SUBSCRIBE', 'UNSUBSCRIBE'],
  );
  assert.equal(result.frames[0]?.headers.destination, '/topic/chat/10/1');
  assert.equal(result.remainder.length, 0);
});

test('header escaping round trips colon, backslash and CRLF without header injection', () => {
  const value = 'a:b\\c\r\ndestination:/topic/chat/99/99';
  const wire = encodeStomp({ command: 'MESSAGE', headers: { 'custom:header': value }, body: '' });
  const [frame] = parseStomp(encoder.encode(wire)).frames;
  assert.equal(frame?.headers['custom:header'], value);
  assert.equal(frame?.headers.destination, undefined);
  assert.throws(() => parseStomp(encoder.encode('SEND\ninvalid:a\\q\n\n\0')), ApiError);
});

test('CONNECT native JWT headers are not unescaped and missing version selects source STOMP 1.0 syntax', () => {
  const [connect] = parseStomp(encoder.encode('CONNECT\nAuthorization:raw.jwt.signature\n\n\0')).frames;
  assert.equal(connect?.headers.Authorization, 'raw.jwt.signature');
  const [legacy] = parseStomp(encoder.encode('SEND\ncustom:a\\nb\n\nbody\0'), '1.0').frames;
  assert.equal(legacy?.headers.custom, 'a\\nb');
});

test('invalid lengths, missing terminators and oversized frames cannot desynchronize parsing', () => {
  assert.throws(() => parseStomp(encoder.encode('SEND\ncontent-length:-1\n\n\0')), ApiError);
  assert.throws(() => parseStomp(encoder.encode('SEND\ncontent-length:2\n\nabX')), ApiError);
  assert.throws(() => parseStomp(encoder.encode('SEND\ncontent-length:999999999999\n\n')), ApiError);
  assert.equal(parseStomp(encoder.encode('SEND\ncontent-length:5\n\nab')).frames.length, 0);
  assert.throws(() => parseStomp(encoder.encode('SEND\n\n' + 'x'.repeat(128 * 1024 + 1))), ApiError);
});

test('room destinations are exact, positive and integer safe', () => {
  assert.deepEqual(parseChatDestination('/topic/chat/14465/1'), { articleId: 14465, roomId: 1 });
  assert.deepEqual(parseChatDestination('/app/chat/14465/1', true), { articleId: 14465, roomId: 1 });
  for (const destination of [
    '/topic/chat/0/1',
    '/topic/chat/1/-1',
    '/topic/chat/1/2/other',
    '/topic/chat/9007199254740993/1',
    '/app/chat/1/2',
  ]) {
    assert.throws(() => parseChatDestination(destination), ApiError);
  }
});

test('room-list subscriptions belong only to the authenticated user', () => {
  assert.doesNotThrow(() => assertChatListDestination('/topic/chatroom/list/5665', 5665));
  for (const destination of [
    '/topic/chatroom/list/7132',
    '/topic/chatroom/list/5665/extra',
    '/topic/chatroom/list/05665',
  ]) {
    assert.throws(
      () => assertChatListDestination(destination, 5665),
      (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN_AUTHOR',
    );
  }
});
