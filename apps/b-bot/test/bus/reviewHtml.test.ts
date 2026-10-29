import { describe, expect, it } from 'vitest';
import { renderBusReviewHtml } from '~/services/bus/reviewHtml';

const conversion = {
  payloads: [
    {
      target: 'commuting' as const,
      semester_type: 'REGULAR' as const,
      body: {
        commuting_bus_timetables: [
          {
            region: '천안',
            route_type: '등교',
            route_name: '천안역',
            node_info: [{ name: '천안역' }, { name: '대학' }],
            route_info: [{ name: '1회', running_days: ['MON' as const], arrival_time: ['08:10', '08:50'] }],
          },
        ],
      },
    },
  ],
  version_update: {
    type: 'shuttle_bus_timetable' as const,
    title: '정규학기' as const,
    content: '2026-03-02~2026-06-19',
  },
  provenance: {},
  warnings: ['천안 천안역: 종착 도착시각을 읽을 수 없어 하교 자동 생성을 건너뜁니다.'],
};

const cleanConversion = {
  payloads: [
    {
      target: 'shuttle' as const,
      semester_type: 'SEASONAL' as const,
      body: {
        shuttle_bus_timetables: [
          {
            region: '청주',
            route_type: '셔틀',
            route_name: '청주 셔틀',
            node_info: [{ name: '터미널' }],
            route_info: [{ name: '1회', arrival_time: ['09:00'] }],
          },
          {
            region: '청주',
            route_type: '셔틀',
            route_name: '청주 셔틀',
            node_info: [{ name: '대학' }],
            route_info: [{ name: '2회', arrival_time: ['18:00'] }],
          },
        ],
      },
    },
  ],
  version_update: {
    type: 'shuttle_bus_timetable' as const,
    title: '계절학기' as const,
    content: '2026-06-22~2026-07-10',
  },
  provenance: {},
  warnings: [],
};

const perfectlyClean = {
  payloads: [
    {
      target: 'shuttle' as const,
      semester_type: 'SEASONAL' as const,
      body: {
        shuttle_bus_timetables: [
          {
            region: '청주',
            route_type: '셔틀',
            route_name: '청주 셔틀',
            node_info: [{ name: '터미널' }],
            route_info: [{ name: '1회', running_days: ['MON' as const], arrival_time: ['09:00'] }],
          },
        ],
      },
    },
  ],
  version_update: {
    type: 'shuttle_bus_timetable' as const,
    title: '계절학기' as const,
    content: '2026-06-22~2026-07-10',
  },
  provenance: {},
  warnings: [],
};

