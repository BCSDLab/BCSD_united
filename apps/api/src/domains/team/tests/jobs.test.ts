import assert from 'node:assert/strict';
import test from 'node:test';
import { executeAtomic } from '@api/db/client';
import { backoffSeconds, claimStatements, completeStatement, deadlineDelaySeconds, deadlineStatements, failureStatement, handleTeamJob, inboxMatches, outboxConfiguration, parseOutboxPayload, renewLeaseStatement, retryablePushError, TEAM_DEADLINE_JOB } from '@api/domains/team/jobs';
import { teamDatabase } from '@api/domains/team/tests/database';
import { FcmError } from '@api/integrations/push';
import { deadlineScheduleStatement } from '@api/domains/team/chat';
import type { Bindings } from '@api/runtime';

const config = outboxConfiguration({});
const start = Date.parse('2026-10-28T00:00:00Z');
const encoded = JSON.stringify({ type: 'NEW_APPLICATION', target_type: 'APPLICANT_MANAGEMENT', recipient_id: 2, recruitment_id: 1, application_id: 3, chat_room_id: null, notification_id: 4 });

test('outbox configuration clamps source limits and exponential retry cap', () => {
  const bounded = outboxConfiguration({ TEAM_RECRUITMENT_OUTBOX_BATCH_SIZE: '1000', TEAM_RECRUITMENT_OUTBOX_MAX_ATTEMPTS: '0',
    TEAM_RECRUITMENT_OUTBOX_RETRY_BACKOFF_SECONDS: '120', TEAM_RECRUITMENT_OUTBOX_MAX_RETRY_BACKOFF_SECONDS: '10' });
  assert.equal(bounded.batchSize, 100);
  assert.equal(bounded.maxAttempts, 1);
  assert.equal(bounded.maxRetryBackoffSeconds, 120);
  assert.equal(backoffSeconds(1, config), 30);
  assert.equal(backoffSeconds(5, config), 480);
  assert.equal(backoffSeconds(100, config), 3600);
  assert.throws(() => outboxConfiguration({ TEAM_RECRUITMENT_OUTBOX_LEASE_SECONDS: 'NaN' }));
});

test('payload validation and inbox matching reject cross-user and cross-target delivery', () => {
  const payload = parseOutboxPayload(encoded);
  const inbox = { id: 4, recipient_id: 2, type: 'NEW_APPLICATION', target_type: 'APPLICANT_MANAGEMENT', recruitment_id: 1,
    application_id: 3, chat_room_id: null, is_deleted: 0, message_preview: '알림' };
  assert.equal(inboxMatches(inbox, payload), true);
  assert.equal(inboxMatches({ ...inbox, recipient_id: 9 }, payload), false);
  assert.equal(inboxMatches({ ...inbox, application_id: null }, payload), false);
  for (const invalid of ['{', 'null', JSON.stringify({ ...payload, recipient_id: '2' }), JSON.stringify({ ...payload, recipient_id: 2147483648 }), JSON.stringify({ ...payload, type: '__proto__' })]) {
    assert.throws(() => parseOutboxPayload(invalid));
  }
  assert.equal(retryablePushError(new FcmError('INVALID_ARGUMENT', '', 400, false, null)), false);
  assert.equal(retryablePushError(new FcmError('UNAVAILABLE', '', 503, true, null)), true);
});

test('duplicate queue claims, expired leases and stale completion are fenced', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    sqlite.prepare(`INSERT INTO team_recruitment_outbox_event (id,event_key,event_type,payload,status,attempt_count) VALUES (1,'event','TEAM_RECRUITMENT_NOTIFICATION',?,'PENDING',0)`).run(encoded);
    const first = await executeAtomic(db, claimStatements('event', 'worker-a', start, config));
    assert.equal(first[1]!.results.length, 1);
    const duplicate = await executeAtomic(db, claimStatements('event', 'worker-b', start + 1000, config));
    assert.equal(duplicate[1]!.results.length, 0);
    const renewed = await executeAtomic(db, claimStatements('event', 'worker-b', start + 121000, config));
    assert.equal(renewed[1]!.results.length, 1);
    await executeAtomic(db, [completeStatement(1, 'worker-a', start + 122000)]);
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment_outbox_event').get()!.status, 'PROCESSING');
    await executeAtomic(db, [completeStatement(1, 'worker-b', start + 123000)]);
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment_outbox_event').get()!.status, 'PUBLISHED');
    assert.equal((await executeAtomic(db, claimStatements('event', 'worker-c', start + 300000, config)))[1]!.results.length, 0);
  } finally { sqlite.close(); }
});

test('retry backoff prevents early claims and terminal failure cannot be reclaimed', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    sqlite.exec(`INSERT INTO team_recruitment_outbox_event (id,event_key,event_type,payload,status,attempt_count) VALUES (1,'event','TEAM_RECRUITMENT_NOTIFICATION','{}','PENDING',0);`);
    await executeAtomic(db, claimStatements('event', 'worker-a', start, config));
    await executeAtomic(db, [failureStatement(1, 'worker-a', 1, 'UNAVAILABLE', true, start, config)]);
    assert.equal((await executeAtomic(db, claimStatements('event', 'early', start + 29999, config)))[1]!.results.length, 0);
    assert.equal((await executeAtomic(db, claimStatements('event', 'worker-b', start + 30000, config)))[1]!.results.length, 1);
    await executeAtomic(db, [failureStatement(1, 'worker-b', 2, 'UNREGISTERED', false, start + 30000, config)]);
    assert.equal(sqlite.prepare('SELECT attempt_count FROM team_recruitment_outbox_event').get()!.attempt_count, 5);
    assert.equal((await executeAtomic(db, claimStatements('event', 'later', start + 1000000, config)))[1]!.results.length, 0);
  } finally { sqlite.close(); }
});

