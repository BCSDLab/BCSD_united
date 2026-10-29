import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressBody, slackRecorder } from '../support/slackRecorder';

/**
 * 세 도메인의 [수정 적용] 버튼 흐름을 경우별로 고정한다.
 * 특히 이미 반영된 작업의 검토 데이터를 고치지 않는지(#38)를 핸들러 전체로 확인한다.
 */
const m = vi.hoisted(() => ({
  bus: {
    loadBusPatchPlan: vi.fn(),
    dropBusPatchPlan: vi.fn(),
    loadBusReview: vi.fn(),
    updateBusReview: vi.fn(),
    findBusJob: vi.fn(),
    applyBusPatchesToConversions: vi.fn(),
    buildStoredBusReview: vi.fn(),
  },
  coop: {
    loadCoopPatchPlan: vi.fn(),
    dropCoopPatchPlan: vi.fn(),
    loadCoopReview: vi.fn(),
    updateCoopReview: vi.fn(),
    findCoopJob: vi.fn(),
    applyCoopPatches: vi.fn(),
  },
  lecture: {
    loadPatchPlan: vi.fn(),
    dropPatchPlan: vi.fn(),
    loadReview: vi.fn(),
    updateReview: vi.fn(),
    findJob: vi.fn(),
    applyPatches: vi.fn(),
    buildStoredReview: vi.fn(),
  },
}));

vi.mock('~/services/bus/reviewStore', async (orig) => ({
  ...(await orig<typeof import('~/services/bus/reviewStore')>()),
  loadBusPatchPlan: m.bus.loadBusPatchPlan,
  dropBusPatchPlan: m.bus.dropBusPatchPlan,
  loadBusReview: m.bus.loadBusReview,
  updateBusReview: m.bus.updateBusReview,
}));
vi.mock('~/services/bus/jobStore', () => ({ findBusJob: m.bus.findBusJob }));
vi.mock('~/services/bus/patch', async (orig) => ({
  ...(await orig<typeof import('~/services/bus/patch')>()),
  applyBusPatchesToConversions: m.bus.applyBusPatchesToConversions,
}));
vi.mock('~/services/bus/validation', async (orig) => ({
  ...(await orig<typeof import('~/services/bus/validation')>()),
  validateConversion: (conversion: unknown) => conversion,
}));
vi.mock('~/services/bus/pipeline', () => ({ buildStoredBusReview: m.bus.buildStoredBusReview }));

vi.mock('~/services/coop/reviewStore', async (orig) => ({
  ...(await orig<typeof import('~/services/coop/reviewStore')>()),
  loadCoopPatchPlan: m.coop.loadCoopPatchPlan,
  dropCoopPatchPlan: m.coop.dropCoopPatchPlan,
  loadCoopReview: m.coop.loadCoopReview,
  updateCoopReview: m.coop.updateCoopReview,
}));
vi.mock('~/services/coop/jobStore', () => ({ findCoopJob: m.coop.findCoopJob }));
vi.mock('~/services/coop/patch', async (orig) => ({
  ...(await orig<typeof import('~/services/coop/patch')>()),
  applyCoopPatches: m.coop.applyCoopPatches,
}));
vi.mock('~/services/coop/reviewHtml', () => ({
  renderRegularCoopReview: () => '<html>regular</html>',
  renderVacationCoopReview: () => '<html>vacation</html>',
}));

vi.mock('~/services/lecture/reviewStore', async (orig) => ({
  ...(await orig<typeof import('~/services/lecture/reviewStore')>()),
  loadPatchPlan: m.lecture.loadPatchPlan,
  dropPatchPlan: m.lecture.dropPatchPlan,
  loadReview: m.lecture.loadReview,
  updateReview: m.lecture.updateReview,
}));
vi.mock('~/services/lecture/jobStore', () => ({ findJob: m.lecture.findJob }));
vi.mock('~/services/lecture/patch', async (orig) => ({
  ...(await orig<typeof import('~/services/lecture/patch')>()),
  applyPatches: m.lecture.applyPatches,
}));
vi.mock('~/services/lecture/pipeline', () => ({ buildStoredReview: m.lecture.buildStoredReview }));

import { busPatchActions } from '~/services/slack/features/bus/actions';
import { coopPatchActions } from '~/services/slack/features/coop/patchActions';
import { lectureActions } from '~/services/slack/features/lecture/actions';

const REVIEW = 'r'.repeat(32);
const PATCH = 'p'.repeat(32);
const ALL = [...busPatchActions, ...coopPatchActions, ...lectureActions];

