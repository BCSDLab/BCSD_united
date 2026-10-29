import { sql, type SQL } from 'drizzle-orm';
import { ApiError } from '@api/errors';

export const NGRAM_STOPWORDS = [
  'a',
  'an',
  'as',
  'at',
  'be',
  'by',
  'de',
  'en',
  'i',
  'in',
  'is',
  'it',
  'la',
  'of',
  'on',
  'or',
  'to',
] as const;
export interface Gram {
  token: string;
  position: number;
}
export function ngrams(text: string): Gram[] {
  const result: Gram[] = [];
  let position = 0;
  for (const word of text.normalize('NFC').toLowerCase().split(/\s+/u)) {
    const characters = Array.from(word);
    for (let i = 0; i + 1 < characters.length; i++) {
      const token = characters[i]! + characters[i + 1]!;
      if (!NGRAM_STOPWORDS.some((stopword) => token.includes(stopword))) result.push({ token, position });
      position++;
    }
  }
  return result;
}
export function replaceTitleIndex(articleId: number | SQL, title: string): SQL[] {
  const grams = ngrams(title);
  return [
    sql`DELETE FROM native_article_ngram WHERE article_id=${articleId}`,
    sql`INSERT INTO native_article_ngram(article_id,position,token) SELECT ${articleId},json_extract(value,'$.position'),json_extract(value,'$.token') FROM json_each(${JSON.stringify(grams)}) WHERE ${articleId} IS NOT NULL`,
  ];
}
interface Term {
  mode: 'required' | 'excluded' | 'optional';
  text?: string;
  wildcard?: boolean;
  children?: Term[];
}
export function parseSearch(query: string): Term[] {
  if (query.length >= 100) throw new ApiError(400, '', '검색어의 최대 길이를 초과했습니다.');
  const source = `${query}*`;
  let cursor = 0;
  const bad = (): never => {
    throw new ApiError(400, 'INVALID_REQUEST', '올바르지 않은 검색식입니다.');
  };
  function group(nested: boolean): Term[] {
    const terms: Term[] = [];
    while (cursor < source.length) {
      while (/\s/u.test(source[cursor] ?? '') && cursor < source.length) cursor++;
      if (cursor === source.length) break;
      if (source[cursor] === ')') {
        if (!nested) bad();
        cursor++;
        return terms;
      }
      let mode: Term['mode'] = 'optional';
      if (source[cursor] === '+') {
        mode = 'required';
        cursor++;
      } else if (source[cursor] === '-') {
        mode = 'excluded';
        cursor++;
      }
      if (['>', '<', '~'].includes(source[cursor] ?? '')) cursor++;
      if (['+', '-'].includes(source[cursor] ?? '')) bad();
      if (source[cursor] === '(') {
        cursor++;
        terms.push({ mode, children: group(true) });
        if (source[cursor] === '*') cursor++;
        continue;
      }
      let text = '';
      if (source[cursor] === '"') {
        cursor++;
        while (cursor < source.length && source[cursor] !== '"') text += source[cursor++];
        if (source[cursor++] !== '"') bad();
      } else {
        while (cursor < source.length && !/[\s()*"+\-<>~@]/u.test(source[cursor]!)) text += source[cursor++];
      }
      const wildcard = source[cursor] === '*';
      if (wildcard) cursor++;
      if (!text) {
        if (wildcard && terms.length === 0 && query.trim() === '') return [];
        bad();
      }
      terms.push({ mode, text: text.normalize('NFC').toLowerCase(), wildcard });
    }
    if (nested) bad();
    return terms;
  }
  return group(false);
}
function combine<T>(
  terms: Term[],
  term: (entry: Term) => T,
  and: (items: T[]) => T,
  or: (items: T[]) => T,
  not: (value: T) => T,
  no: T,
): T {
  const required = terms.filter((entry) => entry.mode === 'required').map(term);
  const optional = terms.filter((entry) => entry.mode === 'optional').map(term);
  const excluded = terms.filter((entry) => entry.mode === 'excluded').map((entry) => not(term(entry)));
  if (!required.length && !optional.length) return no;
  return and([...(required.length ? required : [or(optional)]), ...excluded]);
}
export function searchMatches(title: string, query: string): boolean {
  const indexed = ngrams(title);
  const evaluate = (terms: Term[]): boolean =>
    combine(
      terms,
      (entry) => {
        if (entry.children) return evaluate(entry.children);
        const text = entry.text!;
        if (entry.wildcard && Array.from(text).length < 2) return indexed.some((gram) => gram.token.startsWith(text));
        const needle = ngrams(text);
        return (
          needle.length > 0 &&
          indexed.some((start) =>
            needle.every((gram) =>
              indexed.some(
                (value) =>
                  value.position === start.position + gram.position - needle[0]!.position && value.token === gram.token,
              ),
            ),
          )
        );
      },
      (items) => items.every(Boolean),
      (items) => items.some(Boolean),
      (value) => !value,
      false,
    );
  return evaluate(parseSearch(query));
}
export function titleSearch(query: string): SQL {
  const evaluate = (terms: Term[]): SQL =>
    combine(
      terms,
      (entry) => {
        if (entry.children) return evaluate(entry.children);
        const text = entry.text!;
        if (entry.wildcard && Array.from(text).length < 2)
          return sql`EXISTS(SELECT 1 FROM native_article_ngram g WHERE g.article_id=a.id AND substr(g.token,1,1)=${text})`;
        const needle = ngrams(text);
        if (!needle.length) return sql`0`;
        const rest = needle
          .slice(1)
          .map(
            (gram) =>
              sql`EXISTS(SELECT 1 FROM native_article_ngram n WHERE n.article_id=g.article_id AND n.position=g.position+${gram.position - needle[0]!.position} AND n.token=${gram.token})`,
          );
        return sql`EXISTS(SELECT 1 FROM native_article_ngram g WHERE g.article_id=a.id AND g.token=${needle[0]!.token}${rest.length ? sql` AND ${sql.join(rest, sql` AND `)}` : sql``})`;
      },
      (items) => sql`(${sql.join(items, sql` AND `)})`,
      (items) => sql`(${sql.join(items, sql` OR `)})`,
      (value) => sql`NOT(${value})`,
      sql`0`,
    );
  return evaluate(parseSearch(query));
}
export function searchWeightExpression(count: SQL): SQL {
  return sql`CASE WHEN ${count} BETWEEN 1 AND 5 THEN 1.0/(1 << (${count}-1)) WHEN ${count} BETWEEN 6 AND 10 THEN 0.0625 ELSE 0 END`;
}
