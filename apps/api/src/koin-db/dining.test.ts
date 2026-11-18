import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';
import { readDinings, syncDiningCache } from './dining';
import { memoryDining, memoryKv, mockUpstream } from './tests/dining-fixture';

const dining = {
  id: 11,
  date: '2024-02-29',
  type: 'LUNCH',
  place: 'A코스',
  price_card: 5000,
  price_cash: null,
  kcal: null,
  menu: '["병아리콩밥", "(탕)소고기육개장", "생야채샐러드&D"]',
  image_url: 'https://static.koreatech.in/품절 photo+100%20.jpg',
  created_at: '2024-02-29 00:00:00',
  updated_at: '2024-02-29 23:59:59',
  sold_out: '2024-02-29 23:59:59.123456',
  is_changed: '2024-03-01 00:00:00.001',
  likes: 7,
};
const likesFor = (diningId: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ dining_id: diningId, user_id: index + 1 }));

// bridge는 모든 날짜에 `rows`를, 좋아요는 `likes`를 돌려준다.
function fixture(t: TestContext, rows: unknown = [], likes: unknown = []) {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    requests.push(request);
    return Response.json(new URL(request.url).pathname.endsWith('/dining-likes') ? likes : rows);
  });
  const env = {
    ENVIRONMENT: 'preview',
    KOIN_DB_BRIDGE_TOKEN: 'test-only-bridge-token-with-32-characters',
    DINING: memoryDining().namespace,
  } as Bindings;
  return { env, requests };
}

test('sync stores MySQL menus in date objects; likes come from imported rows, KV only changes with content', async (t) => {
  const dinings = new Map<string, unknown>();
  const likes = new Map([['2024-02-29', likesFor(11, 2)]]);
  mockUpstream(t, { dinings, likes });
  const { kv, store, puts } = memoryKv();
  const objects = memoryDining(kv);
  const env = {
    ENVIRONMENT: 'preview',
    KOIN_DB_BRIDGE_TOKEN: 'test-only-bridge-token-with-32-characters',
    BATCH_KV: kv,
    DINING: objects.namespace,
  } as Bindings;
  const now = new Date('2024-02-29T03:00:00Z');
  dinings.set('2024-02-29', [dining]);
  await syncDiningCache(env, now);
  await objects.flush();
  assert.equal(puts.length, 8);
  assert.deepEqual(JSON.parse(store.get('koin:dining:v1:2024-02-29')!), [{ ...dining, likes: 2 }]);
  assert.equal(objects.store('index').locate(11), '2024-02-29');
  puts.length = 0;
  await syncDiningCache(env, now);
  await objects.flush();
  assert.deepEqual(puts, []);
  // MySQL likes 열 변화는 무시하고, 품절·사진 변화만 다시 쓴다. 좋아요 가져오기는 최초 1회다.
  likes.set('2024-02-29', likesFor(11, 9));
  dinings.set('2024-02-29', [
    { ...dining, likes: 8, sold_out: '2024-02-29 12:00:00', image_url: 'https://static.koreatech.in/new.jpg' },
  ]);
  await syncDiningCache(env, now);
  await objects.flush();
  assert.deepEqual(puts, ['koin:dining:v1:2024-02-29']);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('cache hit must not reach bridge');
  });
  const [served] = (await (await readDinings(env, new URL('https://api.test/dinings?date=240229'))).json()) as Record<
    string,
    unknown
  >[];
  assert.equal(served!.likes, 2);
  assert.equal(served!.soldout_at, '2024-02-29 12:00:00');
  assert.equal(served!.image_url, 'https://static.koreatech.in/new.jpg');
});

test('valid YYMMDD dates request exact bridge calendar dates in 2000–2099', async (t) => {
  for (const [input, expected] of [
    ['000101', '2000-01-01'],
    ['000229', '2000-02-29'],
    ['040229', '2004-02-29'],
    ['240229', '2024-02-29'],
    ['241231', '2024-12-31'],
    ['990101', '2099-01-01'],
    ['991231', '2099-12-31'],
  ]) {
    await t.test(input!, async (context) => {
      const { env, requests } = fixture(context);
      const response = await readDinings(env, new URL(`https://api.test/dinings?date=${input}`));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
      assert.equal(requests[0]!.url, `https://api.stage.koreatech.in/internal/edge/dinings?date=${expected}`);
      assert.equal(requests[0]!.headers.get('Authorization'), `Bearer ${env.KOIN_DB_BRIDGE_TOKEN}`);
      assert.equal(requests[0]!.redirect, 'manual');
    });
  }
});

test('malformed and impossible dates fail before bridge access', async (t) => {
  for (const date of [
    '',
    '24023',
    '20240229',
    '24-02-29',
    '２４０２２９',
    ' 240229',
    '240229 ',
    '230229',
    '990229',
    '000230',
    '240000',
    '240100',
    '241301',
    '240431',
    "240229' OR 1=1 --",
  ]) {
    await t.test(JSON.stringify(date), async (context) => {
      const { env, requests } = fixture(context);
      const url = new URL('https://api.test/dinings');
      url.searchParams.set('date', date);
      await assert.rejects(readDinings(env, url), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'ILLEGAL_ARGUMENT');
        return true;
      });
      assert.deepEqual(requests, []);
    });
  }
});

