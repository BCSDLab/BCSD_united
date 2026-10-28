import { sql, type SQL } from 'drizzle-orm';
import { collationPolicies } from './collation-policies';

export function normalizeUnicodeKey(value: string, collation: string): string {
  let text = value;
  if (!collation.includes('_0900_')) text = text.replace(/ +$/u, '');
  if (collation.endsWith('_ci')) {
    const general = collation.endsWith('_general_ci');
    text = text.normalize(general ? 'NFD' : 'NFKD').toLowerCase().replace(/\p{M}/gu, '')
      .replaceAll('ς', 'σ').replaceAll('ß', general ? 's' : 'ss');
    if (!general) text = text.replaceAll('œ', 'oe');
    if (collation.includes('_0900_')) text = text.replaceAll('æ', 'ae').replaceAll('ł', 'l').replaceAll('đ', 'd').replaceAll('ø', 'o');
  }
  return text;
}

export function normalizedUniqueWrites(table: string, primaryKey: (string | number)[], row: Record<string, unknown> | null): SQL[] {
  const policies = collationPolicies[table] ?? [];
  const owner = JSON.stringify(primaryKey);
  return policies.flatMap((policy) => {
    const scope = `${table}:${policy.name}`;
    const statements = [sql`DELETE FROM native_collation_key WHERE scope=${scope} AND owner=${owner}`];
    if (row === null) return statements;
    if (policy.columns.some((column) => !(column.name in row))) throw new TypeError(`Complete unique fields required: ${scope}`);
    if (policy.columns.some((column) => row[column.name] === null)) return statements;
    const normalized = JSON.stringify(policy.columns.map((column) => column.collation
      ? normalizeUnicodeKey(String(row[column.name]), column.collation)
      : row[column.name]));
    statements.push(sql`INSERT INTO native_collation_key(scope,owner,normalized) VALUES(${scope},${owner},${normalized})`);
    return statements;
  });
}

export function normalizedUniqueLookup(table: string, index: string, values: Record<string, unknown>): SQL {
  const policy = collationPolicies[table]?.find((candidate) => candidate.name === index);
  if (!policy) throw new TypeError(`Unknown unique collation index: ${table}:${index}`);
  if (policy.columns.some((column) => !(column.name in values) || values[column.name] === null)) throw new TypeError('All non-null unique values required');
  const normalized = JSON.stringify(policy.columns.map((column) => column.collation
    ? normalizeUnicodeKey(String(values[column.name]), column.collation)
    : values[column.name]));
  return sql`SELECT owner FROM native_collation_key WHERE scope=${`${table}:${index}`} AND normalized=${normalized}`;
}
