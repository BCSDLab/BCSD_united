const UNSAFE_R2_ESCAPE = /%(?:2f|5c|00|25[0-9a-f]{2})/i;

/** A missing value disables the additional source; a malformed value must fail closed. */
export function r2ImagePrefix(value: string | undefined): URL | null {
  if (value === undefined || value === '') return null;

  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/.exec(value);
  if (!match || /[@:]/.test(match[1])) throw new Error('Invalid R2_FILES_PUBLIC_URL');

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      match[1].toLowerCase() !== url.host ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid R2_FILES_PUBLIC_URL');
    if (url.pathname !== (match[2] ?? '/') || UNSAFE_R2_ESCAPE.test(url.pathname))
      throw new Error('Invalid R2_FILES_PUBLIC_URL');

    return url;
  } catch {
    throw new Error('Invalid R2_FILES_PUBLIC_URL');
  }
}

export function isR2ImageSource(url: URL, prefix: URL | null): boolean {
  if (!prefix || url.origin !== prefix.origin) return false;
  const path = prefix.pathname;

  return url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
}

/** Some upstreams decode encoded separators or nested escapes before resolving object keys. */
export function hasUnsafeR2Path(url: URL, prefix: URL | null): boolean {
  return !!prefix && url.origin === prefix.origin && UNSAFE_R2_ESCAPE.test(url.pathname);
}

/** URL strips an explicit default :443, so check the authority before URL parsing loses it. */
export function hasExplicitPort(rawUrl: string): boolean {
  const authority = /^(?:https:)?\/\/([^/?#]+)/i.exec(rawUrl)?.[1];

  return authority !== undefined && /:\d+$/.test(authority);
}
