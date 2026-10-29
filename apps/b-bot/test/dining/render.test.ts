import { describe, expect, it } from 'vitest';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, deliveryMarker, renderReport } from '~/services/dining/render';
import type { BotReportDetail } from '~/services/dining/types';

const base: BotReportDetail = {
  report_id: 101,
  dining: { id: 1001, date: '2026-10-06', type: 'LUNCH', place: 'C코스' },
  status: 'PENDING',
  processing_type: null,
  reason: null,
  created_at: '2026-10-06 12:31:00',
  processed_at: null,
  processor: null,
  image_url: 'https://static.koreatech.in/upload/COOP/2026/10/2/e924c7d3/soldout.jpg',
  processing_id: null,
  source_report_id: null,
  updated_at: '2026-10-06 12:31:00',
};

const pending = base;

const manual = {
  processing_type: 'MANUAL',
  processed_at: '2026-10-06 12:40:00',
  processor: { workspace_id: 'T_EXAMPLE', user_id: 'U_REVIEWER', display_name: '처리 담당자' },
  processing_id: 'e9c690cd-b877-4199-bd37-2fe64c3cc913',
  updated_at: '2026-10-06 12:40:00',
} as const;

const approvedManually: BotReportDetail = { ...base, ...manual, status: 'APPROVED', reason: '담당자 승인' };
const rejectedManually: BotReportDetail = { ...base, ...manual, status: 'REJECTED', reason: '담당자 반려' };

const approvedAutomatically: BotReportDetail = {
  ...base,
  report_id: 102,
  status: 'APPROVED',
  processing_type: 'SAME_DINING_APPROVED',
  reason: '동일 코스 제보 승인에 따른 자동 처리',
  processing_id: 'e9c690cd-b877-4199-bd37-2fe64c3cc913',
  source_report_id: 101,
  updated_at: '2026-10-06 12:40:00',
};

const coopPreprocessed: BotReportDetail = {
  ...base,
  status: 'REJECTED',
  processing_type: 'COOP_PREPROCESSED',
  reason: '영양사 선처리로 제보 확인 없이 종료',
  processing_id: 'e9c690cd-b877-4199-bd37-2fe64c3cc913',
  updated_at: '2026-10-06 12:40:00',
};

const ALL = [pending, approvedManually, rejectedManually, approvedAutomatically, coopPreprocessed];
const DELIVERY_ID = '0d7230a0-2675-4fc8-84b7-21afe16b2f01';
const ADMIN_URL = 'https://admin.stage.koreatech.in/sold-out-report';

const render = (report: BotReportDetail) => renderReport(DELIVERY_ID, report, { adminUrl: ADMIN_URL });
const json = (report: BotReportDetail) => JSON.stringify(render(report));

