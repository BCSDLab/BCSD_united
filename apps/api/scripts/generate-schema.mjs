import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { nativeTables, nativeExtensions } from './native-schema.mjs';
import { metadataTables } from './source-metadata.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(resolve(root, 'scripts/source-schema.json'), 'utf8'));
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const literal = (value) =>
  value === null
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : typeof value === 'boolean'
        ? value
          ? '1'
          : '0'
        : `'${String(value).replaceAll("'", "''")}'`;
const groups = (rows, key = 'name') => Object.values(Object.groupBy(rows, (row) => row[key]));
const convertExpression = (expression) =>
  expression
    .replace(/_(?:utf8mb4|utf8mb3|latin1)\\'/g, "'")
    .replaceAll("\\'", "'")
    .replace(/char_length\(/gi, 'length(')
    .replace(
      /`issued_at` \+ interval 60 second/gi,
      "(strftime('%Y-%m-%d %H:%M:%S', `issued_at`, '+60 seconds') || substr(`issued_at`,20))",
    );
const currentTime = (column) =>
  column.columnType?.includes('(6)') ? "strftime('%Y-%m-%d %H:%M:%f000', 'now')" : 'CURRENT_TIMESTAMP';
const sqlType = (column) => {
  if (column.type === 'boolean' || ['int', 'smallint', 'tinyint'].includes(column.type)) return 'INTEGER';
  if (['double', 'real'].includes(column.type)) return 'REAL';
  if (column.type === 'binary' && column.length !== 16) return 'BLOB';
  return 'TEXT';
};
const columnDefault = (column) => {
  if (column.default === null) return null;
  if (/^CURRENT_TIMESTAMP(?:\(6\))?$/i.test(column.default)) return currentTime(column);
  if (column.type === 'json' && String(column.default).startsWith('json_array('))
    return `(${convertExpression(column.default)})`;
  return literal(column.default);
};
const checkColumns = (column) => {
  const name = quote(column.name);
  const checks = [];
  if (sqlType(column) === 'INTEGER') checks.push(`${name} IS NULL OR typeof(${name}) = 'integer'`);
  if (sqlType(column) === 'REAL') checks.push(`${name} IS NULL OR typeof(${name}) IN ('real','integer')`);
  if (column.type === 'boolean' || column.columnType === 'tinyint(1)') checks.push(`${name} IN (0, 1)`);
  if (column.columnType?.includes('unsigned')) checks.push(`${name} >= 0 AND ${name} <= 4294967295`);
  if (column.type === 'int' && !column.native && !column.columnType?.includes('unsigned'))
    checks.push(`${name} BETWEEN -2147483648 AND 2147483647`);
  if (column.type === 'int' && column.native) checks.push(`${name} BETWEEN -9007199254740991 AND 9007199254740991`);
  if (column.type === 'smallint') checks.push(`${name} BETWEEN -32768 AND 32767`);
  if (column.type === 'tinyint' && column.columnType !== 'tinyint(1)') checks.push(`${name} BETWEEN -128 AND 127`);
  if (column.type === 'bigint')
    checks.push(`${name} IS NULL OR (typeof(${name}) = 'text' AND ${name} = CAST(CAST(${name} AS INTEGER) AS TEXT))`);
  if (column.type === 'json') checks.push(`${name} IS NULL OR json_valid(${name})`);
  if (column.type === 'varchar') checks.push(`length(${name}) <= ${column.length}`);
  if (column.type === 'binary' && column.length === 16)
    checks.push(
      `length(${name}) = 36 AND substr(${name},9,1) = '-' AND substr(${name},14,1) = '-' AND substr(${name},19,1) = '-' AND substr(${name},24,1) = '-' AND length(replace(${name},'-','')) = 32 AND replace(${name},'-','') NOT GLOB '*[^0-9a-f]*'`,
    );
  if (column.type === 'binary' && column.length !== 16)
    checks.push(`${name} IS NULL OR (typeof(${name}) = 'blob' AND length(${name}) = ${column.length})`);
  if (column.type === 'decimal')
    checks.push(
      `ltrim(${name}, '-') GLOB '*[0-9]*' AND ltrim(${name}, '-') NOT GLOB '*[^0-9.]*' AND length(${name}) - length(replace(${name}, '-', '')) <= 1 AND length(${name}) - length(replace(${name}, '.', '')) <= 1 AND abs(CAST(${name} AS REAL)) < ${10 ** (column.precision - column.scale)} AND (instr(${name}, '.') = 0 OR length(${name}) - instr(${name}, '.') <= ${column.scale})`,
    );
  return checks;
};

const sql = ['PRAGMA defer_foreign_keys = ON;'];
const ts = [
  "import { sql } from 'drizzle-orm';",
  "import { sqliteTable, integer, text, real, customType, primaryKey, index, uniqueIndex, foreignKey, check, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';",
  '',
  "const nocaseText = customType<{ data: string; driverData: string }>({ dataType: () => 'text COLLATE NOCASE' });",
  "const binaryData = customType<{ data: Uint8Array; driverData: ArrayBuffer | Uint8Array }>({ dataType: () => 'blob', toDriver: (value) => value, fromDriver: (value) => value instanceof Uint8Array ? value : new Uint8Array(value) });",
  '',
];
const manifest = {
  sourceCommit: source.sourceCommit,
  sourceTableCount: source.tables.length,
  tables: [],
  conversions: {
    bigint: 'canonical signed 64-bit decimal TEXT; SQL CAST for numeric ordering/arithmetic',
    decimal: 'exact decimal TEXT',
    binary16: 'canonical UUID TEXT',
    binaryOther: 'BLOB',
    timestamp: 'UTC YYYY-MM-DD HH:mm:ss[.ffffff]',
    datetime: 'declared source offset converted to UTC; DATE/TIME unchanged',
    boolean: 'INTEGER CHECK 0/1',
    collation:
      'SQLite NOCASE only ASCII; native_collation_key requires application normalized-key writes for Unicode unique equality',
    fulltext: 'new_articles title bigram index native_article_ngram; not SQLite porter tokenization',
  },
};

function emitTable(table, columns, indexes, fks, checks, native = false) {
  const pk = indexes.filter((i) => i.name === 'PRIMARY').map((i) => i.column);
  const singlePk = pk.length === 1;
  const columnSql = [];
  const columnTs = [];
  const extraTs = [];
  for (const column of columns) {
    const type = sqlType(column);
    const isPk = singlePk && pk[0] === column.name;
    const auto = column.extra?.includes('auto_increment') && type === 'INTEGER';
    let definition = `${quote(column.name)} ${type}`;
    if (column.collation?.endsWith('_ci')) definition += ' COLLATE NOCASE';
    if (isPk) definition += ` PRIMARY KEY${auto ? ' AUTOINCREMENT' : ''}`;
    if (column.nullable === 'NO') definition += ' NOT NULL';
    if (column.expression) definition += ` GENERATED ALWAYS AS (${convertExpression(column.expression)}) STORED`;
    const defaultSql = columnDefault(column);
    if (defaultSql !== null && !column.expression) definition += ` DEFAULT (${defaultSql})`;
    for (const expression of checkColumns(column)) definition += ` CHECK (${expression})`;
    columnSql.push(definition);
    let builder =
      type === 'INTEGER'
        ? `integer(${JSON.stringify(column.name)}${column.type === 'boolean' || column.columnType === 'tinyint(1)' ? ", { mode: 'boolean' }" : ''})`
        : type === 'REAL'
          ? `real(${JSON.stringify(column.name)})`
          : type === 'BLOB'
            ? `binaryData(${JSON.stringify(column.name)})`
            : column.collation?.endsWith('_ci')
              ? `nocaseText(${JSON.stringify(column.name)})`
              : `text(${JSON.stringify(column.name)}${column.type === 'json' ? ", { mode: 'json' }" : ''})`;
    if (isPk) builder += `.primaryKey(${auto ? '{ autoIncrement: true }' : ''})`;
    if (column.nullable === 'NO') builder += '.notNull()';
    if (column.expression)
      builder += `.generatedAlwaysAs(sql.raw(${JSON.stringify(convertExpression(column.expression))}), { mode: 'stored' })`;
    if (defaultSql !== null && !column.expression) builder += `.default(sql.raw(${JSON.stringify(defaultSql)}))`;
    columnTs.push(`  ${column.name}: ${builder},`);
    checkColumns(column).forEach((expression, number) =>
      extraTs.push(
        `  check(${JSON.stringify(`${table.name}_${column.name}_type_${number}`)}, sql.raw(${JSON.stringify(expression)})),`,
      ),
    );
  }
  if (!singlePk && pk.length) {
    columnSql.push(`PRIMARY KEY (${pk.map(quote).join(', ')})`);
    extraTs.push(`  primaryKey({ columns: [${pk.map((name) => `table.${name}`).join(', ')}] }),`);
  }
  for (const foreign of groups(fks)) {
    const first = foreign[0];
    columnSql.push(
      `CONSTRAINT ${quote(first.name)} FOREIGN KEY (${foreign.map((f) => quote(f.column)).join(', ')}) REFERENCES ${quote(first.refTable)} (${foreign.map((f) => quote(f.refColumn)).join(', ')}) ON DELETE ${first.delete} ON UPDATE ${first.update}`,
    );
    extraTs.push(
      `  foreignKey({ name: ${JSON.stringify(first.name)}, columns: [${foreign.map((f) => `table.${f.column}`).join(', ')}], foreignColumns: ((): [${foreign.map(() => 'AnySQLiteColumn').join(', ')}] => [${foreign.map((f) => `${f.refTable}.${f.refColumn}`).join(', ')}])() }).onDelete(${JSON.stringify(first.delete.toLowerCase())}).onUpdate(${JSON.stringify(first.update.toLowerCase())}),`,
    );
  }
  for (const constraint of checks) {
    const expression = columns
      .filter((column) => column.type === 'bigint')
      .reduce(
        (clause, column) => clause.replaceAll('`' + column.name + '`', 'CAST(`' + column.name + '` AS INTEGER)'),
        convertExpression(constraint.clause),
      );
    if (/\binterval\b/i.test(expression))
      throw new Error(`Unsupported CHECK expression ${constraint.name}: ${expression}`);
    columnSql.push(`CONSTRAINT ${quote(constraint.name)} CHECK (${expression})`);
    extraTs.push(`  check(${JSON.stringify(constraint.name)}, sql.raw(${JSON.stringify(expression)})),`);
  }
  sql.push(`CREATE TABLE ${quote(table.name)} (\n  ${columnSql.join(',\n  ')}\n);`);
  for (const key of groups(indexes.filter((i) => i.name !== 'PRIMARY' && i.type !== 'FULLTEXT'))) {
    const name = `${table.name}__${key[0].name}`;
    if (key.some((i) => i.prefix || i.expression)) throw new Error(`Unsupported index ${name}`);
    sql.push(
      `CREATE ${key[0].unique ? 'UNIQUE ' : ''}INDEX ${quote(name)} ON ${quote(table.name)} (${key.map((i) => quote(i.column)).join(', ')});`,
    );
    extraTs.push(
      `  ${key[0].unique ? 'uniqueIndex' : 'index'}(${JSON.stringify(name)}).on(${key.map((i) => `table.${i.column}`).join(', ')}),`,
    );
  }
  for (const key of groups(indexes.filter((item) => item.type !== 'FULLTEXT'))) {
    if (!key.some((item) => columns.find((column) => column.name === item.column)?.type === 'bigint')) continue;
    const name = `${table.name}__${key[0].name}_numeric`;
    const expressions = key.map((item) =>
      columns.find((column) => column.name === item.column)?.type === 'bigint'
        ? `CAST(${quote(item.column)} AS INTEGER)`
        : quote(item.column),
    );
    sql.push(`CREATE INDEX ${quote(name)} ON ${quote(table.name)} (${expressions.join(', ')});`);
    extraTs.push(
      `  index(${JSON.stringify(name)}).on(${expressions.map((expression) => `sql.raw(${JSON.stringify(expression)})`).join(', ')}),`,
    );
  }
  ts.push(
    `export const ${table.name} = sqliteTable(${JSON.stringify(table.name)}, {`,
    ...columnTs,
    '}, (table) => [',
    ...extraTs,
    ']);',
    '',
  );
  for (const column of columns.filter((c) => c.extra?.includes('on update'))) {
    if (!pk.length) throw new Error(`Timestamp update trigger requires key: ${table.name}`);
    const changed = columns
      .filter((c) => c.name !== column.name && !c.expression)
      .map((c) => `NEW.${quote(c.name)} IS NOT OLD.${quote(c.name)}`)
      .join(' OR ');
    sql.push(
      `CREATE TRIGGER ${quote(`${table.name}__${column.name}_on_update`)} AFTER UPDATE ON ${quote(table.name)} WHEN NEW.${quote(column.name)} IS OLD.${quote(column.name)} AND (${changed}) BEGIN UPDATE ${quote(table.name)} SET ${quote(column.name)} = ${currentTime(column)} WHERE ${pk.map((k) => `${quote(k)} = NEW.${quote(k)}`).join(' AND ')}; END;`,
    );
  }
  manifest.tables.push({ name: table.name, origin: native ? 'native' : 'mysql', columns, primaryKey: pk });
}

for (const table of source.tables) {
  const columns = source.columns.filter((c) => c.table === table.name);
  const indexes = source.indexes.filter((i) => i.table === table.name);
  for (const extension of nativeExtensions.filter((e) => e.table === table.name)) {
    columns.push({
      ...extension.column,
      nullable: extension.column.nullable ? 'YES' : 'NO',
      columnType: extension.column.type,
    });
    if (extension.unique)
      indexes.push({
        name: `${extension.column.name}_unique`,
        column: extension.column.name,
        unique: true,
        type: 'BTREE',
      });
  }
  emitTable(
    table,
    columns,
    indexes,
    source.fks.filter((f) => f.table === table.name),
    source.checks.filter((c) => c.table === table.name),
  );
}
function emitNativeTable(table) {
  const columns = table.columns.map((c) => ({
    ...c,
    native: true,
    nullable: c.nullable ? 'YES' : 'NO',
    columnType: c.type,
  }));
  const indexes = table.primary.map((column) => ({ name: 'PRIMARY', column, unique: true, type: 'BTREE' }));
  table.indexes.forEach((key, number) =>
    key.columns.forEach((column) =>
      indexes.push({ name: `index_${number}`, column, unique: key.unique ?? false, type: 'BTREE' }),
    ),
  );
  const fks = table.columns
    .filter((c) => c.ref)
    .map((c) => ({
      name: `${table.name}_${c.name}_fk`,
      column: c.name,
      refTable: c.ref,
      refColumn: 'id',
      delete: 'CASCADE',
      update: 'NO ACTION',
    }));
  const checks = table.checks.map((clause, number) => ({ name: `${table.name}_check_${number}`, clause }));
  emitTable(table, columns, indexes, fks, checks, true);
}
for (const table of nativeTables) emitNativeTable(table);
sql.push("INSERT INTO native_sequence(id, value) VALUES ('notification','0'), ('notification_subscribe','0');");
sql.push("INSERT INTO native_dining_guard(id, version) VALUES ('global',0);");
sql.push("INSERT INTO dining_soldout_report_sequence(id, last_sequence) VALUES (1,'0');");
sql.push(
  'CREATE UNIQUE INDEX shuttlebus_identity_null ON shuttlebus_timetables(semester_type, region, route_type, route_name) WHERE sub_name IS NULL;',
);
const schemaOnly = process.argv.includes('--schema-only');
const initialMigrationPath = resolve(root, 'drizzle/0000_source_and_native.sql');
const initialMigration = sql.join('\n\n') + '\n';
let existingMigration;
try {
  existingMigration = await readFile(initialMigrationPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!schemaOnly && existingMigration !== undefined && existingMigration !== initialMigration)
  throw new Error(
    '0000 is frozen. Add a new ordered SQL migration and run this generator with --schema-only; never rewrite applied migrations.',
  );
for (const table of metadataTables) emitNativeTable(table);
ts.push(`export const schema = {\n${manifest.tables.map((t) => `  ${t.name},`).join('\n')}\n};`, '');
await mkdir(resolve(root, 'src/db'), { recursive: true });
await mkdir(resolve(root, 'drizzle'), { recursive: true });
await writeFile(resolve(root, 'src/db/schema.ts'), ts.join('\n'));
if (!schemaOnly && existingMigration === undefined)
  await writeFile(initialMigrationPath, initialMigration, { flag: 'wx' });
await writeFile(resolve(root, 'scripts/schema-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const collationPolicies = {};
for (const keys of groups(
  source.indexes.filter((key) => key.unique),
  'table',
).flatMap((tableKeys) => groups(tableKeys))) {
  const columns = keys.map((key) =>
    source.columns.find((column) => column.table === key.table && column.name === key.column),
  );
  if (!columns.some((column) => column.collation?.endsWith('_ci'))) continue;
  (collationPolicies[keys[0].table] ??= []).push({
    name: keys[0].name,
    columns: columns.map((column) => ({ name: column.name, collation: column.collation })),
  });
}
await writeFile(
  resolve(root, 'src/db/collation-policies.ts'),
  `export const collationPolicies: Record<string, { name: string; columns: { name: string; collation: string | null }[] }[]> = ${JSON.stringify(collationPolicies, null, 2)};\n`,
);
