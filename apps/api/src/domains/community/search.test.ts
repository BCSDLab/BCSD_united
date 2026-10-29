import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import {
  ngrams,
  parseSearch,
  replaceTitleIndex,
  searchMatches,
  searchWeightExpression,
  titleSearch,
} from '@api/domains/community/search';

const dialect = new SQLiteSyncDialect();
test('Korean boolean ngrams require consecutive token sequences rather than unordered tokens', () => {
  assert.equal(searchMatches('수강신청 일정 안내', '수강신청'), true);
  assert.equal(searchMatches('수강 변경 신청 안내', '수강신청'), false);
  assert.equal(searchMatches('장학금 신청 공지', '장학금 등록'), true);
  assert.equal(searchMatches('장학금 신청 공지', '+장학금 +등록'), false);
  assert.equal(searchMatches('장학금 신청 공지', '+장학금 -신청'), false);
  assert.equal(searchMatches('장학금 공지', '-신청'), false);
});
test('one-character trailing wildcard matches indexed token beginnings, not arbitrary substring', () => {
  assert.equal(searchMatches('학사 공지', '학'), true);
  assert.equal(searchMatches('장학', '학'), false);
  assert.equal(searchMatches('장학', '장'), true);
  assert.equal(searchMatches('학', '학'), false);
});
test('ngram indexing excludes contained InnoDB stopwords and preserves candidate positions', () => {
  assert.deepEqual(ngrams('abc def'), [
    { token: 'bc', position: 1 },
    { token: 'ef', position: 3 },
  ]);
  assert.equal(searchMatches('ab bc de ef', '"abc def"'), true);
  assert.equal(searchMatches('abcdef', '"abc def"'), false);
  assert.deepEqual(ngrams('가 나다'), [{ token: '나다', position: 0 }]);
});
test('indexed SQL and pure search agree for Korean groups, exclusions, phrases, and metacharacters', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE new_articles(id INTEGER PRIMARY KEY,title TEXT NOT NULL); CREATE TABLE native_article_ngram(article_id INTEGER,position INTEGER,token TEXT,PRIMARY KEY(article_id,position)); CREATE INDEX gram_token ON native_article_ngram(token,article_id);',
    );
    const titles = [
      '수강신청 일정 안내',
      '수강 변경 신청',
      '장학금 신청 공지',
      '기숙사 장학 공지',
      '학사 일정',
      '가 나다',
      "특강 O'Reilly 안내",
    ];
    titles.forEach((title, index) => {
      db.prepare('INSERT INTO new_articles VALUES(?,?)').run(index + 1, title);
      for (const statement of replaceTitleIndex(index + 1, title)) {
        const query = dialect.sqlToQuery(statement);
        db.prepare(query.sql).run(...(query.params as (string | number | null)[]));
      }
    });
    for (const search of ['수강신청', '+장학 -기숙사', '+(장학 학사) -신청', '학', '"가 나다"', "O'Reilly"]) {
      const query = dialect.sqlToQuery(titleSearch(search));
      const actual = db
        .prepare(`SELECT a.id FROM new_articles a WHERE ${query.sql} ORDER BY a.id`)
        .all(...(query.params as (string | number | null)[]))
        .map((row) => row.id);
      const expected = titles.flatMap((title, index) => (searchMatches(title, search) ? [index + 1] : []));
      assert.deepEqual(actual, expected, search);
    }
    assert.equal(db.prepare('SELECT count(*) count FROM new_articles').get()!.count, titles.length);
  } finally {
    db.close();
  }
});
test('title replacement removes obsolete search tokens atomically', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE native_article_ngram(article_id INTEGER,position INTEGER,token TEXT,PRIMARY KEY(article_id,position));',
    );
    for (const title of ['학생증', '전자제품']) {
      db.exec('BEGIN');
      for (const statement of replaceTitleIndex(7, title)) {
        const query = dialect.sqlToQuery(statement);
        db.prepare(query.sql).run(...(query.params as (string | number | null)[]));
      }
      db.exec('COMMIT');
    }
    assert.deepEqual(
      db
        .prepare('SELECT token FROM native_article_ngram ORDER BY position')
        .all()
        .map((row) => row.token),
      ['전자', '자제', '제품'],
    );
  } finally {
    db.close();
  }
});
test('search limits and decreasing per-IP weights match the source boundaries', () => {
  assert.doesNotThrow(() => parseSearch('가'.repeat(99)));
  assert.throws(() => parseSearch('가'.repeat(100)));
  assert.throws(() => parseSearch('++장학'));
  const db = new DatabaseSync(':memory:');
  try {
    const values = Array.from({ length: 11 }, (_, index) => {
      const query = dialect.sqlToQuery(searchWeightExpression(sql`${index + 1}`));
      return db.prepare(`SELECT ${query.sql} weight`).get(...(query.params as number[]))!.weight;
    });
    assert.deepEqual(values, [1, 0.5, 0.25, 0.125, 0.0625, 0.0625, 0.0625, 0.0625, 0.0625, 0.0625, 0]);
  } finally {
    db.close();
  }
});
