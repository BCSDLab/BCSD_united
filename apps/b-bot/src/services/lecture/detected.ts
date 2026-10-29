import {
  cleanAttachmentName,
  collectNewestAttachments,
  createDetectedStore,
  downloadAttachment,
  fetchKoinArticle,
  isAllowedFileUrl as isAllowedKoinFileUrl,
  isZipFile,
  sortByLikelyName,
  type ArticleAttachment,
} from '~/services/koin/article';
import type { KoinEnv } from '~/services/koin/target';

export interface AttachmentFile {
  name: string;
  url: string;
}

/**
 * 첨부가 여럿이라 사람이 고르는 동안 들고 있는 값.
 *
 * 배치는 **게시글 번호만** 준다. 첨부·학기는 버튼을 누른 뒤 삐봇이 코인 API로 알아낸다.
 * 배치가 첨부를 추출하고 슬랙 블록을 조립하면 그 지식이 두 레포로 흩어진다.
 */
export interface DetectedNotice {
  target: KoinEnv;
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  year: number;
  term: string;
  /** 엑셀 첨부 후보. 이 순서가 곧 버튼 순서다. */
  files: AttachmentFile[];
}

export const isAllowedFileUrl = isAllowedKoinFileUrl;
export const cleanFileName = cleanAttachmentName;
export const fetchArticle = fetchKoinArticle;

/** 편람일 가능성이 높은 이름. 이 순서가 곧 버튼 순서가 된다. */
const LIKELY_NAMES = ['개설교과목', '개설 교과목', '편람', '교과목'];

/**
 * 첨부에서 엑셀 후보를 **전부** 모은다.
 *
 * 하나만 고르지 않는 건, 한 공지에 엑셀이 여럿 붙기 때문이다
 * (편람 외에 폐강강좌·시간표 등). 조용히 첫 번째를 집으면 엉뚱한 파일을
 * 변환하고도 아무도 모른다. 둘 이상이면 사람이 고른다.
 *
 * 같은 주소는 가장 최근 것만 남긴다(`collectNewestAttachments` 참고).
 *
 * 이름 끝에 `(21 KB)`처럼 크기가 붙어 있어 확장자는 그 앞에서 본다.
 */
export function collectExcelAttachments(attachments: ArticleAttachment[] | undefined): AttachmentFile[] {
  const files = collectNewestAttachments(attachments, (name, url) =>
    name.toLowerCase().endsWith('.xlsx') ? { name, url } : null,
  );
  // 편람으로 보이는 걸 앞에 둔다. 고르는 사람이 대개 첫 번째를 누르게 된다.
  return sortByLikelyName(files, LIKELY_NAMES);
}

/** 위에서부터 처음 맞는 규칙을 쓴다. 계절학기 표기를 학기 번호보다 먼저 본다. */
const TERM_RULES = [
  [/하계|여름/, '여름학기'],
  [/동계|겨울/, '겨울학기'],
  [/1\s*학기/, '1학기'],
  [/2\s*학기/, '2학기'],
] as const;

/**
 * 공지 제목에서 학기를 읽는다.
 *
 * `2026학년도 하계 계절학기 개설교과목 안내` → 2026 여름학기
 * 알아내지 못하면 사람이 지정하게 한다. 추측해서 엉뚱한 학기에 넣으면 되돌릴 수 없다.
 */
export function guessSemester(title: string): { year: number; term: string } | null {
  const year = Number(/(\d{4})\s*학년도/.exec(title)?.[1]);
  if (!Number.isInteger(year)) {
    return null;
  }

  const term = TERM_RULES.find(([pattern]) => pattern.test(title))?.[1];
  return term ? { year, term } : null;
}

/** 공지 첨부파일을 받는다. 엑셀이 아닌 게(로그인 페이지 등) 오면 여기서 걸린다. */
export async function downloadNoticeFile(url: string): Promise<ArrayBuffer> {
  const buffer = await downloadAttachment(url);
  if (!isZipFile(buffer)) {
    throw new Error('엑셀 파일이 아닙니다. 첨부 주소를 확인해주세요.');
  }
  return buffer;
}

const store = createDetectedStore<DetectedNotice>('lecture');

/** 버튼을 누를 때까지 들고 있는다. 주소가 길어 버튼 value에 담기 어렵다. */
export const saveDetected = store.save;
export const loadDetected = store.load;
export const dropDetected = store.drop;
