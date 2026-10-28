import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { executeAtomic } from '@api/db/client';
import { closureStatements, displayNickname, kstDate, kstTimestamp, messageWindow, notificationStatements, registerTeamChat } from '@api/domains/team/chat';
import { teamDatabase } from '@api/domains/team/tests/database';
import type { ApiEnv } from '@api/runtime';

test('message cursor contract rejects ambiguous, nonpositive and oversized windows', () => {
  assert.deepEqual(messageWindow(undefined, undefined, undefined), { afterId: null, beforeId: null, count: 100 });
  assert.deepEqual(messageWindow('12', undefined, '200'), { afterId: 12, beforeId: null, count: 200 });
  for (const args of [['1', '2', '10'], ['0', undefined, '10'], [undefined, '-1', '10'], [undefined, undefined, '201'], ['1.5', undefined, '10']] as const) {
    assert.throws(() => messageWindow(...args));
  }
});

test('KST rendering preserves source microseconds and nickname withdrawal behavior', () => {
  assert.equal(kstDate(Date.parse('2026-10-27T15:00:00Z')), '2026-10-28');
  assert.equal(kstTimestamp('2026-10-27 15:00:00.123456'), '2026-10-28T00:00:00.123456');
  assert.equal(kstTimestamp(null), null);
  assert.equal(displayNickname(null, 'old name'), '탈퇴한 회원');
  assert.equal(displayNickname(2, '  '), '익명 사용자');
  assert.equal(displayNickname(2, '현재 닉네임'), '현재 닉네임');
});

test('notification inbox and outbox insertion is guarded and idempotent', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    const input = { eventKey: 'team-recruitment:application:1:NEW_APPLICATION', type: 'NEW_APPLICATION' as const,
      targetType: 'APPLICANT_MANAGEMENT', recipientId: 1, recruitmentId: 2, applicationId: 1, messagePreview: '새로운 지원자가 있어요.' };
    await executeAtomic(db, notificationStatements(db, input, sql`0`));
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_notification').get()!.total, 0);
    await executeAtomic(db, notificationStatements(db, input));
    await executeAtomic(db, notificationStatements(db, input));
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_notification').get()!.total, 1);
    const event = sqlite.prepare('SELECT payload FROM team_recruitment_outbox_event').get()!;
    const notification = sqlite.prepare('SELECT id FROM team_recruitment_notification').get()!;
    assert.equal(JSON.parse(String(event.payload)).notification_id, notification.id);
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_outbox_event').get()!.total, 1);
  } finally { sqlite.close(); }
});

test('closure rejects pending applicants, preserves accepted members and deduplicates notices', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    sqlite.exec(`INSERT INTO team_recruitment VALUES (1, '프로젝트', 'CLOSED', NULL, NULL);
      INSERT INTO team_recruitment_application VALUES (1, 1, 2, 'PENDING', NULL, NULL), (2, 1, 3, 'ACCEPTED', NULL, NULL), (3, 1, NULL, 'PENDING', NULL, NULL);
      INSERT INTO team_recruitment_chat_room VALUES (10, 1, 'TEAM', 'TEAM');`);
    await executeAtomic(db, closureStatements(db, 1, 'CAPACITY', sql`1`));
    await executeAtomic(db, closureStatements(db, 1, 'CAPACITY', sql`1`));
    const states = sqlite.prepare('SELECT status, decision_reason FROM team_recruitment_application ORDER BY id').all();
    assert.equal(states[0]!.status, 'REJECTED');
    assert.equal(states[0]!.decision_reason, 'RECRUITMENT_CLOSED');
    assert.equal(states[1]!.status, 'ACCEPTED');
    assert.equal(states[2]!.status, 'REJECTED');
    const notices = sqlite.prepare('SELECT type, target_type, chat_room_id FROM team_recruitment_notification ORDER BY application_id').all();
    assert.equal(notices.length, 2);
    assert.equal(notices[0]!.type, 'APPLICATION_REJECTED');
    assert.equal(notices[0]!.target_type, 'MY_APPLICATIONS');
    assert.equal(notices[1]!.type, 'RECRUITMENT_CLOSED');
    assert.equal(notices[1]!.chat_room_id, 10);
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_outbox_event').get()!.total, 2);
  } finally { sqlite.close(); }
});

