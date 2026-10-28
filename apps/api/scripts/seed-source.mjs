import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mysqlValue, rowInsert } from './transform.mjs';

const [output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node seed-source.mjs OUTPUT.sql; generated SQL is only for a fresh empty database, never imported production data.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(resolve(root, 'scripts/source-schema.json'), 'utf8'));
const seeds = JSON.parse(await readFile(resolve(root, 'scripts/source-seeds.json'), 'utf8'));
const order = ['department', 'major', 'academic_program_year', 'department_contact_departments', 'department_contacts', 'dining_soldout_report_sequence'];
const sql = ["PRAGMA defer_foreign_keys=ON;", "INSERT INTO native_dining_assert(id,valid) SELECT 'seed-catalog',CASE WHEN NOT EXISTS(SELECT 1 FROM department) AND NOT EXISTS(SELECT 1 FROM major) AND NOT EXISTS(SELECT 1 FROM academic_program_year) AND NOT EXISTS(SELECT 1 FROM department_contact_departments) AND NOT EXISTS(SELECT 1 FROM department_contacts) AND NOT EXISTS(SELECT 1 FROM dining_soldout_report_sequence WHERE id<>1 OR last_sequence<>'0') THEN 1 ELSE 0 END;", 'DELETE FROM dining_soldout_report_sequence;'];
for (const table of order) for (const record of seeds.tables[table]) {
  const row = Object.fromEntries(Object.entries(record).map(([name, value]) => {
    const column = source.columns.find(candidate => candidate.table === table && candidate.name === name);
    if (!column || column.expression) throw new Error(`Unexpected seed field ${table}.${name}`);
    return [name, mysqlValue(column, value, '+00:00')];
  }));
  sql.push(rowInsert(table, row));
}
sql.push("DELETE FROM native_dining_assert WHERE id='seed-catalog';");
await writeFile(resolve(output), sql.join('\n') + '\n', { flag: 'wx' });
