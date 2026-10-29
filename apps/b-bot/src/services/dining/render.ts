import type { KnownBlock } from '@slack/web-api';
import type { BotReportDetail, DiningType, ReportActor } from './types';

export const APPROVE_ACTION_ID = 'dining:approve';
export const REJECT_ACTION_ID = 'dining:reject';

export interface RenderedMessage {
  text: string;
  blocks: KnownBlock[];
}

export interface RenderOptions {
  adminUrl?: string;
  imageUnavailable?: boolean;
}

interface ManualProcessing {
  processor: ReportActor;
  processedAt: string;
}

const RECEIVED_TITLE_TEXT = '식단 품절 제보가 접수되었습니다';
const RECEIVED_TITLE = `:rotating_light: *${RECEIVED_TITLE_TEXT}*`;

const DINING_TYPE_LABEL: Record<DiningType, string> = {
  BREAKFAST: '아침',
  LUNCH: '점심',
  DINNER: '저녁',
};
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatTime(value: string): string {
  const [date, time] = value.split(' ');
  return `${date.replaceAll('-', '.')} ${time.slice(0, 5)}`;
}

function formatDiningDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${weekday})`;
}

function describeDining(report: BotReportDetail): string {
  return `${formatDiningDate(report.dining.date)} ${DINING_TYPE_LABEL[report.dining.type]} ${escape(report.dining.place)}`;
}

export function deliveryMarker(deliveryId: string): string {
  return `koin_dining_delivery:${deliveryId}`;
}

function decisionButtons(report: BotReportDetail): KnownBlock {
  const value = JSON.stringify({ report_id: report.report_id });
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '승인', emoji: true },
        style: 'primary',
        action_id: APPROVE_ACTION_ID,
        value,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '반려', emoji: true },
        style: 'danger',
        action_id: REJECT_ACTION_ID,
        value,
      },
    ],
  };
}

function manualProcessing(report: BotReportDetail): ManualProcessing | undefined {
  if (report.processing_type !== 'MANUAL' || !report.processor || !report.processed_at) {
    return undefined;
  }
  return { processor: report.processor, processedAt: report.processed_at };
}

function renderManual(
  deliveryId: string,
  report: BotReportDetail,
  { processor, processedAt }: ManualProcessing,
  { adminUrl }: RenderOptions,
): RenderedMessage {
  const approved = report.status === 'APPROVED';
  const titleText = approved ? '식단 품절 제보가 승인되었습니다.' : '식단 품절 제보가 반려되었습니다.';

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      block_id: deliveryMarker(deliveryId),
      text: {
        type: 'mrkdwn',
        text: [
          `${approved ? ':white_check_mark:' : ':x:'} *${titleText}*`,
          `품절 코스 : ${describeDining(report)}`,
          `처리 시간: ${formatTime(processedAt)}`,
          `처리자 : <@${processor.user_id}>`,
        ].join('\n'),
      },
    },
  ];
  if (adminUrl) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${adminUrl}|Admin page 바로가기>` },
    });
  }

  return { text: titleText, blocks };
}

function statusText(report: BotReportDetail, done: boolean): string {
  if (!done) return '사진을 확인한 후 처리해주세요.';
  return report.processing_type === 'COOP_PREPROCESSED'
    ? '영양사님이 품절 처리한 제보입니다.'
    : '이미 처리가 완료된 제보입니다.';
}

export function renderReport(
  deliveryId: string,
  report: BotReportDetail,
  options: RenderOptions = {},
): RenderedMessage {
  const manual = manualProcessing(report);
  if (manual) {
    return renderManual(deliveryId, report, manual, options);
  }

  const done = report.status !== 'PENDING';
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      block_id: deliveryMarker(deliveryId),
      text: {
        type: 'mrkdwn',
        text: [
          RECEIVED_TITLE,
          `품절 코스 : ${describeDining(report)}`,
          `제보 시간: ${formatTime(report.created_at)}`,
        ].join('\n'),
      },
    },
    options.imageUnavailable
      ? { type: 'context', elements: [{ type: 'mrkdwn', text: '사진을 불러오지 못했습니다.' }] }
      : {
          type: 'image',
          image_url: report.image_url,
          alt_text: `${report.dining.place} 품절 제보 사진`,
        },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: statusText(report, done),
      },
    },
  ];
  if (!done) {
    blocks.push(decisionButtons(report));
  }

  return { text: RECEIVED_TITLE_TEXT, blocks };
}
