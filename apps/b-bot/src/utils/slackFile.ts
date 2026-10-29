import type { StructuredImageMimeType } from '@koin/b-bot-ai';

/** 슬랙에 올라온 파일 중 우리가 다루는 정보만. */
export interface SlackFile {
  id: string;
  name: string;
  filetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 봇 토큰을 붙여 요청하므로 슬랙이 아닌 주소로는 절대 보내지 않는다.
 * 서명 검증이 있으면 여기까지 위조된 주소가 오지 않지만, 한쪽이 뚫려도
 * 토큰은 나가지 않게 두 겹으로 둔다.
 */
export function isSlackFileUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'slack.com' || hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

export function findExcelFile(files: SlackFile[] | undefined): SlackFile | null {
  return files?.find((file) => file.filetype === 'xlsx' || file.name?.toLowerCase().endsWith('.xlsx')) ?? null;
}

/**
 * 버스 시간표처럼 xls/xlsx를 모두 받는 경우. findExcelFile은 xlsx 전용이다.
 * csv는 결정론적 파서가 시트 구조를 요구해 받지 않는다.
 *
 * 첨부가 여러 개일 수 있어(예: 첨부 순서가 뒤섞이거나 실수로 두 번 올림) 목록
 * 전체를 돌려준다. `.find()`로 하나만 고르면 여러 개를 올렸을 때 어느 걸
 * 골랐는지 사용자가 알 방법이 없다 — 호출자가 개수를 보고 안내해야 한다.
 */
export function findSpreadsheetFiles(files: SlackFile[] | undefined): SlackFile[] {
  return (
    files?.filter((file) => ['.xls', '.xlsx'].some((extension) => file.name?.toLowerCase().endsWith(extension))) ?? []
  );
}

export function findSpreadsheetFile(files: SlackFile[] | undefined): SlackFile | null {
  return findSpreadsheetFiles(files)[0] ?? null;
}

const IMAGE_MIME_BY_TYPE: Record<string, StructuredImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function slackImageMimeType(file: SlackFile): StructuredImageMimeType | null {
  const fileType = file.filetype?.toLowerCase();
  if (IMAGE_MIME_BY_TYPE[fileType]) {
    return IMAGE_MIME_BY_TYPE[fileType];
  }
  const extension = file.name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return IMAGE_MIME_BY_TYPE[extension] ?? null;
}

export function findImageFile(files: SlackFile[] | undefined): SlackFile | null {
  return files?.find((file) => slackImageMimeType(file) !== null) ?? null;
}

async function fetchSlackFile(initialUrl: string): Promise<Response> {
  let url = initialUrl;
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isSlackFileUrl(url)) {
      throw new Error('슬랙이 아닌 주소로는 파일을 받지 않습니다.');
    }
    // Workers는 자동 리디렉션에도 인증 헤더를 전달하므로 각 목적지를 먼저 검증한다.
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      redirect: 'manual',
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('파일 다운로드 리디렉션 주소가 없습니다.');
    url = new URL(location, url).toString();
  }
  throw new Error('파일 다운로드 리디렉션이 너무 많습니다.');
}

async function download(file: SlackFile): Promise<ArrayBuffer> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    throw new Error('파일 다운로드 주소가 없습니다.');
  }
  if (!isSlackFileUrl(url)) {
    throw new Error('슬랙이 아닌 주소로는 파일을 받지 않습니다.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (${Math.round(file.size / 1024 / 1024)}MB).`);
  }

  const response = await fetchSlackFile(url);
  if (!response.ok) {
    throw new Error(`파일을 받지 못했습니다 (HTTP ${response.status}).`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (${Math.round(declared / 1024 / 1024)}MB).`);
  }
  return response.arrayBuffer();
}

/**
 * 슬랙 파일은 공개 URL이 아니다. 봇 토큰을 Authorization 헤더에 넣어야 받을 수 있고,
 * 앱에 `files:read` 스코프가 없으면 본문 대신 로그인 HTML이 돌아온다.
 * 그래서 상태 코드만 보지 않고 내용이 엑셀인지까지 확인한다.
 */
export async function downloadSlackFile(file: SlackFile): Promise<ArrayBuffer> {
  const buffer = await download(file);
  // xlsx는 zip이라 PK로 시작한다. 로그인 페이지가 오면 여기서 걸린다.
  const head = new Uint8Array(buffer.slice(0, 2));
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    throw new Error('엑셀 파일이 아닙니다. 봇에 files:read 권한이 있는지 확인해주세요.');
  }

  return buffer;
}

/**
 * xls/xlsx를 모두 받는다. xlsx는 zip이라 PK로 시작하므로 여기서도 검사한다.
 * xls(BIFF)는 매직 바이트 규칙이 달라 이름만으로 구분한다.
 */
export async function downloadSlackSpreadsheet(file: SlackFile): Promise<Buffer> {
  const buffer = await download(file);
  if (file.name?.toLowerCase().endsWith('.xlsx')) {
    const head = new Uint8Array(buffer.slice(0, 2));
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
      throw new Error('엑셀 파일이 아닙니다. 봇에 files:read 권한이 있는지 확인해주세요.');
    }
  }
  return Buffer.from(buffer);
}