test('omitted dates follow KST at leap-day and year boundaries', async (t) => {
  for (const [now, expected] of [
    ['2024-02-28T14:59:59.999Z', '2024-02-28'],
    ['2024-02-28T15:00:00.000Z', '2024-02-29'],
    ['2024-02-29T14:59:59.999Z', '2024-02-29'],
    ['2024-02-29T15:00:00.000Z', '2024-03-01'],
    ['2024-12-31T14:59:59.999Z', '2024-12-31'],
    ['2024-12-31T15:00:00.000Z', '2025-01-01'],
  ]) {
    await t.test(now!, async (context) => {
      context.mock.timers.enable({ apis: ['Date'], now: new Date(now!) });
      const { env, requests } = fixture(context);
      await readDinings(env, new URL('https://api.test/dinings'));
      assert.equal(new URL(requests[0]!.url).searchParams.get('date'), expected);
    });
  }
});

test('anonymous JSON preserves types, field order and Java local timestamps without another KST shift', async (t) => {
  const { env } = fixture(t, [dining], likesFor(11, 7));
  const response = await readDinings(env, new URL('https://api.test/dinings?date=240229'));
  const body = (await response.json()) as Record<string, unknown>[];
  const expected = {
    id: 11,
    date: '2024-02-29',
    type: 'LUNCH',
    place: 'A코스',
    price_card: 5000,
    price_cash: null,
    kcal: 0,
    menu: ['병아리콩밥', '(탕)소고기육개장', '생야채샐러드&D'],
    image_url: 'https://static.koreatech.in/품절 photo+100%20.jpg',
    created_at: '2024-02-29 00:00:00',
    updated_at: '2024-02-29 23:59:59',
    soldout_at: '2024-02-29 23:59:59',
    changed_at: '2024-03-01 00:00:00',
    likes: 7,
    is_liked: false,
  };
  assert.deepEqual(body, [expected]);
  assert.deepEqual(Object.keys(body[0]!), Object.keys(expected));
});

test('mapping preserves nullable fields, zero values and bridge row order; likes count imported rows only', async (t) => {
  const { env } = fixture(t, [
    { ...dining, kcal: 0, likes: 0 },
    {
      ...dining,
      id: 19,
      price_card: null,
      kcal: 790,
      menu: '[]',
      image_url: null,
      created_at: null,
      updated_at: null,
      sold_out: null,
      is_changed: null,
      likes: null,
    },
  ]);
  const response = await readDinings(env, new URL('https://api.test/dinings?date=240229'));
  const body = (await response.json()) as Record<string, unknown>[];
  assert.deepEqual(
    body.map((row) => row.id),
    [11, 19],
  );
  assert.equal(body[0]!.kcal, 0);
  assert.equal(body[0]!.likes, 0);
  assert.equal(body[1]!.kcal, 790);
  // MySQL likes 열(null 포함)은 쓰지 않는다. 좋아요 수는 Durable Object 행 수다.
  assert.equal(body[1]!.likes, 0);
  for (const key of ['price_card', 'price_cash', 'image_url', 'created_at', 'updated_at', 'soldout_at', 'changed_at']) {
    assert.equal(body[1]![key], null);
  }
  assert.deepEqual(body[1]!.menu, []);
  assert.ok(body.every((row) => row.is_liked === false));
});

test('menus retain Java quoted-item parsing rather than requiring valid JSON', async (t) => {
  const { env } = fixture(t, [
    { ...dining, menu: 'legacy menu: "밥", "(탕)국", "반찬, 둘", ""' },
    { ...dining, id: 19, menu: 'unquoted legacy text' },
  ]);
  const response = await readDinings(env, new URL('https://api.test/dinings?date=240229'));
  const body = (await response.json()) as Record<string, unknown>[];
  assert.deepEqual(
    body.map((row) => row.menu),
    [['밥', '(탕)국', '반찬, 둘', ''], []],
  );
});

test('blank stored menus retain the existing illegal-state error', async (t) => {
  const { env } = fixture(t, [{ ...dining, menu: ' \n\t' }]);
  await assert.rejects(readDinings(env, new URL('https://api.test/dinings?date=240229')), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'ILLEGAL_STATE');
    return true;
  });
});

test('bridge rejects malformed rows and rows for a different date without retrying', async (t) => {
  for (const rows of [
    {},
    [null],
    [{ ...dining, id: '11' }],
    [{ ...dining, type: 'SNACK' }],
    [{ ...dining, menu: null }],
    [{ ...dining, date: '2024-02-30' }],
    [{ ...dining, date: '2024-03-01' }],
    [{ ...dining, private_field: 'unexpected' }],
  ]) {
    await t.test(JSON.stringify(rows), async (context) => {
      const { env, requests } = fixture(context, rows);
      await assert.rejects(readDinings(env, new URL('https://api.test/dinings?date=240229')), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.code, 'KOIN_DB_BRIDGE_INVALID_RESPONSE');
        return true;
      });
      assert.equal(requests.length, 1);
    });
  }
});
