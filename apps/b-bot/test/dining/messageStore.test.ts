import { getPool } from '@koin/b-bot-database';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { query } from '~/infra/postgres';
import { databaseTest as it, withDatabaseScope } from '../support/databaseScope';
import { ensureDiningMessageSchema, findMessage, markDelivered, saveMessage } from '~/services/dining/messageStore';

const hasTestDb = Boolean(import.meta.env.DB_HOST) && Boolean(import.meta.env.DB_NAME?.endsWith('_test'));

// 실제 제보와 겹치지 않도록 큰 번호를 쓰고 끝나면 지운다.
const TEST_REPORT_BASE = 900_000_000;

describe.skipIf(!hasTestDb)('품절 제보 메시지 저장소', () => {
  let seq = 0;
  const nextReportId = () => TEST_REPORT_BASE + Math.floor(Math.random() * 1_000_000) * 10 + (seq += 1);

  beforeAll(() => withDatabaseScope(ensureDiningMessageSchema));

  afterAll(() =>
    withDatabaseScope(async () => {
      await query(getPool(), `DELETE FROM dining_report_message WHERE report_id >= $1`, [TEST_REPORT_BASE]);
    }),
  );

  it('올린 메시지를 저장하고 다시 찾는다', async () => {
    const reportId = nextReportId();
    await expect(
      saveMessage('stage', reportId, { channelId: 'C1', messageTs: '1791644051.545289' }, 'd-1'),
    ).resolves.toBe(true);

    const found = await findMessage('stage', reportId);
    expect(found).toMatchObject({
      env: 'stage',
      report_id: reportId,
      channel_id: 'C1',
      // ts는 숫자로 바꾸면 끝자리가 달라진다. 문자열 그대로 돌아와야 한다.
      message_ts: '1791644051.545289',
      last_delivery_id: 'd-1',
    });
  });

  it('기록이 없으면 undefined다', async () => {
    await expect(findMessage('stage', nextReportId())).resolves.toBeUndefined();
  });

  it('이미 있는 기록은 덮어쓰지 않는다', async () => {
    const reportId = nextReportId();
    await saveMessage('stage', reportId, { channelId: 'C1', messageTs: '1.1' }, 'd-1');

    await expect(saveMessage('stage', reportId, { channelId: 'C2', messageTs: '2.2' }, 'd-2')).resolves.toBe(false);
    expect(await findMessage('stage', reportId)).toMatchObject({ channel_id: 'C1', message_ts: '1.1' });
  });

  it('스테이지와 프로덕션의 같은 제보 번호는 따로 저장한다', async () => {
    const reportId = nextReportId();
    await saveMessage('stage', reportId, { channelId: 'C_STAGE', messageTs: '1.1' }, 'd-stage');
    await saveMessage('prod', reportId, { channelId: 'C_PROD', messageTs: '2.2' }, 'd-prod');

    expect((await findMessage('stage', reportId))?.channel_id).toBe('C_STAGE');
    expect((await findMessage('prod', reportId))?.channel_id).toBe('C_PROD');
  });

  it('메시지를 고친 뒤 마지막 작업만 바꾼다', async () => {
    const reportId = nextReportId();
    await saveMessage('stage', reportId, { channelId: 'C1', messageTs: '1.1' }, 'd-1');

    await markDelivered('stage', reportId, 'd-2');

    expect(await findMessage('stage', reportId)).toMatchObject({
      channel_id: 'C1',
      message_ts: '1.1',
      last_delivery_id: 'd-2',
    });
  });
});
