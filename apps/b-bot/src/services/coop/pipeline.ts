import type { StructuredImageMimeType } from '@koin/b-bot-ai';
import { type KoinEnv } from '~/services/koin/target';
import { fetchCoopShopBaseline } from './baseline';
import { convertRegularTimetable, convertVacationTimetable } from './convert';
import { buildReviewUrl, saveCoopReview } from './reviewStore';
import { renderRegularCoopReview, renderVacationCoopReview } from './reviewHtml';
import type { CoopShopBaseline, RawRegularCoopTimetable, RegularConversionResult, VacationSeason } from './types';
import { extractCoopTimetable } from './vision';

export interface RegularCoopArtifacts {
  conversion: RegularConversionResult;
  requestJson: string;
  reviewHtml: string;
}

export interface RegularCoopTarget {
  env: KoinEnv;
  year: number;
  termName: '1학기' | '2학기';
  fileName: string;
}

export interface RegularCoopOutcome {
  token: string;
  reviewUrl: string;
  shopCount: number;
  excludedCount: number;
  blockingCount: number;
  infoCount: number;
}

export interface VacationCoopTarget {
  env: KoinEnv;
  year: number;
  season: VacationSeason;
  fileName: string;
}

export interface VacationCoopOutcome extends RegularCoopOutcome {
  semesterCount: 2;
}

export function expectedRegularSemester(target: Pick<RegularCoopTarget, 'year' | 'termName'>): string {
  return `${String(target.year).slice(-2)}-${target.termName}`;
}

export function buildRegularCoopArtifacts(
  raw: RawRegularCoopTimetable,
  baseline: CoopShopBaseline,
): RegularCoopArtifacts {
  const conversion = convertRegularTimetable(raw, baseline);
  return {
    conversion,
    requestJson: `${JSON.stringify(conversion.request, null, 2)}\n`,
    reviewHtml: renderRegularCoopReview(conversion),
  };
}

export async function extractCoopImage({
  image,
  mimeType,
  fileName,
}: {
  image: ArrayBuffer | Uint8Array;
  mimeType: StructuredImageMimeType;
  fileName: string;
}): Promise<RawRegularCoopTimetable> {
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  if (bytes.byteLength === 0) throw new Error('생협 시간표 이미지가 비어 있습니다.');
  return await extractCoopTimetable({
    imageBase64: Buffer.from(bytes).toString('base64'),
    mimeType,
    fileName,
  });
}

export async function convertVacationCoopToReview(
  raw: RawRegularCoopTimetable,
  vacationStartDate: string,
  target: VacationCoopTarget,
): Promise<VacationCoopOutcome> {
  if (!/^https?:\/\//.test(process.env.APP_BASE_URL ?? '')) {
    throw new Error('서버 설정이 없습니다: APP_BASE_URL');
  }
  const baseline = await fetchCoopShopBaseline();
  const split = convertVacationTimetable(raw, baseline, vacationStartDate);
  if (split.year !== target.year || split.season !== target.season) {
    throw new Error(
      `명령은 ${target.year} ${target.season}방학인데 이미지에서는 ${split.year} ${split.season}방학으로 읽었습니다.`,
    );
  }
  const periods = [
    { kind: '계절학기' as const, conversion: split.seasonal, request: split.seasonal.request },
    { kind: '방학' as const, conversion: split.vacation, request: split.vacation.request },
  ];
  const blockingCount = periods.reduce(
    (count, period) => count + period.conversion.issues.filter((issue) => issue.severity === 'blocking').length,
    0,
  );
  const infoCount = periods.reduce(
    (count, period) => count + period.conversion.issues.filter((issue) => issue.severity === 'info').length,
    0,
  );
  const token = await saveCoopReview({
    html: renderVacationCoopReview(split),
    request: split.seasonal.request,
    conversion: split.seasonal,
    periods,
    meta: {
      env: target.env,
      year: target.year,
      termName: `${target.season}계절학기·${target.season}방학`,
      sourceFileName: target.fileName,
      shopCount: split.seasonal.shops.length,
      blockingCount,
      createdAt: new Date().toISOString(),
    },
  });
  return {
    token,
    reviewUrl: buildReviewUrl(token),
    shopCount: split.seasonal.shops.length,
    excludedCount: split.seasonal.excludedShops.length,
    blockingCount,
    infoCount,
    semesterCount: 2,
  };
}

export async function convertRegularRawCoopToReview(
  raw: RawRegularCoopTimetable,
  target: RegularCoopTarget,
): Promise<RegularCoopOutcome> {
  if (!/^https?:\/\//.test(process.env.APP_BASE_URL ?? '')) {
    throw new Error('서버 설정이 없습니다: APP_BASE_URL');
  }
  const baseline = await fetchCoopShopBaseline();
  const artifacts = buildRegularCoopArtifacts(raw, baseline);

  const expected = expectedRegularSemester(target);
  if (artifacts.conversion.semester !== expected) {
    throw new Error(
      `명령은 ${expected}인데 이미지에서는 ${artifacts.conversion.semester || '학기 미상'}(으)로 읽었습니다.`,
    );
  }

  const blockingCount = artifacts.conversion.issues.filter((issue) => issue.severity === 'blocking').length;
  const infoCount = artifacts.conversion.issues.filter((issue) => issue.severity === 'info').length;
  const token = await saveCoopReview({
    html: artifacts.reviewHtml,
    request: artifacts.conversion.request,
    conversion: artifacts.conversion,
    meta: {
      env: target.env,
      year: target.year,
      termName: target.termName,
      sourceFileName: target.fileName,
      shopCount: artifacts.conversion.shops.length,
      blockingCount,
      createdAt: new Date().toISOString(),
    },
  });

  return {
    token,
    reviewUrl: buildReviewUrl(token),
    shopCount: artifacts.conversion.shops.length,
    excludedCount: artifacts.conversion.excludedShops.length,
    blockingCount,
    infoCount,
  };
}
