import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { createDatabase, executeAtomic } from '@api/db/client';
import { buildTeamWithdrawal, decideApplication, updateRecruitment } from '@api/domains/team/core';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../drizzle/0000_source_and_native.sql', import.meta.url), 'utf8'));
  class Statement {
    constructor(readonly query: string, readonly params: SQLInputValue[] = []) {}
    bind(...params: SQLInputValue[]) { return new Statement(this.query, params); }
    async all() {
      const rows = sqlite.prepare(this.query).all(...this.params);
      return { success: true, results: rows, meta: { changes: Number(sqlite.prepare('SELECT changes() AS count').get()!.count) } };
    }
    async raw() { return sqlite.prepare(this.query).all(...this.params).map(row => Object.values(row)); }
    async first(column?: string) { const row = sqlite.prepare(this.query).get(...this.params); return column ? row?.[column] ?? null : row ?? null; }
    async run() { return this.all(); }
  }
  const binding = {
    prepare(query: string) { return new Statement(query); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  for (const id of [1,2,3,4]) {
    sqlite.prepare("INSERT INTO users (id,password,user_type,anonymous_nickname,nickname) VALUES (?,'hash','STUDENT',?,?)").run(id, `anonymous${id}`, `user${id}`);
    sqlite.prepare('INSERT INTO students(user_id) VALUES (?)').run(id);
  }
  sqlite.exec("INSERT INTO team_recruitment(id,author_id,category,title,meeting_type,activity_start_date,activity_end_date,deadline_date,recruitment_type,max_participants,description) VALUES(1,1,'PROJECT','제목','ONLINE','2099-01-01','2099-02-01','2099-01-01','GENERAL',1,'설명')");
  sqlite.exec("INSERT INTO team_recruitment_chat_room(id,recruitment_id,room_scope_key,room_type) VALUES(1,1,'TEAM','TEAM')");
  sqlite.exec('INSERT INTO team_recruitment_chat_member(chat_room_id,user_id) VALUES(1,1)');
  for (const id of [2,3]) sqlite.prepare("INSERT INTO team_recruitment_application(id,recruitment_id,applicant_id,motivation,availability,profile_snapshot) VALUES(?,1,?,'동기','시간','{}')").run(id,id);
  return { sqlite, db:createDatabase(binding) };
}
test('last acceptance atomically closes, joins member, rejects pending and records every outbox effect', async () => {
  const { sqlite,db }=fixture();
  try {
    await decideApplication(db,1,2,1,{status:'ACCEPTED'});
    assert.deepEqual({ ...sqlite.prepare('SELECT status,current_participants FROM team_recruitment WHERE id=1').get() }, {status:'CLOSED',current_participants:1});
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment_application WHERE id=3').get()!.status,'REJECTED');
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM team_recruitment_chat_member WHERE user_id=2').get()!.count,1);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM team_recruitment_notification').get()!.count,3);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM team_recruitment_outbox_event').get()!.count,3);
    await assert.rejects(decideApplication(db,1,3,1,{status:'ACCEPTED'}));
    assert.equal(sqlite.prepare('SELECT current_participants FROM team_recruitment WHERE id=1').get()!.current_participants,1);
  } finally { sqlite.close(); }
});
test('outbox insertion failure rolls back approval, capacity, membership and inbox together',async()=>{
  const {sqlite,db}=fixture();
  try {
    sqlite.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON team_recruitment_outbox_event BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END");
    await assert.rejects(decideApplication(db,1,2,1,{status:'ACCEPTED'}));
    assert.equal(sqlite.prepare('SELECT status FROM team_recruitment_application WHERE id=2').get()!.status,'PENDING');
    assert.equal(sqlite.prepare('SELECT current_participants FROM team_recruitment WHERE id=1').get()!.current_participants,0);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM team_recruitment_chat_member').get()!.count,1);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM team_recruitment_notification').get()!.count,0);
  }finally{sqlite.close();}
});
test('withdrawal decrements accepted counts without reopening and nulls historical author references',async()=>{
  const {sqlite,db}=fixture();
  try {
    await decideApplication(db,1,2,1,{status:'ACCEPTED'});
    await executeAtomic(db,[...await buildTeamWithdrawal(db,2),sql`DELETE FROM users WHERE id=2`]);
    assert.deepEqual({...sqlite.prepare('SELECT status,current_participants FROM team_recruitment WHERE id=1').get()},{status:'CLOSED',current_participants:0});
    assert.equal(sqlite.prepare('SELECT applicant_id FROM team_recruitment_application WHERE id=2').get()!.applicant_id,null);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM team_recruitment_chat_member WHERE user_id=2').get()!.count,0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM team_recruitment_outbox_event WHERE json_extract(payload,'$.recipient_id')=2").get()!.count,0);
  }finally{sqlite.close();}
});
test('any prior application prevents changing the recruitment type',async()=>{
  const {sqlite,db}=fixture();
  try {
    sqlite.exec("UPDATE team_recruitment_application SET status='REJECTED'");
    await assert.rejects(updateRecruitment(db,1,1,{category:'PROJECT',title:'제목',meeting_type:'ONLINE',activity_start_date:'2099-01-01',activity_end_date:'2099-02-01',deadline_date:'2099-01-01',recruitment_type:'ROLE_BASED',roles:[{name:'개발',max_participants:1}],description:'설명'}),{code:'TEAM_RECRUITMENT_TYPE_CHANGE_NOT_ALLOWED'});
    assert.equal(sqlite.prepare('SELECT recruitment_type FROM team_recruitment WHERE id=1').get()!.recruitment_type,'GENERAL');
  }finally{sqlite.close();}
});