test('deadline close is inclusive through deadline day and rolls back missing accepted-member room', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    sqlite.exec(`INSERT INTO team_recruitment VALUES (1,'팀 모집','RECRUITING','2026-10-28',NULL);
      INSERT INTO team_recruitment_application VALUES (1,1,2,'PENDING',NULL,NULL),(2,1,3,'ACCEPTED',NULL,NULL);`);
    await executeAtomic(db, deadlineStatements(db, 1, '2026-10-28'));
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment').get()!.status, 'RECRUITING');
    await assert.rejects(executeAtomic(db, deadlineStatements(db, 1, '2026-10-29')));
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment_application WHERE id=1').get()!.status, 'PENDING');
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_notification').get()!.total, 0);
    sqlite.exec(`INSERT INTO team_recruitment_chat_room VALUES (10,1,'TEAM','TEAM');`);
    await executeAtomic(db, deadlineStatements(db, 1, '2026-10-29'));
    await executeAtomic(db, deadlineStatements(db, 1, '2026-10-29'));
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment').get()!.status, 'CLOSED');
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_notification').get()!.total, 2);
  } finally { sqlite.close(); }
});

test('dispatch renewal rejects expired ownership and extends only a live lease', async () => {
  const { db, sqlite } = teamDatabase();
  try {
    sqlite.exec(`INSERT INTO team_recruitment_outbox_event (id,event_key,event_type,payload,status,attempt_count) VALUES (1,'event','TEAM_RECRUITMENT_NOTIFICATION','{}','PENDING',0);`);
    await executeAtomic(db, claimStatements('event', 'worker-a', start, config));
    assert.equal((await executeAtomic(db, [renewLeaseStatement(1, 'worker-b', start + 1000, 120)]))[0]!.results.length, 0);
    assert.equal((await executeAtomic(db, [renewLeaseStatement(1, 'worker-a', start + 121000, 120)]))[0]!.results.length, 0);
    await executeAtomic(db, claimStatements('event', 'worker-b', start + 121000, config));
    assert.equal((await executeAtomic(db, [renewLeaseStatement(1, 'worker-b', start + 200000, 120)]))[0]!.results.length, 1);
    assert.equal((await executeAtomic(db, claimStatements('event', 'worker-c', start + 242000, config)))[1]!.results.length, 0);
  } finally { sqlite.close(); }
});

test('durable deadline signals relay at twelve hours and obsolete dates cannot close an updated recruitment', async () => {
  const { db, sqlite } = teamDatabase();
  const delivered: { job: unknown; delaySeconds?: number }[] = [];
  const env = { DB: db.$client, JOBS: { send: async (job: unknown, options?: { delaySeconds?: number }) => {
    delivered.push({ job, delaySeconds: options?.delaySeconds });
  } } } as unknown as Bindings;
  try {
    assert.equal(deadlineDelaySeconds('2026-10-28 00:00:00', start), 0);
    assert.equal(deadlineDelaySeconds('2099-10-28 00:00:00', start), 43200);
    sqlite.exec(`INSERT INTO team_recruitment VALUES (1,'팀 모집','RECRUITING','2099-10-28',NULL);`);
    await executeAtomic(db, [deadlineScheduleStatement(1)]);
    await executeAtomic(db, [deadlineScheduleStatement(1)]);
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_outbox_event').get()!.total, 1);
    await handleTeamJob(env, { kind: TEAM_DEADLINE_JOB, key: 'team-recruitment:deadline:1:2099-10-28', payload: {} });
    assert.equal(delivered[0]!.delaySeconds, 43200);
    sqlite.exec(`UPDATE team_recruitment SET deadline_date='2099-10-29';`);
    await handleTeamJob(env, { kind: TEAM_DEADLINE_JOB, key: 'team-recruitment:deadline:1:2099-10-28', payload: {} });
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment').get()!.status, 'RECRUITING');
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment_outbox_event').get()!.status, 'PUBLISHED');
  } finally { sqlite.close(); }
});

test('due deadline queue delivery closes once and signals its durable notification immediately', async () => {
  const { db, sqlite } = teamDatabase();
  const delivered: unknown[] = [];
  const env = { DB: db.$client, JOBS: { send: async (job: unknown) => { delivered.push(job); } } } as unknown as Bindings;
  try {
    sqlite.exec(`INSERT INTO team_recruitment VALUES (1,'팀 모집','RECRUITING','2020-01-01',NULL);
      INSERT INTO team_recruitment_application VALUES (1,1,2,'PENDING',NULL,NULL);`);
    await executeAtomic(db, [deadlineScheduleStatement(1)]);
    const job = { kind: TEAM_DEADLINE_JOB, key: 'team-recruitment:deadline:1:2020-01-01', payload: {} };
    await handleTeamJob(env, job);
    await handleTeamJob(env, job);
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment').get()!.status, 'CLOSED');
    assert.equal(sqlite.prepare('SELECT count(*) total FROM team_recruitment_notification').get()!.total, 1);
    assert.equal(delivered.length, 1);
  } finally { sqlite.close(); }
});
