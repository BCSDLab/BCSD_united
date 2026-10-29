import { describe, expect, it } from 'vitest';
import { buildStoredBusReview } from '~/services/bus/pipeline';
import { buildBusPatchBlocks, buildReviewApprovalBlocks } from '~/services/slack/features/bus/blocks';
import type { BusPatchPlan } from '~/services/bus/patch';
import type { BusConversion } from '~/services/bus/types';

describe('버스 수정 미리보기', () => {
  it('같은 노선명이 여러 학기에 있을 수 있어 학기를 함께 보여준다', () => {
    const plan: BusPatchPlan = {
      patches: [
        {
          semester: 'SEASONAL',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '터미널/천안역',
          kind: 'running_days',
          tripName: '1회',
          before: '운행일 없음',
          after: '월,화,수,목,금',
          rawValue: '월화수목금',
          days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        },
      ],
      problems: [],
    };

    const blocks = buildBusPatchBlocks(plan, 'p1', 'U1');
    const text = JSON.stringify(blocks);

    expect(text).toContain('계절학기 천안 등교');
    expect(text).not.toMatch(/^• 천안 등교/);
  });

  it('period 수정도 어느 학기의 적용 기간인지 보여준다', () => {
    const plan: BusPatchPlan = {
      patches: [
        {
          semester: 'VACATION',
          target: 'commuting',
          region: '',
          routeType: '',
          routeName: '',
          kind: 'period',
          before: '2026-07-13~2026-08-30',
          after: '2026-07-14~2026-08-30',
          rawValue: '2026-07-14~2026-08-30',
          value: '2026-07-14~2026-08-30',
        },
      ],
      problems: [],
    };

    const blocks = buildBusPatchBlocks(plan, 'p1', 'U1');
    expect(JSON.stringify(blocks)).toContain('방학기간 적용 기간');
  });
});

describe('버스 변환 완료 안내의 확인 필요 노선/운행요일 미지정 노선 수', () => {
  // 경고 하나가 노선 여러 개를 가리키거나(지역 단위 경고), 노선 하나에 경고가
  // 여러 개 걸릴 수 있어 "경고 건수"와 "영향받은 노선 수"는 다르다. Slack 요약은
  // 검토 페이지와 같은 노선 단위 집계(routeIssues.ts)를 써야 숫자가 어긋나지 않는다.
  const conversion: BusConversion = {
    payloads: [
      {
        target: 'commuting',
        semester_type: 'REGULAR',
        body: {
          commuting_bus_timetables: [
            {
              region: '천안',
              route_type: '등교',
              route_name: '천안역',
              node_info: [{ name: '천안역' }, { name: '대학' }],
              route_info: [{ name: '1회', running_days: ['MON'], arrival_time: ['08:10', '08:50'] }],
            },
            {
              region: '천안',
              route_type: '등교',
              route_name: '터미널',
              node_info: [{ name: '터미널' }, { name: '대학' }],
              route_info: [{ name: '1회', arrival_time: ['08:20', '08:50'] }],
            },
          ],
        },
      },
    ],
    version_update: { type: 'shuttle_bus_timetable', title: '정규학기', content: '2026-03-02~2026-06-19' },
    provenance: {},
    // 노선명이 아닌 지역+방향 단위 경고라 위 두 노선 모두에 매칭된다 → 경고는 1건인데
    // 영향받은 노선은 2개.
    warnings: ['천안 등교 노선 일부는 정류장 순서를 임의로 정렬했습니다.'],
  };

  it('Slack 요약의 노선 수가 검토 페이지 타일과 정확히 같다', async () => {
    const { renderBusReviewHtml } = await import('~/services/bus/reviewHtml');
    const html = renderBusReviewHtml('job-1', [conversion]);
    // 검토 페이지: 경고 매칭 노선 2개, 운행요일 미지정 노선 1개(터미널 1회에 running_days 없음).
    expect(html).toMatch(/<div class="n">2<\/div><div class="k">확인 필요 노선<\/div>/);
    expect(html).toMatch(/<div class="n">1<\/div><div class="k">운행요일 미지정 노선<\/div>/);

    const stored = buildStoredBusReview([conversion], { env: 'stage', fileName: '시간표.xlsx' });
    expect(stored.meta.issueRouteCount).toBe(2);
    expect(stored.meta.noDaysRouteCount).toBe(1);

    const blocks = buildReviewApprovalBlocks(
      {
        token: 't1',
        reviewUrl: 'https://bot.example/bus-review/t1',
        routeCount: 2,
        issueRouteCount: stored.meta.issueRouteCount,
        noDaysRouteCount: stored.meta.noDaysRouteCount,
        semesterTypes: ['REGULAR'],
      },
      { env: 'stage', fileName: '시간표.xlsx' },
      'U1',
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain('확인 필요 노선 *2개*');
    expect(text).toContain('운행요일 미지정 노선 *1개*');
    // 예전 문구("경고 건수" 기준)는 더 이상 쓰지 않는다.
    expect(text).not.toContain('확인이 필요한 항목');
  });
});
