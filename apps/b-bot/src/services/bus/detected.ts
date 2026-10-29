/**
 * 게시판에 새 버스 시간표 공지가 올라오면 외부 시스템(배치)이 Slack에 웹훅으로
 * "확인"/"넘어가기" 버튼을 올린다. 이 모듈은 그 "확인"을 눌렀을 때 게시글을
 * 다시 조회해서 첨부 시간표를 찾아오는 부분만 맡는다 — 배치가 아는 건 action_id와
 * `article_id` 하나뿐이고, 나머지는 전부 여기서 한다(coop/lecture와 동일한 이유).
 *
 * 시간표 파일이 여러 개 붙는 공지도 있어(정규학기·계절학기가 따로 올라오는 경우 등),
 * lecture와 동일하게 둘 이상이면 사람이 버튼으로 고르게 한다.
 */

import {
  cleanAttachmentName,
  collectNewestAttachments,
  createDetectedStore,
  downloadAttachment,
  fetchKoinArticle,
  isAllowedFileUrl,
  isZipFile,
  type ArticleAttachment,
  type KoinArticle,
} from '~/services/koin/article';
import type { KoinEnv } from '~/services/koin/target';

export type BusArticle = KoinArticle;

export interface BusNoticeFile {
  name: string;
  url: string;
}

/**
 * 첨부가 여럿이라 사람이 고르는 동안 들고 있는 값.
 *
 * 배치는 **게시글 번호만** 준다. 첨부는 버튼을 누른 뒤 삐봇이 코인 API로 알아낸다.
 */
export interface BusDetectedNotice {
  target: KoinEnv;
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  /** 시간표 첨부 후보. 이 순서가 곧 버튼 순서다. */
  files: BusNoticeFile[];
}

export const cleanBusFileName = cleanAttachmentName;
export const isAllowedBusFileUrl = isAllowedFileUrl;
export const fetchBusArticle = fetchKoinArticle;

/** 버스 공지의 시간표(xls/xlsx) 첨부를 모은다. 같은 주소는 가장 최근 이름만 남긴다. */
export function collectBusSpreadsheets(attachments: ArticleAttachment[] | undefined): BusNoticeFile[] {
  return collectNewestAttachments(attachments, (name, url) =>
    ['.xls', '.xlsx'].some((extension) => name.toLowerCase().endsWith(extension)) ? { name, url } : null,
  );
}

/** 학교 게시글 첨부 다운로드. Slack 봇 토큰은 학교 서버로 보내지 않는다. */
export async function downloadBusNoticeFile(file: BusNoticeFile): Promise<Buffer> {
  const buffer = await downloadAttachment(file.url);
  // xls(BIFF)는 매직 바이트 규칙이 달라 xlsx만 검사한다. slackFile.ts의 검사와 같은 이유.
  if (file.name.toLowerCase().endsWith('.xlsx') && !isZipFile(buffer)) {
    throw new Error('엑셀 파일이 아닙니다.');
  }
  return Buffer.from(buffer);
}

const store = createDetectedStore<BusDetectedNotice>('bus');

export const saveBusDetected = store.save;
export const loadBusDetected = store.load;
export const dropBusDetected = store.drop;
