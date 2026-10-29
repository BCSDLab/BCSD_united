import { describe, expect, it, vi } from 'vitest';
import { deliver, type MessageStore, type SlackChat } from '~/services/dining/deliver';
import type { DiningReportMessage } from '~/services/dining/messageStore';
import type { BotReportDetail, DeliveryJob } from '~/services/dining/types';
import { enabledWorkerEnvs } from '~/services/dining/worker';

const report: BotReportDetail = {
  report_id: 1,
  dining: { id: 398296, date: '2026-10-08', type: 'BREAKFAST', place: 'A코너' },
  status: 'PENDING',
  processing_type: null,
  reason: null,
  created_at: '2026-10-08 15:34:14',
  processed_at: null,
  processor: null,
  image_url: 'https://stage-static.koreatech.in/upload/COOP/96.jpg',
  processing_id: null,
  source_report_id: null,
  updated_at: '2026-10-08 15:34:14',
};

const NOW = Date.parse('2026-10-08T15:35:00+09:00');

const job = (deliveryId = 'd-1', expiresAt = '2026-10-08T15:36:00+09:00'): DeliveryJob => ({
  delivery_id: deliveryId,
  attempt_token: '00000000-0000-4000-8000-000000000001',
  expires_at: expiresAt,
  report,
});

function memoryStore(initial?: Partial<DiningReportMessage>) {
  const rows = new Map<number, DiningReportMessage>();
  if (initial) {
    rows.set(1, {
      env: 'stage',
      report_id: 1,
      channel_id: 'C_STAGE',
      message_ts: '1.1',
      last_delivery_id: 'd-0',
      created_at: '',
      updated_at: '',
      ...initial,
    });
  }
  const store: MessageStore = {
    findMessage: vi.fn(async (_env, reportId) => rows.get(reportId)),
    saveMessage: vi.fn(async (env, reportId, message, deliveryId) => {
      rows.set(reportId, {
        env,
        report_id: reportId,
        channel_id: message.channelId,
        message_ts: message.messageTs,
        last_delivery_id: deliveryId,
        created_at: '',
        updated_at: '',
      });
      return true;
    }),
    replaceMessage: vi.fn(async (env, reportId, message, deliveryId) => {
      rows.set(reportId, {
        ...rows.get(reportId)!,
        channel_id: message.channelId,
        message_ts: message.messageTs,
        last_delivery_id: deliveryId,
      });
    }),
    markDelivered: vi.fn(async (_env, reportId, deliveryId) => {
      rows.set(reportId, { ...rows.get(reportId)!, last_delivery_id: deliveryId });
    }),
  };
  return { store, rows };
}

function fakeSlack() {
  return {
    postMessage: vi.fn(async () => ({ ok: true, channel: 'C_STAGE', ts: '1791644051.545289' })),
    update: vi.fn(async () => ({ ok: true })),
  } as unknown as SlackChat & { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
}

const slackError = (error: string, messages: string[] = []) =>
  Object.assign(new Error(`An API error occurred: ${error}`), {
    data: { ok: false, error, response_metadata: { messages } },
  });

const context = (slack: SlackChat, store: MessageStore) => ({
  env: 'stage' as const,
  channelId: 'C_STAGE',
  adminUrl: 'https://admin.stage.koreatech.in/sold-out-report',
  slack,
  store,
  now: () => NOW,
});

describe('품절 제보 전송', () => {
  it('처음 오는 제보는 채널에 새로 올리고 위치를 저장한다', async () => {
    const slack = fakeSlack();
    const { store, rows } = memoryStore();

    await expect(deliver(job(), context(slack, store))).resolves.toBe('SUCCEEDED');

    expect(slack.postMessage).toHaveBeenCalledOnce();
    expect(slack.postMessage.mock.calls[0][0]).toMatchObject({ channel: 'C_STAGE' });
    expect(slack.update).not.toHaveBeenCalled();
    expect(rows.get(1)).toMatchObject({ message_ts: '1791644051.545289', last_delivery_id: 'd-1' });
  });

  it('이미 올린 제보는 기존 메시지를 고친다', async () => {
    const slack = fakeSlack();
    const { store, rows } = memoryStore({ channel_id: 'C_OLD', message_ts: '9.9' });

    await expect(deliver(job('d-2'), context(slack, store))).resolves.toBe('SUCCEEDED');

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.update.mock.calls[0][0]).toMatchObject({ channel: 'C_OLD', ts: '9.9' });
    expect(rows.get(1)?.last_delivery_id).toBe('d-2');
  });

  it('이미 반영한 작업이 다시 오면 슬랙을 건드리지 않는다', async () => {
    const slack = fakeSlack();
    const { store } = memoryStore({ last_delivery_id: 'd-1' });

    await expect(deliver(job('d-1'), context(slack, store))).resolves.toBe('SUCCEEDED');

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.update).not.toHaveBeenCalled();
  });

  it('기한이 얼마 안 남았으면 슬랙 호출을 시작하지 않는다', async () => {
    const slack = fakeSlack();
    const { store } = memoryStore();

    await expect(deliver(job('d-1', '2026-10-08T15:35:10+09:00'), context(slack, store))).resolves.toBe('FAILED');

    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('사진을 못 받아오면 사진 없이 다시 보낸다', async () => {
    const slack = fakeSlack();
    slack.postMessage.mockRejectedValueOnce(
      slackError('invalid_blocks', ['[ERROR] downloading image failed [json-pointer:/blocks/1/image_url]']),
    );
    const { store, rows } = memoryStore();

    await expect(deliver(job(), context(slack, store))).resolves.toBe('SUCCEEDED');

    expect(slack.postMessage).toHaveBeenCalledTimes(2);
    const retried = JSON.stringify(slack.postMessage.mock.calls[1][0]);
    expect(retried).toContain('사진을 불러오지 못했습니다.');
    expect(retried).not.toContain('"type":"image"');
    expect(rows.get(1)?.last_delivery_id).toBe('d-1');
  });

  it('기존 메시지가 지워졌으면 새로 올리고 위치를 바꾼다', async () => {
    const slack = fakeSlack();
    slack.update.mockRejectedValueOnce(slackError('message_not_found'));
    const { store, rows } = memoryStore({ channel_id: 'C_STAGE', message_ts: '9.9' });

    await expect(deliver(job('d-2'), context(slack, store))).resolves.toBe('SUCCEEDED');

    expect(slack.postMessage).toHaveBeenCalledOnce();
    expect(rows.get(1)).toMatchObject({ message_ts: '1791644051.545289', last_delivery_id: 'd-2' });
  });

  it('그 밖의 슬랙 오류는 그대로 던져 실패로 통보하게 한다', async () => {
    const slack = fakeSlack();
    slack.postMessage.mockRejectedValueOnce(slackError('channel_not_found'));
    const { store, rows } = memoryStore();

    await expect(deliver(job(), context(slack, store))).rejects.toThrow('channel_not_found');
    expect(rows.size).toBe(0);
  });
});

describe('워커를 돌릴 환경', () => {
  it('적힌 환경만 돌리고 기본값은 없다', () => {
    expect(enabledWorkerEnvs(undefined)).toEqual([]);
    expect(enabledWorkerEnvs('')).toEqual([]);
    expect(enabledWorkerEnvs('stage')).toEqual(['stage']);
    expect(enabledWorkerEnvs(' stage , prod ')).toEqual(['stage', 'prod']);
    expect(enabledWorkerEnvs('production')).toEqual([]);
  });
});
