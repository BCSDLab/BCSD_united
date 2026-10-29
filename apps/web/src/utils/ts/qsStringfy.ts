export default function qsStringify(params: Record<string, unknown>, prefix?: string): string {
  const queryString = Object.keys(params)
    .map((key) => {
      const value = params[key];
      const encodedKey = prefix ? `${prefix}[${encodeURIComponent(key)}]` : encodeURIComponent(key);

      if (Array.isArray(value)) {
        return value.map((item) => `${encodedKey}=${encodeURIComponent(String(item))}`).join('&');
      }
      if (typeof value === 'object' && value !== null) {
        return qsStringify(value as Record<string, unknown>, encodedKey);
      }

      return `${encodedKey}=${encodeURIComponent(String(value))}`;
    })
    .filter((part) => part.length > 0)
    .join('&');

  return queryString;
}