test('message endpoint commits message, sender cursor, recipient inbox and outbox together', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    sqlite.exec(`
      ALTER TABLE team_recruitment ADD COLUMN author_id INTEGER;
      ALTER TABLE team_recruitment ADD COLUMN max_participants INTEGER;
      ALTER TABLE team_recruitment_chat_room ADD COLUMN application_id INTEGER;
      CREATE TABLE team_recruitment_profile (user_id INTEGER PRIMARY KEY, profile_nickname TEXT);
      CREATE TABLE team_recruitment_chat_member (id INTEGER PRIMARY KEY, chat_room_id INTEGER, user_id INTEGER, last_read_message_id INTEGER, updated_at TEXT);
      CREATE TABLE team_recruitment_chat_message (id INTEGER PRIMARY KEY, chat_room_id INTEGER, sender_id INTEGER, sender_nickname TEXT, content TEXT, is_image INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO team_recruitment (id,title,status,author_id,max_participants) VALUES (1,'프로젝트','CLOSED',1,3);
      INSERT INTO team_recruitment_chat_room (id,recruitment_id,room_scope_key,room_type) VALUES (10,1,'TEAM','TEAM');
      INSERT INTO team_recruitment_chat_member (id,chat_room_id,user_id) VALUES (1,10,1),(2,10,2);
      INSERT INTO team_recruitment_profile VALUES (1,'팀장'),(2,'팀원');
    `);
    const app = new Hono<ApiEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('principal', { id: 2, userType: 'STUDENT' });
      await next();
    });
    registerTeamChat(app);
    const pending: Promise<unknown>[] = [];
    const delivered: unknown[] = [];
    const env = { SERIALIZED: true, DB: db.$client, JOBS: { send: async (job: unknown) => { delivered.push(job); } } } as unknown as ApiEnv['Bindings'];
    const execution = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
    const response = await app.fetch(new Request('http://localhost/chatroom/team-recruitment/1/10/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '안녕하세요!', is_image: false }),
    }), env, execution);
    await Promise.all(pending);
    assert.equal(delivered.length, 1);
    assert.equal(response.status, 200);
    const message = await response.json() as { message_id: number; unread_count: number; user_nickname: string };
    assert.equal(message.user_nickname, '팀원');
    assert.equal(message.unread_count, 1);
    assert.equal(sqlite.prepare('SELECT last_read_message_id FROM team_recruitment_chat_member WHERE user_id=2').get()!.last_read_message_id, message.message_id);
    const inbox = sqlite.prepare('SELECT recipient_id, sender_nickname FROM team_recruitment_notification').get()!;
    assert.equal(inbox.recipient_id, 1);
    assert.equal(inbox.sender_nickname, '팀원');
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_outbox_event').get()!.total, 1);
    const result = await app.request('/chatroom/team-recruitment/1/10/messages?limit=100');
    assert.equal(result.status, 200);
    assert.equal((await result.json() as unknown[]).length, 1);
  } finally { sqlite.close(); }
});

test('acceptance-triggered capacity rejection uses application-service notification wording', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    sqlite.exec(`INSERT INTO team_recruitment VALUES (1,'프로젝트','CLOSED',NULL,NULL);
      INSERT INTO team_recruitment_application VALUES (1,1,2,'PENDING',NULL,NULL);`);
    await executeAtomic(db, closureStatements(db, 1, 'ACCEPTANCE_CAPACITY', sql`1`));
    assert.equal(sqlite.prepare('SELECT message_preview FROM team_recruitment_notification').get()!.message_preview, '프로젝트 지원이 거절되었어요.');
  } finally { sqlite.close(); }
});