describe('버스 검수 HTML', () => {
  it('전체·확인 필요·운행요일 미지정 3개 탭을 제공한다', () => {
    const html = renderBusReviewHtml('job-1', [conversion]);
    expect(html).toContain('전체');
    expect(html).toContain('확인 필요');
    expect(html).toContain('운행요일 미지정');
    expect(html).toContain('id="f-all"');
    expect(html).toContain('id="f-issue"');
    expect(html).toContain('id="f-no-days"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('running_days를 한글로 표기한다', () => {
    const html = renderBusReviewHtml('job-1', [conversion]);
    expect(html).toContain('<small>월</small>');
    expect(html).not.toContain('<small>MON</small>');
  });

  it('경고·미지정 노선이 있으면 해당 타일을 강조한다', () => {
    const html = renderBusReviewHtml('job-1', [conversion, cleanConversion]);
    expect(html).toContain('class="tile warn"');
    expect(html).toContain('class="tile note"');
    const clean = renderBusReviewHtml('job-1', [perfectlyClean]);
    expect(clean).not.toContain('class="tile warn"');
    expect(clean).not.toContain('class="tile note"');
  });

  it('확인 필요·운행요일 미지정 타일은 노선 수를 센다', () => {
    const html = renderBusReviewHtml('job-1', [conversion, cleanConversion]);
    expect(html).toMatch(/<div class="n">1<\/div><div class="k">확인 필요 노선<\/div>/);
    expect(html).toMatch(/<div class="n">2<\/div><div class="k">운행요일 미지정 노선<\/div>/);
  });

  it('경고 문구는 각 노선 카드에 직접 표시하고 학기 패널은 없다', () => {
    const html = renderBusReviewHtml('job-1', [conversion]);
    expect(html).toContain(
      '<p class="route-warning">천안 천안역: 종착 도착시각을 읽을 수 없어 하교 자동 생성을 건너뜁니다.</p>',
    );
    expect(html).toContain('data-issue="true"');
    expect(html).not.toContain('warning-panel');
    expect(html).not.toContain('경고 내용');
  });

  it('색 의미 범례를 제공한다', () => {
    const html = renderBusReviewHtml('job-1', [conversion]);
    expect(html).toContain('class="legend"');
    expect(html).toContain('노란색 = 경고가 걸린 노선');
    expect(html).toContain('파란색 = 운행요일 미지정 노선');
  });

  it('탭 모드에 따라 노선 색이 정해진다', () => {
    const html = renderBusReviewHtml('job-1', [conversion, cleanConversion]);
    expect(html).toContain('.view-issue .route[data-issue="true"]');
    expect(html).toContain('.view-no-days .route[data-no-days="true"]');
    expect(html).toContain('.view-all .route-warning');
    expect(html).toContain('.view-all .no-days-badge');
    expect(html).toContain('.view-no-days .route-warning{display:none}');
    expect(html).toContain('.view-issue .no-days-badge{display:none}');
    expect(html).toContain('"no-days":document.getElementById("f-no-days")');
    expect(html).toContain('mode==="no-days"&&route.dataset.noDays==="true"');
  });

  it('running_days가 없는 회차는 운행요일 미지정 표시가 붙는다', () => {
    const html = renderBusReviewHtml('job-1', [cleanConversion]);
    expect(html).toContain('data-no-days="true"');
    expect(html).toContain('class="missing"');
    expect(html).toContain('운행요일미지정');
    expect(html).toContain('route.dataset.noDays==="true"');
  });

  it('running_days가 있으면 미지정 표시를 하지 않는다', () => {
    const html = renderBusReviewHtml('job-1', [conversion]);
    expect(html).not.toMatch(/<section class="route"[^>]*data-no-days="true"/);
    expect(html).not.toContain('class="missing"');
    expect(html).not.toContain('<p class="no-days-badge">');
  });

  it('카운터는 노선 카드만 센다', () => {
    const html = renderBusReviewHtml('job-1', [conversion]);
    expect(html).toContain('querySelectorAll("#groups .route")');
    expect(html).not.toContain('querySelectorAll("#groups .route, #groups .warning-panel")');
    expect(html).toContain('" / "+(mode==="all"?routes.length:(mode==="issue"?totalIssue:totalNoDays))+"개 노선"');
  });

  it('하교 자동계산 경고는 해당 지역·방향 노선만 확인 필요로 표시한다', () => {
    const base = {
      payloads: [
        {
          target: 'commuting' as const,
          semester_type: 'REGULAR' as const,
          body: {
            commuting_bus_timetables: [
              {
                region: '천안',
                route_type: '등교',
                route_name: '천안역',
                node_info: [{ name: '천안역' }],
                route_info: [{ name: '1회', arrival_time: ['08:10'] }],
              },
              {
                region: '천안',
                route_type: '하교',
                route_name: '천안역',
                node_info: [{ name: '대학' }],
                route_info: [{ name: '1회', arrival_time: ['18:10'] }],
              },
              {
                region: '세종',
                route_type: '등교',
                route_name: '세종',
                node_info: [{ name: '세종시청' }],
                route_info: [{ name: '1회', arrival_time: ['08:30'] }],
              },
            ],
          },
        },
      ],
      version_update: {
        type: 'shuttle_bus_timetable' as const,
        title: '정규학기' as const,
        content: '2026-03-02~2026-06-19',
      },
      provenance: {},
      warnings: ['천안 하교는 등교 노선 역순(18:10 출발)으로 자동 계산해 추가했습니다.'],
    };
    const html = renderBusReviewHtml('job-1', [base]);
    const issueSections = [...html.matchAll(/data-issue="true"[^>]*data-search="([^"]*)"/g)].map((m) => m[1]);
    expect(issueSections).toEqual([
      'commuting regular 천안 하교 천안역 운행요일미지정 천안 하교는 등교 노선 역순(18:10 출발)으로 자동 계산해 추가했습니다.',
    ]);
  });
});
