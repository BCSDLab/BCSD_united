import { captureError } from '@koin/telemetry/runtime';
import { z } from 'zod';
import { fail, kstDate, menuItems, parseDate } from '@api/domains/dining/protocol';
import { ApiError } from '@api/errors';
import { fetchBridge, invalidBridgeResponse } from '@api/koin-db/bridge';
import { diningCacheKey, diningRows, type DiningRow, type LikePair, type LikeResult } from '@api/koin-db/dining-store';
import type { Bindings } from '@api/runtime';

const likePairs = z.object({ dining_id: z.number().int().nonnegative(), user_id: z.number().int() }).strict().array();
// cron 범위(KST 어제~6일 뒤) 밖 날짜는 조회 시 이 주기로 bridge에서 다시 맞춘다.
const STALE_AFTER_MS = 10 * 60_000;

// Bridge는 TIMESTAMP를 Java의 UTC 응답으로 직렬화한다. DATETIME은 다시 시차 보정하지 않는다.
export function localTimestamp(value: string | null): string | null {
  return value === null ? null : value.slice(0, 19);
}

async function fetchDiningRows(env: Bindings, date: string): Promise<DiningRow[]> {
  const parsed = diningRows.safeParse(await fetchBridge(env, 'dinings', { date }));
  if (!parsed.success || parsed.data.some((row) => row.date !== date)) throw invalidBridgeResponse();
  return parsed.data;
}

async function fetchLikePairs(env: Bindings, date: string): Promise<LikePair[]> {
  const parsed = likePairs.safeParse(await fetchBridge(env, 'dining-likes', { date }));
  if (!parsed.success) throw invalidBridgeResponse();
  return parsed.data;
}

export function diningObject(env: Bindings, name: string) {
  if (!env.DINING) throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', '학식 저장소가 설정되지 않았습니다.');
  return env.DINING.get(env.DINING.idFromName(name));
}

/** 품절·사진·품절 제보 소유권이 Durable Object("coop")에 있는지(cutover). */
export const coopOwner = (env: Bindings) => env.KOIN_DINING_COOP_OWNER === 'true';

/**
 * bridge 식단을 날짜 Durable Object와 ID 색인에 맞춘다. 소유권 전환 뒤에는 품절·사진을 coop DO 값으로 덮는다
 * (MySQL 값은 더 이상 동기화하지 않는다). 좋아요를 아직 가져오지 않았거나 `importLikes`면
 * MySQL dining_likes도 insert-or-ignore로 가져온다.
 */
export async function refreshDiningDate(env: Bindings, date: string, importLikes = false): Promise<number> {
  const rows = await fetchDiningRows(env, date);
  const owned = coopOwner(env) ? await diningObject(env, 'coop').ownedFor(date) : null;
  const stub = diningObject(env, date);
  const { imported } = await stub.sync(date, rows, owned);
  if (rows.length)
    await diningObject(env, 'index').remember(
      date,
      rows.map((row) => row.id),
    );
  if (imported && !importLikes) return 0;
  return (await stub.importLikes(await fetchLikePairs(env, date))).inserted;
}

