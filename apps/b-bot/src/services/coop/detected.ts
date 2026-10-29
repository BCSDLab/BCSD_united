import type { StructuredImageMimeType } from '@koin/b-bot-ai';
import { normalizeSemester, normalizeVacationSemester } from './convert';
import type { KoinEnv } from '~/services/koin/target';
import {
  cleanAttachmentName,
  collectNewestAttachments,
  createDetectedStore,
  downloadAttachment,
  fetchKoinArticle,
  isAllowedFileUrl,
  sortByLikelyName,
  type ArticleAttachment,
  type KoinArticle,
} from '~/services/koin/article';

export interface CoopNoticeImage {
  name: string;
  url: string;
  mimeType: StructuredImageMimeType;
}

export type DetectedCoopTermName = '1학기' | '2학기' | '하계방학' | '동계방학';

export interface DetectedCoopNotice {
  env: KoinEnv;
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  year?: number;
  termName?: DetectedCoopTermName;
  images: CoopNoticeImage[];
}

const IMAGE_MIME: Record<string, StructuredImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const LIKELY_NAMES = ['운영시간', '운영 시간', '생협', '시설물'];

export const cleanCoopFileName = cleanAttachmentName;
export const isAllowedCoopFileUrl = isAllowedFileUrl;

export type CoopArticle = KoinArticle;
export const fetchCoopArticle = fetchKoinArticle;

function mimeTypeOf(name: string): StructuredImageMimeType | null {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return IMAGE_MIME[extension] ?? null;
}

/** 생협 공지의 이미지 후보를 모두 모으고, 같은 주소는 가장 최근 이름만 남긴다. */
export function collectCoopImages(attachments: ArticleAttachment[] | undefined): CoopNoticeImage[] {
  const images = collectNewestAttachments(attachments, (name, url) => {
    const mimeType = mimeTypeOf(name);
    return mimeType ? { name, url, mimeType } : null;
  });
  return sortByLikelyName(images, LIKELY_NAMES);
}

/** 공지 제목에서 정규학기만 읽는다. 계절학기·방학은 normalizeSemester가 거절한다. */
export function guessRegularCoopSemester(title: string): { year: number; termName: '1학기' | '2학기' } | null {
  if (/(?:하계|동계)\s*방학|여름\s*학기|겨울\s*학기|계절\s*학기/.test(title)) {
    return null;
  }
  const academicYear = /(20\d{2})\s*학년도.*?([12])\s*학기/.exec(title);
  if (academicYear) {
    return {
      year: Number(academicYear[1]),
      termName: `${academicYear[2]}학기` as '1학기' | '2학기',
    };
  }
  const semester = normalizeSemester(title);
  const matched = /^(\d{2})-([12])학기$/.exec(semester ?? '');
  if (!matched) return null;
  return {
    year: 2000 + Number(matched[1]),
    termName: `${matched[2]}학기` as '1학기' | '2학기',
  };
}

export function guessCoopSemester(title: string): { year: number; termName: DetectedCoopTermName } | null {
  const regular = guessRegularCoopSemester(title);
  if (regular) return regular;
  const vacation = normalizeVacationSemester(title);
  return vacation ? { year: vacation.year, termName: `${vacation.season}방학` } : null;
}

export function hasImageSignature(bytes: Uint8Array, mimeType: StructuredImageMimeType): boolean {
  return (
    (mimeType === 'image/png' && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
    (mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (mimeType === 'image/gif' && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) ||
    (mimeType === 'image/webp' &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50)
  );
}

/** 학교 게시글 이미지 다운로드. Slack 토큰은 학교 서버로 보내지 않는다. */
export async function downloadCoopNoticeImage(image: CoopNoticeImage): Promise<ArrayBuffer> {
  const buffer = await downloadAttachment(image.url, '첨부 이미지를');
  if (!hasImageSignature(new Uint8Array(buffer), image.mimeType)) {
    throw new Error('이미지 파일 내용이 확장자와 일치하지 않습니다.');
  }
  return buffer;
}

const store = createDetectedStore<DetectedCoopNotice>('coop');

export const saveDetectedCoop = store.save;
export const loadDetectedCoop = store.load;
export const dropDetectedCoop = store.drop;