describe('품절 제보 메시지', () => {
  it('첫 블록은 전송 표식을 단 section이다', () => {
    for (const report of ALL) {
      const { blocks } = render(report);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].block_id).toBe(`koin_dining_delivery:${DELIVERY_ID}`);
    }
  });

  it('같은 입력이면 같은 메시지를 만든다', () => {
    for (const report of ALL) {
      expect(render(report)).toEqual(render(report));
    }
  });

  describe('대기 중인 제보', () => {
    it('접수 안내와 품절 코스, 제보 시간을 보여준다', () => {
      const text = json(pending);
      expect(text).toContain('식단 품절 제보가 접수되었습니다');
      expect(text).toContain('품절 코스 : 10/6(화) 점심 C코스');
      expect(text).toContain('제보 시간: 2026.10.06 12:31');
      expect(text).toContain('사진을 확인한 후 처리해주세요.');
    });

    it('사진을 이미지 블록으로 보여준다', () => {
      expect(render(pending).blocks).toContainEqual({
        type: 'image',
        image_url: pending.image_url,
        alt_text: 'C코스 품절 제보 사진',
      });
    });

    it('승인은 초록, 반려는 빨강 버튼이고 값에는 제보 번호만 담는다', () => {
      const actions = render(pending).blocks.find((block) => block.type === 'actions');
      expect(actions?.type === 'actions' && actions.elements).toMatchObject([
        { action_id: APPROVE_ACTION_ID, style: 'primary', value: JSON.stringify({ report_id: 101 }) },
        { action_id: REJECT_ACTION_ID, style: 'danger', value: JSON.stringify({ report_id: 101 }) },
      ]);
    });
  });

  describe('담당자가 직접 처리한 제보', () => {
    it('승인되면 처리 시간과 처리자, 어드민 링크를 보여준다', () => {
      const text = json(approvedManually);
      expect(text).toContain('식단 품절 제보가 승인되었습니다.');
      expect(text).toContain(':white_check_mark:');
      expect(text).toContain('품절 코스 : 10/6(화) 점심 C코스');
      expect(text).toContain('처리 시간: 2026.10.06 12:40');
      expect(text).toContain('처리자 : <@U_REVIEWER>');
      expect(text).toContain(`<${ADMIN_URL}|Admin page 바로가기>`);
    });

    it('반려되면 반려 안내를 보여준다', () => {
      const text = json(rejectedManually);
      expect(text).toContain('식단 품절 제보가 반려되었습니다.');
      expect(text).toContain(':x:');
      expect(text).toContain('처리자 : <@U_REVIEWER>');
    });

    it('버튼과 사진을 뺀다', () => {
      for (const report of [approvedManually, rejectedManually]) {
        const { blocks } = render(report);
        expect(blocks.some((block) => block.type === 'actions')).toBe(false);
        expect(blocks.some((block) => block.type === 'image')).toBe(false);
      }
    });

    it('어드민 주소가 없으면 링크 없이 보낸다', () => {
      const text = JSON.stringify(renderReport(DELIVERY_ID, approvedManually));
      expect(text).not.toContain('Admin page');
    });
  });

  describe('자동으로 처리된 제보', () => {
    it('접수 안내와 사진은 두고 이미 처리됐다고 알린다', () => {
      for (const report of [approvedAutomatically, coopPreprocessed]) {
        const text = json(report);
        expect(text).toContain('식단 품절 제보가 접수되었습니다');
        expect(render(report).blocks.some((block) => block.type === 'image')).toBe(true);
      }
      expect(json(approvedAutomatically)).toContain('이미 처리가 완료된 제보입니다.');
    });

    it('영양사님이 품절 처리한 제보는 따로 알린다', () => {
      const text = json(coopPreprocessed);
      expect(text).toContain('영양사님이 품절 처리한 제보입니다.');
      expect(text).not.toContain('이미 처리가 완료된 제보입니다.');
    });

    it('버튼을 빼고 처리자를 지어내지 않는다', () => {
      for (const report of [approvedAutomatically, coopPreprocessed]) {
        const text = json(report);
        expect(text).not.toContain(APPROVE_ACTION_ID);
        expect(text).not.toContain(REJECT_ACTION_ID);
        expect(text).not.toContain('처리자');
      }
    });
  });

  it('코스명에 섞인 슬랙 특수문자를 이스케이프한다', () => {
    const report = { ...pending, dining: { ...pending.dining, place: '<!channel> A&B' } };
    const { text, blocks } = render(report);
    // 이미지 alt_text는 plain_text라 멘션으로 해석되지 않는다. mrkdwn으로 읽히는 곳만 본다.
    const mrkdwn = JSON.stringify([text, blocks.filter((block) => block.type !== 'image')]);
    expect(mrkdwn).toContain('&lt;!channel&gt; A&amp;B');
    expect(mrkdwn).not.toContain('<!channel>');
  });

  it('표식 형식은 명세와 같다', () => {
    expect(deliveryMarker('abc')).toBe('koin_dining_delivery:abc');
  });
});
