import { createReviewToken, isValidToken } from './reviewToken';

/**
 * 게시판 공지 감지의 공통 부분.
 *
 * 새 공지가 올라오면 외부 배치가 Slack에 "확인"/"넘어가기" 버튼을 올린다. 배치가 아는 건
 * `article_id` 하나뿐이고, 게시글 조회·첨부 선별·다운로드는 전부 삐봇이 한다.
 * 배치가 첨부를 추출하고 슬랙 블록을 조립하면 그 지식이 두 레포로 흩어진다.
 * 어떤 첨부를 받을지(엑셀·이미지)와 파일 검사는 도메인마다 다르다.
 */

export interface ArticleAttachment {
  name?: string;
  url?: string;
  created_at?: string;
}

export interface KoinArticle {
  title?: string;
  url?: string;
  attachments?: ArticleAttachment[];
}

/**
 * 공지는 **항상 프로덕션에서 읽는다.** 반영 대상과 무관하다.
 *
 * 배치가 넘기는 번호는 프로덕션 코인의 게시글 번호이고(링크도 koreatech.in),
 * 스테이지는 게시글 크롤링이 돌지 않아 그 번호가 없다. 여기서 스테이지를 보면
 * 스테이지 테스트가 통째로 막힌다.
 *
 * 읽기뿐이라 프로덕션을 봐도 되돌릴 일이 없다. 되돌릴 수 없는 건 반영 쪽이고,
 * 그건 여전히 채널이 정한다.
 */
const ARTICLE_BASE_URL = 'https://api.koreatech.in';

/** 학교가 올린 파일만 받는다. 남이 넣은 주소로 봇이 아무거나 받아오게 두지 않는다. */
const ALLOWED_FILE_HOSTS = ['koreatech.ac.kr', 'koreatech.in'];

const MAX_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export const koreatechArticleUrl = (articleId: number) => `https://koreatech.in/articles/${articleId}`;

/** `붙임2. 개설교과목.xlsx(21 KB)` → `붙임2. 개설교과목.xlsx` */
export function cleanAttachmentName(raw: string): string {
  return raw.replace(/\s*\(\s*[\d.]+\s*[KMG]?B\s*\)\s*$/i, '').trim();
}

export function isAllowedFileUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' && ALLOWED_FILE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}

/** 게시글을 조회해 제목과 첨부를 얻는다. 배치가 넘긴 번호 하나로 나머지를 채운다. */
export async function fetchKoinArticle(articleId: number): Promise<KoinArticle> {
  const response = await fetch(`${ARTICLE_BASE_URL}/articles/${articleId}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`게시글 ${articleId}을 찾지 못했습니다 (HTTP ${response.status}).`);
  }
  return (await response.json()) as KoinArticle;
}

/**
 * 받을 첨부만 골라낸다. `toFile`이 null을 주면 버린다.
 *
 * 같은 파일이 여러 번 실려 오는 게시글이 있어 주소로 한 번 걸러낸다. 이때 **가장 최근
 * 것을 남긴다.** 학교가 파일을 새로 올리면 포털은 같은 주소의 파일을 갈아끼우는데
 * 코인은 옛 이름과 새 이름을 둘 다 들고 있다. 먼저 나온 걸 잡으면 받아오는 파일은
 * 최신인데 이름만 옛날 것으로 뜬다.
 */
export function collectNewestAttachments<T>(
  attachments: ArticleAttachment[] | undefined,
  toFile: (name: string, url: string) => T | null,
): T[] {
  const newest = new Map<string, { file: T; at: string }>();
  for (const attachment of attachments ?? []) {
    const url = attachment.url ?? '';
    const name = cleanAttachmentName(attachment.name ?? '');
    if (!url || !name || !isAllowedFileUrl(url)) continue;
    const file = toFile(name, url);
    if (!file) continue;

    const at = attachment.created_at ?? '';
    const kept = newest.get(url);
    if (!kept || at > kept.at) {
      newest.set(url, { file, at });
    }
  }
  return [...newest.values()].map(({ file }) => file);
}

/** 이름에 앞쪽 단어가 들어 있을수록 앞에 둔다. 고르는 사람이 대개 첫 번째를 누른다. */
export function sortByLikelyName<T extends { name: string }>(files: T[], likelyNames: string[]): T[] {
  const likelihood = (name: string) => {
    const index = likelyNames.findIndex((word) => name.includes(word));
    return index === -1 ? 0 : likelyNames.length - index;
  };
  return [...files].sort((a, b) => likelihood(b.name) - likelihood(a.name));
}

/**
 * 공지 첨부를 받는다. 슬랙 파일과 달리 봇 토큰을 붙이지 않는다 —
 * 학교 서버에 우리 토큰을 보낼 이유가 없다.
 */
/** `label`은 조사까지 받는다("첨부 이미지를"). 받침에 따라 을/를이 갈린다. */
export async function downloadAttachment(url: string, label = '첨부 파일을'): Promise<ArrayBuffer> {
  if (!isAllowedFileUrl(url)) {
    throw new Error('학교 주소가 아닌 곳에서는 파일을 받지 않습니다.');
  }
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${label} 받지 못했습니다 (HTTP ${response.status}).`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (${Math.round(declared / 1024 / 1024)}MB).`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (${Math.round(buffer.byteLength / 1024 / 1024)}MB).`);
  }
  return buffer;
}

/** xlsx는 zip이라 PK로 시작한다. 로그인 페이지 같은 게 오면 여기서 걸린다. */
export function isZipFile(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer.slice(0, 2));
  return head[0] === 0x50 && head[1] === 0x4b;
}

/** 사람이 첨부를 고르는 동안 들고 있는 값. 주소가 길어 버튼 value에 담기 어렵다. */
export function createDetectedStore<T extends { articleId: number }>(prefix: string) {
  const key = (token: string) => `${prefix}-detected:${token}`;
  return {
    async save(notice: T): Promise<string> {
      const token = createReviewToken();
      await useStorage('kvStorage').setItem(key(token), notice);
      return token;
    },
    async load(token: string): Promise<T | null> {
      if (!isValidToken(token)) return null;
      return (await useStorage('kvStorage').getItem<T>(key(token))) ?? null;
    },
    async drop(token: string): Promise<void> {
      await useStorage('kvStorage').removeItem(key(token));
    },
  };
}
