// import-mysql.mjs — 인터널 MySQL → 봇 Postgres 1회 데이터 이행
//
// 대상: track, team, member, team_map, member_withdraw, pr_thread(←thread)
// 전제: 001_directory.sql로 Postgres 스키마가 이미 생성돼 있어야 함.
//
// 정책(기능명세 B-1.1 / B-2):
//  - member.password 미이관
//  - 시드 정정: member 2357 is_active=false, SEED_ADMIN_NAME 멤버 authority='ADMIN'
//  - thread → pr_thread (reminder_sent 제외)
//  - 빈 문자열('') → NULL, tinyint(1) → boolean, id 보존 후 시퀀스 setval
//
// 사용:
//   MYSQL_PORT=3307 PGPORT=5433 SEED_ADMIN_NAME='이준영' pnpm --filter @koin/b-bot-database import:mysql --confirm-destructive
//   (기본값은 로컬 검수 컨테이너: mysql 3307 / postgres 5433)

import mysql from 'mysql2/promise';
import pg from 'pg';
import { format as formatCliOutput } from 'node:util';

if (!process.argv.includes('--confirm-destructive')) {
  throw new Error(
    'This import truncates directory tables. Run import:mysql --confirm-destructive only for an intentional MySQL data replacement.',
  );
}

const MYSQL = {
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3307),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? 'local',
  database: process.env.MYSQL_DATABASE ?? 'bcsdlab',
};
const PG = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'local',
  database: process.env.PGDATABASE ?? 'postgres',
};
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? null;

// 변환 헬퍼
const s = (v) => (v === '' ? null : v); // 빈 문자열 → NULL
const b = (v) => (v === null || v === undefined ? null : Boolean(v)); // tinyint → boolean

async function main() {
  const my = await mysql.createConnection(MYSQL);
  const pc = new pg.Client(PG);
  await pc.connect();
  process.stdout.write(
    formatCliOutput(`MySQL ${MYSQL.host}:${MYSQL.port}/${MYSQL.database} → PG ${PG.host}:${PG.port}/${PG.database}`) +
      '\n',
  );

  // 재실행 가능하도록 대상 비우기 (FK 역순)
  await pc.query('TRUNCATE pr_thread, member_withdraw, team_map, member, team, track RESTART IDENTITY CASCADE');

  // ── track ──
  const [tracks] = await my.query('SELECT * FROM track');
  for (const r of tracks) {
    await pc.query('INSERT INTO track(id,name,is_deleted,created_at,updated_at) VALUES($1,$2,$3,$4,$5)', [
      r.id,
      r.name,
      b(r.is_deleted),
      r.created_at,
      r.updated_at,
    ]);
  }

  // ── team ──
  const [teams] = await my.query('SELECT * FROM team');
  for (const r of teams) {
    await pc.query('INSERT INTO team(id,name,is_deleted,created_at,updated_at) VALUES($1,$2,$3,$4,$5)', [
      r.id,
      s(r.name),
      b(r.is_deleted),
      r.created_at,
      r.updated_at,
    ]);
  }

  // ── member (password 제외, 시드 정정 적용) ──
  const [members] = await my.query('SELECT * FROM member');
  let adminMatched = 0;
  for (const r of members) {
    let isActive = b(r.is_active);
    if (Number(r.id) === 2357) isActive = false; // 정정 #1: active&deleted 모순
    let authority = s(r.authority);
    if (SEED_ADMIN_NAME && r.name === SEED_ADMIN_NAME) {
      authority = 'ADMIN'; // 정정 #4: 본인 첫 관리자
      adminMatched++;
    }
    await pc.query(
      `INSERT INTO member(
        id,name,slack_id,github_name,member_type,track_id,status,authority,
        is_active,is_deleted,is_authed,is_fee_exempt,
        company,department,student_number,email,phone_number,birthday,
        profile_image_url,join_date,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        r.id,
        r.name,
        s(r.slack_id),
        s(r.github_name),
        s(r.member_type),
        r.track_id,
        s(r.status),
        authority,
        isActive,
        b(r.is_deleted),
        b(r.is_authed),
        b(r.is_fee_exempt),
        s(r.company),
        s(r.department),
        s(r.student_number),
        s(r.email),
        s(r.phone_number),
        r.birthday,
        s(r.profile_image_url),
        r.join_date,
        r.created_at,
        r.updated_at,
      ],
    );
  }

  // ── team_map ──
  const [maps] = await my.query('SELECT * FROM team_map');
  for (const r of maps) {
    await pc.query(
      'INSERT INTO team_map(id,member_id,team_id,is_leader,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)',
      [r.id, r.member_id, r.team_id, b(r.is_leader), r.created_at, r.updated_at],
    );
  }

  // ── member_withdraw ──
  const [withdraws] = await my.query('SELECT * FROM member_withdraw');
  for (const r of withdraws) {
    await pc.query(
      'INSERT INTO member_withdraw(id,member_id,reason,withdraw_date,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)',
      [r.id, r.member_id, s(r.reason), r.withdraw_date, r.created_at, r.updated_at],
    );
  }

  // ── thread → pr_thread (reminder_sent 제외) ──
  const [threads] = await my.query('SELECT * FROM thread');
  for (const r of threads) {
    await pc.query(
      'INSERT INTO pr_thread(id,pr_link,ts,reviewer,writer,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, s(r.pr_link), s(r.ts), s(r.reviewer), s(r.writer), s(r.status) ?? 'open', r.created_at, r.updated_at],
    );
  }

  // ── 시퀀스 보정 ──
  for (const t of ['track', 'team', 'member', 'team_map', 'member_withdraw', 'pr_thread']) {
    await pc.query(
      `SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM ${t}), 1))`,
    );
  }

  // ── 검증 출력 ──
  const counts = {};
  for (const t of ['track', 'team', 'member', 'team_map', 'member_withdraw', 'pr_thread']) {
    const { rows } = await pc.query(`SELECT COUNT(*)::int n FROM ${t}`);
    counts[t] = rows[0].n;
  }
  const { rows: act } = await pc.query('SELECT COUNT(*)::int n FROM member WHERE is_active');
  const { rows: adm } = await pc.query("SELECT COUNT(*)::int n FROM member WHERE authority='ADMIN'");
  process.stdout.write(formatCliOutput('이관 행수:', counts) + '\n');
  process.stdout.write(formatCliOutput(`활동 멤버(is_active): ${act[0].n}`) + '\n');
  process.stdout.write(
    formatCliOutput(
      `ADMIN: ${adm[0].n}` +
        (SEED_ADMIN_NAME
          ? ` (SEED_ADMIN_NAME='${SEED_ADMIN_NAME}' 매칭 ${adminMatched}명)`
          : ' (SEED_ADMIN_NAME 미지정)'),
    ) + '\n',
  );

  await my.end();
  await pc.end();
  process.stdout.write(formatCliOutput('✓ 완료') + '\n');
}

main().catch((e) => {
  console.error('✗ 마이그레이션 실패:', e);
  process.exit(1);
});
