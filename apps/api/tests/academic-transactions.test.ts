import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { lectureImportStatement } from '@api/domains/academic/catalog';

const lecture = (code: string, lectureClass = '01') => ({
  code,
  name: '운영체제',
  grades: '3',
  lecture_class: lectureClass,
  regular_number: '40',
  department: '컴퓨터공학부',
  target: '3학년',
  professor: null,
  is_english: 'N',
  design_score: '0',
  is_elearning: 'N',
  class_time: '[0, 1]',
});

test('lecture batch import inserts every row and rejects a partially duplicate batch atomically', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`create table lectures (
      id integer primary key autoincrement, semester_date text not null, code text not null, name text not null, grades text not null,
      class text not null, regular_number text not null, department text not null, target text not null, professor text,
      is_english text not null, design_score text not null, is_elearning text not null, class_time text not null
    )`);
    const dialect = new SQLiteSyncDialect();
    const first = dialect.sqlToQuery(
      lectureImportStatement('20261', JSON.stringify([lecture('CSE001'), lecture('CSE002')])),
    );
    assert.equal(db.prepare(first.sql).all(...(first.params as SQLInputValue[])).length, 2);
    const conflict = dialect.sqlToQuery(
      lectureImportStatement('20261', JSON.stringify([lecture('CSE003'), lecture('CSE002')])),
    );
    assert.equal(db.prepare(conflict.sql).all(...(conflict.params as SQLInputValue[])).length, 0);
    assert.deepEqual(
      db
        .prepare('select code from lectures order by id')
        .all()
        .map((row) => row.code),
      ['CSE001', 'CSE002'],
    );
    const otherClass = dialect.sqlToQuery(lectureImportStatement('20261', JSON.stringify([lecture('CSE001', '02')])));
    assert.equal(db.prepare(otherClass.sql).all(...(otherClass.params as SQLInputValue[])).length, 1);
    const otherSemester = dialect.sqlToQuery(lectureImportStatement('20262', JSON.stringify([lecture('CSE001')])));
    assert.equal(db.prepare(otherSemester.sql).all(...(otherSemester.params as SQLInputValue[])).length, 1);
    const large = dialect.sqlToQuery(
      lectureImportStatement('20261', JSON.stringify(Array.from({ length: 500 }, (_, index) => lecture(`L${index}`)))),
    );
    assert.equal(db.prepare(large.sql).all(...(large.params as SQLInputValue[])).length, 500);
    assert.equal(db.prepare('select count(*) as count from lectures').get()?.count, 504);
  } finally {
    db.close();
  }
});