/** KST 어제~6일 뒤 식단을 Durable Object에 맞춘다. KV 스냅샷은 바뀐 날짜만 DO alarm이 쓴다. */
export async function syncDiningCache(env: Bindings, now: Date): Promise<void> {
  if (!env.DINING) return;
  const today = Date.parse(`${kstDate(now)}T00:00:00Z`);
  const failures: unknown[] = [];
  for (let offset = -1; offset <= 6; offset++) {
    const date = new Date(today + offset * 86_400_000).toISOString().slice(0, 10);
    try {
      await refreshDiningDate(env, date);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Dining sync failed');
}

async function cachedRows(env: Bindings, date: string): Promise<DiningRow[] | null> {
  if (!env.BATCH_KV) return null;
  const cached = await env.BATCH_KV.get(diningCacheKey(date), 'json').catch(() => null);
  const parsed = diningRows.safeParse(cached);
  return parsed.success && parsed.data.every((row) => row.date === date) ? parsed.data : null;
}

/** Java `@DateTimeFormat(pattern = "yyMMdd")`, 생략 시 KST 오늘. */
export function diningDate(url: URL): string {
  const query = url.searchParams.get('date');
  return query === null
    ? kstDate(new Date())
    : /^\d{6}$/.test(query)
      ? parseDate(`20${query.slice(0, 2)}-${query.slice(2, 4)}-${query.slice(4, 6)}`)
      : fail('ILLEGAL_ARGUMENT');
}

/**
 * GET /dinings. 익명은 KV 스냅샷만 읽고, 없으면 날짜 DO(필요 시 bridge 적재)를 읽은 뒤 KV를 다시 쓰게 한다.
 * 로그인 사용자는 DO에서 is_liked를 계산한다. 응답 필드·순서는 Java DiningResponse와 같다.
 */
export async function readDinings(env: Bindings, url: URL, userId: number | null = null): Promise<Response> {
  const date = diningDate(url);
  let rows = userId === null ? await cachedRows(env, date) : null;
  let liked = new Set<number>();
  if (!rows) {
    const stub = diningObject(env, date);
    let view = await stub.view(userId, userId === null);
    if (view.syncedAt === null || !view.imported) {
      await refreshDiningDate(env, date);
      view = await stub.view(userId);
    } else if (Date.now() - view.syncedAt > STALE_AFTER_MS) {
      try {
        await refreshDiningDate(env, date);
        view = await stub.view(userId);
      } catch (error) {
        // 이미 적재한 날짜는 bridge 장애 중에도 마지막 상태로 응답한다.
        captureError(error);
      }
    }
    rows = view.rows;
    liked = new Set(view.liked);
  }
  return Response.json(
    rows.map((row) => ({
      id: row.id,
      date: row.date,
      type: row.type,
      place: row.place,
      price_card: row.price_card,
      price_cash: row.price_cash,
      kcal: row.kcal ?? 0,
      menu: menuItems(row.menu),
      image_url: row.image_url,
      created_at: localTimestamp(row.created_at),
      updated_at: localTimestamp(row.updated_at),
      soldout_at: localTimestamp(row.sold_out),
      changed_at: localTimestamp(row.is_changed),
      likes: row.likes,
      is_liked: liked.has(row.id),
    })),
  );
}

/** PATCH /dining/like(/cancel). Java 예외 메시지(KoinException.getFullMessage)와 빈 code를 그대로 쓴다. */
export async function likeDining(env: Bindings, userId: number, diningId: number, liked: boolean): Promise<void> {
  const date = await diningObject(env, 'index').locate(diningId);
  let result: LikeResult = date === null ? (liked ? 'MENU_NOT_FOUND' : 'LIKE_NOT_FOUND') : 'NOT_READY';
  if (date !== null) {
    const stub = diningObject(env, date);
    result = await stub.like(userId, diningId, liked);
    if (result === 'NOT_READY') {
      await refreshDiningDate(env, date);
      result = await stub.like(userId, diningId, liked);
    }
  }
  switch (result) {
    case 'OK':
      return;
    case 'DUPLICATE_LIKE':
      throw new ApiError(409, '', `이미 좋아요를 누른 식단입니다! diningId: '${diningId}'userId: ${userId}`);
    case 'LIKE_NOT_FOUND':
      throw new ApiError(404, '', `좋아요를 누른적이 없는 식단입니다! diningId: '${diningId}'userId: ${userId}`);
    case 'MENU_NOT_FOUND':
      throw new ApiError(404, '', `존재하지 않는 메뉴입니다. menuId: ${diningId}`);
    default:
      throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', '학식 저장소가 준비되지 않았습니다.');
  }
}

export const MAX_IMPORT_DAYS = 62;

/**
 * from~to(포함) 날짜마다 식단을 맞추고 MySQL 좋아요를 insert-or-ignore로 가져온다. 반복 실행해도 같은 결과다.
 * 실패하면 그 날짜에서 멈추고 완료한 마지막 날짜를 알려 이어서 실행할 수 있게 한다.
 */
export async function importDiningLikes(env: Bindings, from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const days = (Date.parse(`${to}T00:00:00Z`) - start) / 86_400_000 + 1;
  if (!(days >= 1 && days <= MAX_IMPORT_DAYS)) fail('ILLEGAL_ARGUMENT');
  let inserted = 0;
  let completed: string | null = null;
  for (let day = 0; day < days; day++) {
    const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
    try {
      inserted += await refreshDiningDate(env, date, true);
    } catch (error) {
      captureError(error);
      return { ok: false as const, from, to, completed, failed: date, inserted };
    }
    completed = date;
  }
  return { ok: true as const, from, to, completed, failed: null, inserted };
}
