import { beforeEach, describe, expect, it, vi } from 'vitest';

const domain = vi.hoisted(() => ({
  answer: vi.fn(),
  classifyRequest: vi.fn(),
  planDashboard: vi.fn(),
  createDashboard: vi.fn(),
}));
const store = vi.hoisted(() => ({
  saveDashboardConfirmation: vi.fn(),
  loadDashboardConfirmation: vi.fn(),
  claimDashboardConfirmation: vi.fn(),
  cancelDashboardConfirmation: vi.fn(),
  finishDashboardConfirmation: vi.fn(),
  expireDashboardConfirmation: vi.fn(),
  recordDashboardAudit: vi.fn(),
}));
vi.mock('~/services/superset', () => domain);
vi.mock('~/services/superset/confirmation', () => store);
import { messages, blockActions } from '~/services/slack/features/superset';

const plan = {
  title: '매출',
  charts: [{ title: '월별 매출', datasetId: 1, chartType: 'bar', columns: [], metrics: ['sales'], groupby: ['month'] }],
};
const token = '00000000-0000-4000-8000-000000000002';
function scenario(user = 'U1') {
  const client = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: '2' }),
      update: vi.fn().mockResolvedValue({}),
      postEphemeral: vi.fn().mockResolvedValue({}),
    },
  };
  const args = { client, channel: 'C1', ts: '1', user, text: '!대시보드 매출 대시보드 만들어줘' };
  const press = {
    client,
    body: { user: { id: user }, channel: { id: 'C1' }, message: { ts: '2' } },
    action: { type: 'button', value: JSON.stringify({ token }) },
  };
  return { client, args, press };
}
beforeEach(() => {
  vi.resetAllMocks();
  domain.classifyRequest.mockResolvedValue('dashboard');
  domain.planDashboard.mockResolvedValue(plan);
  domain.createDashboard.mockResolvedValue('https://superset.example/superset/dashboard/1/');
  store.saveDashboardConfirmation.mockResolvedValue(token);
  store.recordDashboardAudit.mockResolvedValue(undefined);
  store.loadDashboardConfirmation.mockResolvedValue({ userId: 'U1', channelId: 'C1', messageTs: '2', plan });
  store.claimDashboardConfirmation.mockResolvedValue(plan);
  store.finishDashboardConfirmation.mockResolvedValue(undefined);
  store.expireDashboardConfirmation.mockResolvedValue(false);
});
describe('Superset Slack authorization and confirmation', () => {
  it('only previews creation until the requester confirms', async () => {
    const { args, client } = scenario();
    await messages[0].handler(args as never);
    expect(domain.createDashboard).not.toHaveBeenCalled();
    const update = client.chat.update.mock.calls[0][0];
    expect(update.blocks.at(-1).elements.map((b: { action_id: string }) => b.action_id)).toContain('superset:confirm');
    expect(update.blocks[1].text.text).toContain('sales');
  });
  it.each(['superset:confirm', 'superset:cancel'])('rejects another user at %s', async (actionId) => {
    const { press } = scenario('U2');
    store.loadDashboardConfirmation.mockResolvedValue(null);
    await blockActions.find((a) => a.actionId === actionId)!.handler(press as never);
    expect(store.claimDashboardConfirmation).not.toHaveBeenCalled();
    expect(store.cancelDashboardConfirmation).not.toHaveBeenCalled();
    expect(domain.createDashboard).not.toHaveBeenCalled();
  });
  it('does not create on a lost concurrent claim or overwrite the original message', async () => {
    store.claimDashboardConfirmation.mockResolvedValue(null);
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(domain.createDashboard).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalled();
  });
  it('resends the persisted link after final Slack delivery fails without creating again', async () => {
    const { press, client } = scenario();
    client.chat.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Slack update failed'));
    await expect(blockActions[0].handler(press as never)).rejects.toThrow('Slack update failed');
    expect(domain.createDashboard).toHaveBeenCalledTimes(1);
    store.loadDashboardConfirmation.mockResolvedValue({
      userId: 'U1',
      channelId: 'C1',
      messageTs: '2',
      plan,
      status: 'succeeded',
      resultUrl: 'https://superset.example/superset/dashboard/1/',
    });
    await blockActions[0].handler(press as never);
    expect(domain.createDashboard).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '대시보드를 생성했습니다: https://superset.example/superset/dashboard/1/',
      }),
    );
  });
  it('delivers the created link even when the result cannot be recorded', async () => {
    store.finishDashboardConfirmation.mockRejectedValue(new Error('audit unavailable'));
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(domain.createDashboard).toHaveBeenCalledTimes(1);
    expect(store.finishDashboardConfirmation).toHaveBeenCalledWith(
      token,
      'U1',
      true,
      'https://superset.example/superset/dashboard/1/',
    );
    expect(client.chat.update).toHaveBeenLastCalledWith({
      channel: 'C1',
      ts: '2',
      blocks: [],
      text: '대시보드를 생성했습니다: https://superset.example/superset/dashboard/1/',
    });
  });
  it('resends a recorded link for a claimed row and only retries status recording', async () => {
    store.loadDashboardConfirmation.mockResolvedValue({
      userId: 'U1',
      channelId: 'C1',
      messageTs: '2',
      plan,
      status: 'claimed',
      resultUrl: 'https://superset.example/superset/dashboard/1/',
      expiresAt: new Date(Date.now() - 1),
    });
    store.finishDashboardConfirmation.mockRejectedValue(new Error('audit unavailable'));
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(domain.createDashboard).not.toHaveBeenCalled();
    expect(store.claimDashboardConfirmation).not.toHaveBeenCalled();
    expect(store.finishDashboardConfirmation).toHaveBeenCalledWith(
      token,
      'U1',
      true,
      'https://superset.example/superset/dashboard/1/',
    );
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: 'C1',
      user: 'U1',
      text: '대시보드를 생성했습니다: https://superset.example/superset/dashboard/1/',
    });
  });
  it('expires an abandoned claim without creating again', async () => {
    store.loadDashboardConfirmation.mockResolvedValue({
      userId: 'U1',
      channelId: 'C1',
      messageTs: '2',
      plan,
      status: 'claimed',
      resultUrl: null,
      expiresAt: new Date(Date.now() - 1),
    });
    store.expireDashboardConfirmation.mockResolvedValue(true);
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(store.expireDashboardConfirmation).toHaveBeenCalledWith(token, 'U1');
    expect(domain.createDashboard).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Superset에 이미 생성된 대시보드가 있는지 확인') }),
    );
  });
  it('delivers a URL recorded concurrently when expiry is refused', async () => {
    const url = 'https://superset.example/superset/dashboard/9/';
    store.loadDashboardConfirmation
      .mockResolvedValueOnce({
        userId: 'U1',
        channelId: 'C1',
        messageTs: '2',
        plan,
        status: 'claimed',
        resultUrl: null,
        expiresAt: new Date(Date.now() - 1),
      })
      .mockResolvedValueOnce({
        userId: 'U1',
        channelId: 'C1',
        messageTs: '2',
        plan,
        status: 'claimed',
        resultUrl: url,
        expiresAt: new Date(Date.now() - 1),
      });
    store.expireDashboardConfirmation.mockResolvedValue(false);
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(store.expireDashboardConfirmation).toHaveBeenCalledWith(token, 'U1');
    expect(domain.createDashboard).not.toHaveBeenCalled();
    expect(store.finishDashboardConfirmation).toHaveBeenCalledWith(token, 'U1', true, url);
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: 'C1',
      user: 'U1',
      text: `대시보드를 생성했습니다: ${url}`,
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
  });
  it('reports an unconfirmed state without creating when expiry fails', async () => {
    store.loadDashboardConfirmation.mockResolvedValue({
      userId: 'U1',
      channelId: 'C1',
      messageTs: '2',
      plan,
      status: 'claimed',
      resultUrl: null,
      expiresAt: new Date(Date.now() - 1),
    });
    store.expireDashboardConfirmation.mockRejectedValue(new Error('database unavailable'));
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(domain.createDashboard).not.toHaveBeenCalled();
    expect(store.loadDashboardConfirmation).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('확인하지 못했어요') }),
    );
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
  });
  it('reports expiry when the refusal leaves nothing claimed', async () => {
    store.loadDashboardConfirmation
      .mockResolvedValueOnce({
        userId: 'U1',
        channelId: 'C1',
        messageTs: '2',
        plan,
        status: 'claimed',
        resultUrl: null,
        expiresAt: new Date(Date.now() - 1),
      })
      .mockResolvedValueOnce(null);
    store.expireDashboardConfirmation.mockResolvedValue(false);
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(domain.createDashboard).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Superset에 이미 생성된 대시보드가 있는지 확인') }),
    );
  });
  it('waits on an unexpired claim without creating again', async () => {
    store.loadDashboardConfirmation.mockResolvedValue({
      userId: 'U1',
      channelId: 'C1',
      messageTs: '2',
      plan,
      status: 'claimed',
      resultUrl: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { press, client } = scenario();
    await blockActions[0].handler(press as never);
    expect(store.expireDashboardConfirmation).not.toHaveBeenCalled();
    expect(domain.createDashboard).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '대시보드를 생성하는 중이에요. 잠시 후 다시 확인해주세요.' }),
    );
  });
  it('does not overwrite a concurrent creation when cancellation loses its claim', async () => {
    store.cancelDashboardConfirmation.mockResolvedValue(false);
    const { press, client } = scenario();
    await blockActions[1].handler(press as never);
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalled();
    expect(domain.createDashboard).not.toHaveBeenCalled();
  });
  it('answers a question without offering a creation action or enabling model mentions', async () => {
    domain.classifyRequest.mockResolvedValue('answer');
    domain.answer.mockResolvedValue('매출 100원 <!channel>');
    const { args, client } = scenario('U_NEW');
    args.channel = 'C_NEW';
    args.text = '!대시보드 지난달 매출은?';
    await messages[0].handler(args as never);
    expect(client.chat.update.mock.calls[0][0].text).toBe('매출 100원 &lt;!channel&gt;');
    expect(store.saveDashboardConfirmation).not.toHaveBeenCalled();
    expect(domain.createDashboard).not.toHaveBeenCalled();
  });
  it('keeps the underlying cause of a failed request visible', async () => {
    domain.planDashboard.mockRejectedValue(new Error('Superset GET /api/v1/dataset/29 failed (403).'));
    const { args, client } = scenario();
    await messages[0].handler(args as never);
    const text = client.chat.update.mock.calls.at(-1)![0].text;
    expect(text).toContain('요청을 처리하지 못했어요');
    expect(text).toContain('Superset GET /api/v1/dataset/29 failed (403).');
  });
  it('redacts credentials from a surfaced failure cause', async () => {
    domain.planDashboard.mockRejectedValue(new Error('login rejected for xoxb-1234-secret and sk-ant-abcdefghijkl'));
    const { args, client } = scenario();
    await messages[0].handler(args as never);
    const text = client.chat.update.mock.calls.at(-1)![0].text;
    expect(text).not.toContain('xoxb-1234-secret');
    expect(text).not.toContain('sk-ant-abcdefghijkl');
    expect(text).toContain('[redacted]');
  });
});
