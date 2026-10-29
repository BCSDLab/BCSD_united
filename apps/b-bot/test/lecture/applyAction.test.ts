import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 강의 반영 버튼의 흐름을 통째로 고정한다(Slack에 보내는 메시지와 작업 상태 기록).
 * 세 도메인의 반영 흐름을 하나로 합치는 리팩토링의 안전망이다.
 */
const mocks = vi.hoisted(() => ({
  claimJob: vi.fn(),
  finishJob: vi.fn(),
  cancelJob: vi.fn(),
  loadReview: vi.fn(),
  ensureSemester: vi.fn(),
  submitLectures: vi.fn(),
}));

vi.mock('~/services/lecture/adminApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/services/lecture/adminApi')>();
  return {
    AdminApiError: actual.AdminApiError,
    toAdminTerm: actual.toAdminTerm,
    buildAdminRequest: vi.fn((_lectures, { year, term }) => ({ request: { year, term, lectures: [] } })),
    ensureSemester: mocks.ensureSemester,
    submitLectures: mocks.submitLectures,
  };
});

vi.mock('~/services/lecture/jobStore', () => ({
  claimJob: mocks.claimJob,
  finishJob: mocks.finishJob,
  cancelJob: mocks.cancelJob,
  findJob: vi.fn(),
}));

vi.mock('~/services/lecture/reviewStore', () => ({
  loadReview: mocks.loadReview,
  dropPatchPlan: vi.fn(),
  loadPatchPlan: vi.fn(),
  savePatchPlan: vi.fn(),
  updateReview: vi.fn(),
}));

vi.mock('~/services/koin/adminAuth', () => ({
  getKoinAdminAuth: vi.fn(async () => ({ baseUrl: 'https://api.stage.example.com', accessToken: 'token' })),
}));

vi.mock('~/services/koin/target', () => ({
  labelOf: vi.fn(() => '스테이지'),
  resolveTargetByEnv: vi.fn(() => ({ target: { env: 'stage', baseUrl: 'https://api.stage.example.com' } })),
}));

import { AdminApiError } from '~/services/lecture/adminApi';
import { lectureActions } from '~/services/slack/features/lecture/actions';

const TOKEN = 'a'.repeat(32);
const stored = {
  lectures: [],
  meta: { env: 'stage', year: 2026, termName: '2학기', lectureCount: 812, sourceFileName: '편람.xlsx' },
};

function slack() {
  return {
    chat: { update: vi.fn(async (_args: unknown) => ({})), postEphemeral: vi.fn(async (_args: unknown) => ({})) },
  };
}

async function press(actionId: 'lecture:apply' | 'lecture:cancel') {
  const client = slack();
  const setting = lectureActions.find((candidate) => candidate.actionId === actionId)!;
  await setting.handler({
    client: client as never,
    body: { channel: { id: 'C1' }, user: { id: 'U1' }, message: { ts: '100.1' } } as never,
    action: { type: 'button', action_id: actionId, value: JSON.stringify({ token: TOKEN }) } as never,
  });
  return {
    updates: client.chat.update.mock.calls.map(([args]) => args),
    ephemerals: client.chat.postEphemeral.mock.calls.map(([args]) => args),
    finishes: mocks.finishJob.mock.calls,
  };
}

describe('강의 반영 Slack 액션', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimJob.mockResolvedValue({ ok: true });
    mocks.cancelJob.mockResolvedValue(true);
    mocks.loadReview.mockResolvedValue(stored);
    mocks.ensureSemester.mockResolvedValue(undefined);
    mocks.submitLectures.mockResolvedValue(undefined);
  });

  it('반영 성공', async () => {
    const result = await press('lecture:apply');
    expect(mocks.submitLectures).toHaveBeenCalledWith(
      { year: 2026, term: 'SECOND', lectures: [] },
      expect.objectContaining({ accessToken: 'token' }),
    );
    expect(result).toMatchSnapshot();
  });

  it('다른 사람이 반영 중이면 누른 사람에게만 알린다', async () => {
    mocks.claimJob.mockResolvedValue({ ok: false, reason: 'U2님이 반영 중입니다.' });
    expect(await press('lecture:apply')).toMatchSnapshot();
  });

  it('검토 링크가 만료됐으면 실패로 남긴다', async () => {
    mocks.loadReview.mockResolvedValue(null);
    expect(await press('lecture:apply')).toMatchSnapshot();
  });

  it('학기 생성에서 실패하면 다시 시도 버튼만 준다', async () => {
    mocks.ensureSemester.mockRejectedValue(new AdminApiError('학기 생성 실패', 'semester', 500));
    expect(await press('lecture:apply')).toMatchSnapshot();
  });

  it('강의 생성 중 실패하면 일부 반영 경고와 확인 창을 단다', async () => {
    mocks.submitLectures.mockRejectedValue(new AdminApiError('강의 생성 실패', 'lectures', 500));
    expect(await press('lecture:apply')).toMatchSnapshot();
  });

  it('강의 생성이 시한 초과로 끊겨도 일부 반영 경고와 확인 창을 단다', async () => {
    mocks.submitLectures.mockRejectedValue(
      new Error('코인 Admin API가 120초 안에 응답하지 않았습니다 — POST /admin/lectures'),
    );
    const result = await press('lecture:apply');
    expect(JSON.stringify(result.updates.at(-1))).toContain('일부가 이미 들어갔을 수 있습니다');
    expect(result).toMatchSnapshot();
  });

  it('취소', async () => {
    expect(await press('lecture:cancel')).toMatchSnapshot();
  });

  it('이미 진행된 작업은 취소하지 않는다', async () => {
    mocks.cancelJob.mockResolvedValue(false);
    expect(await press('lecture:cancel')).toMatchSnapshot();
  });
});
