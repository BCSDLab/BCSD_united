import { convertExcelDeterministically } from './deterministicConversion';
import { analyseExcel, analyseXlsx } from './excelAnalyzer';
import { type KoinEnv } from '~/services/koin/target';
import { renderBusReviewHtml } from './reviewHtml';
import type { BusReviewMeta, StoredBusReview } from './reviewStore';
import { buildBusReviewUrl, saveBusReview } from './reviewStore';
import { countBusRouteIssues } from './routeIssues';
import { validateConversion } from './validation';
import { totalRouteCount, type BusConversion } from './types';

export interface BusConversionTarget {
  /** 채널로 정해진 대상. 변환부터 반영까지 바뀌지 않는다. */
  env: KoinEnv;
  fileName: string;
}

async function readSheetContext(buffer: Buffer, extension: string) {
  // These packages are optional runtime adapters so production can use the parser
  // best suited to its deployment image while the workflow itself stays portable.
  if (extension === '.xlsx') return analyseXlsx(buffer);
  if (extension === '.xls') return analyseExcel(buffer);
  throw new Error('unsupported attachment extension');
}

/**
 * 첨부를 검토 가능한 변환 결과까지 끌고 간다. 결정론적 파서만 쓰고, LLM은
 * `!수정`의 자연어 해석에만 쓴다.
 */
export async function convertSpreadsheetToConversions(buffer: Buffer, extension: string): Promise<BusConversion[]> {
  const context = await readSheetContext(buffer, extension);
  if (!context || typeof context !== 'object' || !('sheets' in context))
    throw new Error('현재 deterministic 변환은 Excel 파일만 지원합니다.');
  return convertExcelDeterministically(context as ReturnType<typeof analyseExcel>).map(validateConversion);
}

export interface BusConversionOutcome {
  token: string;
  reviewUrl: string;
  routeCount: number;
  issueRouteCount: number;
  noDaysRouteCount: number;
  semesterTypes: string[];
}

/** conversions에 실제로 등장하는 학기 구분. 정규+계절이 한 파일에 같이 나올 수 있다. */
function semesterTypesOf(conversions: BusConversion[]): string[] {
  const found = new Set<string>();
  for (const conversion of conversions) {
    for (const payload of conversion.payloads) found.add(payload.semester_type);
  }
  return [...found];
}

/**
 * conversions 목록으로 저장할 형태를 만든다. 수정을 적용한 뒤에도 같은 함수를 쓴다 —
 * 검토 화면과 실제로 반영할 값이 갈라지지 않게 하려는 것이다.
 */
export function buildStoredBusReview(conversions: BusConversion[], target: BusConversionTarget): StoredBusReview {
  const html = renderBusReviewHtml(target.fileName, conversions);
  const { issueRouteCount, noDaysRouteCount } = countBusRouteIssues(conversions);
  const meta: BusReviewMeta = {
    env: target.env,
    sourceFileName: target.fileName,
    routeCount: totalRouteCount(conversions),
    issueRouteCount,
    noDaysRouteCount,
    createdAt: new Date().toISOString(),
  };
  return { html, conversions, meta };
}

/**
 * 엑셀 한 개를 검토 가능한 상태까지 끌고 간다.
 */
export async function convertBusToReview(
  buffer: Buffer,
  extension: string,
  target: BusConversionTarget,
): Promise<BusConversionOutcome> {
  const conversions = await convertSpreadsheetToConversions(buffer, extension);
  if (conversions.length === 0) {
    throw new Error('버스 시간표를 하나도 읽지 못했습니다. 파일 형식을 확인해주세요.');
  }
  const stored = buildStoredBusReview(conversions, target);
  const token = await saveBusReview(stored);
  return {
    token,
    reviewUrl: buildBusReviewUrl(token),
    routeCount: stored.meta.routeCount,
    issueRouteCount: stored.meta.issueRouteCount,
    noDaysRouteCount: stored.meta.noDaysRouteCount,
    semesterTypes: semesterTypesOf(conversions),
  };
}
