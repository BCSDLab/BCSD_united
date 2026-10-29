import { hasAiCredentials } from '@koin/b-bot-ai';
import { blockingIssues, buildAdminRequest, toAdminTerm } from './adminApi';
import { convertRows } from './convert';
import { isProduction, labelOf, type KoinEnv } from '~/services/koin/target';
import { renderReviewPage } from './reviewHtml';
import type { StoredReview } from './reviewStore';
import { buildReviewUrl, saveReview } from './reviewStore';
import { readSheetFromBuffer } from './sheet';
import { generateMappingSpec } from './spec';
import type { Lecture, TimeFormat } from './types';

export interface ConversionTarget {
  /** 채널로 정해진 대상. 변환부터 반영까지 바뀌지 않는다. */
  env: KoinEnv;
  year: number;
  /** `여름학기`처럼 사람이 쓰는 이름. enum 변환은 안쪽에서 한다. */
  termName: string;
  fileName: string;
}

/** 변환을 시작하기 전에 없으면 반드시 실패할 설정만 확인한다. */
function assertConfigured(): void {
  const missing = [
    !/^https?:\/\//.test(process.env.APP_BASE_URL ?? '') ? 'APP_BASE_URL' : null,
    !hasAiCredentials() ? 'Workers AI 바인딩 (또는 CLOUDFLARE_ACCOUNT_ID와 CLOUDFLARE_API_TOKEN)' : null,
  ].filter((name) => name !== null);

  if (missing.length > 0) {
    throw new Error(`서버 설정이 없습니다: ${missing.join(', ')}`);
  }
}

export interface ConversionOutcome {
  token: string;
  reviewUrl: string;
  lectureCount: number;
  blockingCount: number;
  emptyValueCount: number;
  parseFailureCount: number;
  withoutTimeCount: number;
}

/**
 * 엑셀 한 개를 검토 가능한 상태까지 끌고 간다.
 * 스펙 생성만 LLM이고 나머지는 전부 결정적이다.
 */
export async function convertToReview(
  buffer: ArrayBuffer,
  { env, year, termName, fileName }: ConversionTarget,
): Promise<ConversionOutcome> {
  const term = toAdminTerm(termName);
  // LLM 호출과 파싱은 수십 초가 걸린다. 설정 때문에 실패할 거면 그 전에 알린다.
  assertConfigured();
  const rows = await readSheetFromBuffer(buffer);
  const spec = await generateMappingSpec(rows);
  const converted = convertRows(rows, spec);

  if (converted.lectures.length === 0) {
    throw new Error('강의를 하나도 읽지 못했습니다. 파일이 편람이 맞는지 확인해주세요.');
  }

  const { issues } = buildAdminRequest(converted.lectures, { year, term });
  const blocking = blockingIssues(issues);

  const token = await saveReview(
    buildStoredReview(
      converted.lectures,
      spec.timeFormat,
      { env, year, termName, fileName },
      {
        parseFailures: converted.issues.map((i) => ({
          row: i.row,
          value: i.value,
          message: i.message,
        })),
      },
    ),
  );

  return {
    token,
    reviewUrl: buildReviewUrl(token),
    lectureCount: converted.lectures.length,
    blockingCount: blocking.length,
    emptyValueCount: issues.length - blocking.length,
    parseFailureCount: converted.issues.length,
    withoutTimeCount: converted.lectures.filter((l) => l.lecture_infos.length === 0).length,
  };
}

/**
 * 강의 목록으로 저장할 형태를 만든다. 수정을 적용한 뒤에도 같은 함수를 쓴다 —
 * 검토 화면과 실제로 반영할 값이 갈라지지 않게 하려는 것이다.
 */
export function buildStoredReview(
  lectures: Lecture[],
  timeFormat: TimeFormat,
  target: ConversionTarget,
  { parseFailures = [] }: { parseFailures?: { row: number; value: string; message: string }[] } = {},
): StoredReview {
  const { issues } = buildAdminRequest(lectures, {
    year: target.year,
    term: toAdminTerm(target.termName),
  });

  const html = renderReviewPage({
    envLabel: labelOf(target.env),
    isProduction: isProduction(target.env),
    year: target.year,
    termName: target.termName,
    sourceFileName: target.fileName,
    generatedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    lectures,
    issues,
    parseFailures,
  });

  return {
    html,
    lectures,
    timeFormat,
    meta: {
      env: target.env,
      year: target.year,
      termName: target.termName,
      sourceFileName: target.fileName,
      lectureCount: lectures.length,
      issueCount: blockingIssues(issues).length,
      createdAt: new Date().toISOString(),
    },
  };
}