async function press(actionId: string) {
  const slack = slackRecorder();
  const setting = ALL.find((candidate) => candidate.actionId === actionId)!;
  await setting.handler({
    client: slack.client as never,
    body: pressBody() as never,
    action: {
      type: 'button',
      action_id: actionId,
      value: JSON.stringify({ patchToken: PATCH, requesterId: 'U9' }),
    } as never,
  });
  return slack.events;
}

const coopConversion = {
  semester: '26-1학기',
  fromDate: '2026-03-03',
  toDate: '2026-06-19',
  request: { coop_shops: [] },
  shops: [],
  excludedShops: [],
  issues: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.bus.loadBusPatchPlan.mockResolvedValue({ reviewToken: REVIEW, patches: [{}, {}] });
  m.bus.findBusJob.mockResolvedValue({ status: 'PENDING' });
  m.bus.loadBusReview.mockResolvedValue({ conversions: [], meta: { env: 'stage', sourceFileName: '버스.xlsx' } });
  m.bus.applyBusPatchesToConversions.mockReturnValue([]);
  m.bus.buildStoredBusReview.mockReturnValue({ rebuilt: true });

  m.coop.loadCoopPatchPlan.mockResolvedValue({ reviewToken: REVIEW, patches: [{}] });
  m.coop.findCoopJob.mockResolvedValue({ status: 'FAILED' });
  m.coop.loadCoopReview.mockResolvedValue({
    conversion: coopConversion,
    request: coopConversion.request,
    meta: { env: 'stage', year: 2026, termName: '1학기', shopCount: 11 },
  });
  m.coop.applyCoopPatches.mockReturnValue({ ...coopConversion, issues: [{ severity: 'blocking' }] });

  m.lecture.loadPatchPlan.mockResolvedValue({ reviewToken: REVIEW, patches: [{}, {}, {}] });
  m.lecture.findJob.mockResolvedValue(null);
  m.lecture.loadReview.mockResolvedValue({
    lectures: [],
    timeFormat: 'period',
    meta: { env: 'stage', year: 2026, termName: '2학기', sourceFileName: '편람.xlsx' },
  });
  m.lecture.applyPatches.mockReturnValue([]);
  m.lecture.buildStoredReview.mockReturnValue({ rebuilt: true });
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
  [
    '버스',
    'bus:patch_apply',
    m.bus.loadBusPatchPlan,
    m.bus.findBusJob,
    m.bus.loadBusReview,
    m.bus.updateBusReview,
    m.bus.applyBusPatchesToConversions,
  ],
  [
    '생협',
    'coop:patch_apply',
    m.coop.loadCoopPatchPlan,
    m.coop.findCoopJob,
    m.coop.loadCoopReview,
    m.coop.updateCoopReview,
    m.coop.applyCoopPatches,
  ],
  [
    '강의',
    'lecture:patch_apply',
    m.lecture.loadPatchPlan,
    m.lecture.findJob,
    m.lecture.loadReview,
    m.lecture.updateReview,
    m.lecture.applyPatches,
  ],
])('%s 수정 적용', (_name, actionId, loadPlan, findJob, loadReview, updateReview, apply) => {
  it('적용 성공', async () => {
    const events = await press(actionId);
    expect(updateReview).toHaveBeenCalledTimes(1);
    expect(events).toMatchSnapshot();
  });

  it('이미 반영된 작업은 고치지 않는다', async () => {
    findJob.mockResolvedValue({ status: 'APPLIED' });
    const events = await press(actionId);
    expect(updateReview).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).toContain('수정을 적용할 수 없습니다');
  });

  it('수정 계획이 만료됐으면 알린다', async () => {
    loadPlan.mockResolvedValue(null);
    expect(await press(actionId)).toMatchSnapshot();
  });

  it('검토가 만료됐으면 알린다', async () => {
    loadReview.mockResolvedValue(null);
    const events = await press(actionId);
    expect(updateReview).not.toHaveBeenCalled();
    expect(events).toMatchSnapshot();
  });

  it('적용 중 오류가 나면 알린다', async () => {
    apply.mockImplementation(() => {
      throw new Error('노선을 찾지 못했습니다');
    });
    expect(await press(actionId)).toMatchSnapshot();
  });
});

describe.each([['bus:patch_cancel'], ['coop:patch_cancel'], ['lecture:patch_cancel']])('%s', (actionId) => {
  it('수정 취소', async () => {
    expect(await press(actionId)).toMatchSnapshot();
  });
});
