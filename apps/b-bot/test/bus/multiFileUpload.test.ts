import { beforeEach, describe, expect, it, vi } from 'vitest';

const findBusTokenByThread = vi.fn(async () => null);
const loadBusReview = vi.fn(async () => null);
vi.mock('~/services/bus/reviewStore', () => ({
  findBusTokenByThread: (...args: unknown[]) => (findBusTokenByThread as (...a: unknown[]) => unknown)(...args),
  loadBusReview: (...args: unknown[]) => (loadBusReview as (...a: unknown[]) => unknown)(...args),
  linkBusThread: vi.fn(async () => undefined),
  saveBusPatchPlan: vi.fn(async () => undefined),
}));

vi.mock('~/services/koin/target', () => ({
  resolveTarget: () => ({
    ok: true,
    target: { env: 'stage', label: '스테이지', baseUrl: 'https://api.stage.koreatech.in' },
  }),
}));

vi.mock('~/services/bus/jobStore', () => ({
  createBusJob: vi.fn(async () => undefined),
}));

vi.mock('~/services/bus/pipeline', () => ({
  convertBusToReview: vi.fn(),
}));
vi.mock('~/services/slack/features/bus/blocks', () => ({
  buildReviewApprovalBlocks: vi.fn(),
  buildBusPatchBlocks: vi.fn(),
}));

vi.mock('~/services/bus/patch', () => ({
  planBusPatches: vi.fn(),
}));

function client() {
  const postMessage = vi.fn().mockResolvedValue({ ts: '999.001' });
  return { chat: { postMessage } };
}

const file = (name: string) => ({ id: `F-${name}`, name, filetype: 'binary', size: 100 });

beforeEach(() => {
  vi.clearAllMocks();
  findBusTokenByThread.mockResolvedValue(null);
  loadBusReview.mockResolvedValue(null);
});

describe('!버스반영 여러 파일 첨부', () => {
  it('파일이 두 개면 어느 것도 변환하지 않고 안내만 한다', async () => {
    const { messages } = await import('~/services/slack/features/bus/messages');
    const busHandler = messages.find((m) => m.acceptsFiles)!;
    const mock = client();

    await busHandler.handler({
      client: mock as never,
      channel: 'C1',
      ts: '100.001',
      text: '!버스반영',
      user: 'U1',
      files: [file('천안.xlsx'), file('청주.xls')],
    } as never);

    expect(mock.chat.postMessage).toHaveBeenCalledTimes(1);
    const [call] = mock.chat.postMessage.mock.calls[0];
    const text = JSON.stringify(call.blocks);
    expect(text).toContain('2개 올라왔습니다');
    expect(text).toContain('천안.xlsx');
    expect(text).toContain('청주.xls');
  });
});
