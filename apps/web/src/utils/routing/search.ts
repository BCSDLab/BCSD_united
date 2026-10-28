export type SearchParams = Record<string, string | string[]>;

export function parseSearch(search: string): SearchParams {
  const result: SearchParams = Object.create(null);
  for (const [key, value] of new URLSearchParams(search)) {
    const previous = result[key];
    if (previous === undefined) result[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else result[key] = [previous, value];
  }

  return result;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, String(entry));
  }
  const query = params.toString();

  return query ? `?${query}` : '';
}
