const CONTENT_ORIGINS: Record<string, true> = {
  'https://static.koreatech.in': true,
  'https://stage-static.koreatech.in': true,
};
const CONTENT_PATH = /^\/articles\/content\/board_\d+\/[\w-]+\.txt$/;

export function getArticleContentUrl(content: string): string | null {
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    return null;
  }
  if (
    !Object.hasOwn(CONTENT_ORIGINS, url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !CONTENT_PATH.test(url.pathname)
  ) {
    return null;
  }

  return url.href;
}
