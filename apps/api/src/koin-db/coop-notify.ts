import { captureError } from '@koin/telemetry/runtime';
import { z } from 'zod';
import { ApiError } from '@api/errors';
import { FcmError, sendFcmMessage } from '@api/integrations/push';
import { fetchBridge, invalidBridgeResponse } from '@api/koin-db/bridge';
import type { CoopStore, DiningType, OutboxJob } from '@api/koin-db/coop-store';
import type { Bindings } from '@api/runtime';

const coopOpens = z
  .object({
    semester_id: z.number().int().nullable(),
    coop_name_id: z.number().int().nullable(),
    shop_id: z.number().int().nullable(),
    opens: z
      .object({
        day_of_week: z.string(),
        type: z.string().nullable(),
        open_time: z.string().nullable(),
        close_time: z.string().nullable(),
      })
      .strict()
      .array(),
  })
  .strict();
type CoopOpens = z.infer<typeof coopOpens>;

// 학생식당 운영 시간은 관리자 화면에서만 바뀐다. isolate마다 1분 캐시한다.
const OPENS_CACHE_MS = 60_000;
let opensCache: { value: CoopOpens; expires: number } | null = null;

const KST_OFFSET_MS = 9 * 3_600_000;
const mealNames: Record<DiningType, string> = { BREAKFAST: '아침', LUNCH: '점심', DINNER: '저녁' };
const weekdays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/**
 * Java 시계 기준의 LocalDateTime을 UTC epoch처럼 담은 값. 운영 JVM은 시간대 지정 없이 호스트(Asia/Seoul)를 따르므로
 * DiningReportService·CoopNotificationService·CoopService 모두 한국시간이다.
 */
export const javaWall = {
  kst: (ms: number) => ms + KST_OFFSET_MS,
  jvm: (ms: number) => ms + KST_OFFSET_MS,
};

/** CoopShop.getOpensOn + CoopShopService.isOpenAt. 요일 개별 시간표가 있으면 평일·주말 설정을 쓰지 않는다. */
export function openedAt(opens: CoopOpens['opens'], wallMs: number, type: DiningType, early: boolean): boolean {
  const now = new Date(wallMs);
  const day = weekdays[now.getUTCDay()]!;
  const specific = opens.filter((open) => open.day_of_week === day);
  const grouped = now.getUTCDay() === 0 || now.getUTCDay() === 6 ? 'WEEKEND' : 'WEEKDAYS';
  const selected = specific.length ? specific : opens.filter((open) => open.day_of_week === grouped);
  const seconds = (wallMs - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 1000;
  return selected.some((open) => {
    if (open.type !== mealNames[type] || open.open_time === null || open.close_time === null) return false;
    const parse = (value: string) => {
      const match = /^(\d{2}):(\d{2})$/.exec(value);
      return match && Number(match[1]) <= 23 && Number(match[2]) <= 59
        ? Number(match[1]) * 3600 + Number(match[2]) * 60
        : null;
    };
    const openAt = parse(open.open_time);
    const closeAt = parse(open.close_time);
    if (openAt === null || closeAt === null) return false;
    return seconds >= openAt - (early ? 3600 : 0) && seconds <= closeAt;
  });
}

async function loadOpens(env: Bindings): Promise<CoopOpens> {
  const now = Date.now();
  if (opensCache && opensCache.expires > now) return opensCache.value;
  const parsed = coopOpens.safeParse(await fetchBridge(env, 'coop-opens', {}));
  if (!parsed.success) throw invalidBridgeResponse();
  opensCache = { value: parsed.data, expires: now + OPENS_CACHE_MS };
  return parsed.data;
}

export function clearCoopOpensCache(): void {
  opensCache = null;
}

/**
 * CoopShopService.getIsOpened(now, CAFETERIA, type, isMinus). 적용 학기·학생식당 매장이 없으면 Java와 같은
 * DataNotFoundException 응답(404, 빈 code)을 던진다.
 */
export async function cafeteriaOpened(
  env: Bindings,
  wallMs: number,
  type: DiningType,
  early: boolean,
): Promise<boolean> {
  const data = await loadOpens(env);
  if (data.semester_id === null) throw new ApiError(404, '', '해당 학기가 존재하지 않습니다. ');
  if (data.coop_name_id === null) {
    throw new ApiError(404, '', '해당 생협 매장이 존재하지 않습니다. coopShopType : CAFETERIA');
  }
  if (data.shop_id === null) {
    throw new ApiError(
      404,
      '',
      `해당 생협 매장이 존재하지 않습니다. coopNameId : ${data.coop_name_id}, semesterId: ${data.semester_id}`,
    );
  }
  return openedAt(data.opens, wallMs, type, early);
}

const targets = z.object({ user_id: z.number().int(), device_token: z.string() }).strict().array();

/**
 * NotificationSubscribeRepository 조회와 같은 대상의 기기 토큰. 품절은 DINING_SOLD_OUT 전체 구독 + 해당 끼니 세부 구독,
 * 사진은 DINING_IMAGE_UPLOAD 전체 구독이며 둘 다 기기 토큰이 있는(탈퇴하지 않은) 회원만이다.
 */
async function notificationTargets(env: Bindings, job: OutboxJob): Promise<string[]> {
  const query: Record<string, string> =
    job.kind === 'soldout' ? { type: 'DINING_SOLD_OUT', detail: job.payload.type! } : { type: 'DINING_IMAGE_UPLOAD' };
  const parsed = targets.safeParse(await fetchBridge(env, 'dining-notification-targets', query));
  if (!parsed.success) throw invalidBridgeResponse();
  return parsed.data.map((target) => target.device_token);
}

/** FCM v1 Message(학식 알림). */
export interface DiningPushMessage {
  token: string;
  android: {
    priority: 'HIGH';
    data: { title: string; content: string; imageUrl: string; url: string; type: string };
  };
  apns: {
    payload: {
      aps: { alert: { title: string; body: string }; sound: string; category: string; 'mutable-content': number };
      type: string;
      schemeUri: string;
    };
    fcm_options?: { image: string };
  };
}

/**
 * NotificationFactory + FcmClient.sendMessages와 같은 FCM v1 메시지. path=DINING("dining"),
 * schemeUri="dining?id=<식단 ID>", type="message"이고 Android는 data 전용·HIGH, iOS는 alert·category다.
 */
export function diningPushMessage(token: string, job: OutboxJob): DiningPushMessage {
  const id = job.payload.dining_id;
  let title: string;
  let body: string;
  let image: string | null = null;
  if (job.kind === 'soldout') {
    const place = job.payload.place!;
    // NotificationFactory.getPostposition: 마지막 글자 받침 유무(한글이 아니면 음수 나머지 → "가").
    const particle = (place.charCodeAt(place.length - 1) - 0xac00) % 28 > 0 ? '이' : '가';
    title = `${place}${particle} 품절됐어요 \u{1F622}`;
    body = '다른 코너 메뉴도 확인해보세요';
  } else {
    title = '식단 사진이 업로드 됐어요!';
    body = '사진 보러 가기 \u{1F60B}';
    image = job.payload.image_url ?? null;
  }
  const schemeUri = `dining?id=${id}`;
  return {
    token,
    android: {
      priority: 'HIGH',
      data: { title, content: body, imageUrl: image ?? '', url: `koin://${schemeUri}`, type: 'message' },
    },
    apns: {
      payload: {
        aps: { alert: { title, body }, sound: 'default', category: 'dining', 'mutable-content': 1 },
        type: 'message',
        schemeUri,
      },
      ...(image === null ? {} : { fcm_options: { image } }),
    },
  };
}

const SEND_BATCH = 500;
const SEND_CONCURRENCY = 25;
// Java 리스너는 실패한 알림을 버린다. 대상 조회 중 일시 장애만 이 시간 안에서 다시 시도한다.
const RETRY_WINDOW_MS = 10 * 60_000;

/**
 * 알림 outbox의 맨 앞 작업을 한 단계 진행한다(대상 조회 또는 최대 500건 전송). FCM 개별 실패는 Java처럼
 * 무시한다. 다음 alarm 시각(ms)을, 남은 작업이 없으면 null을 돌려준다.
 */
export async function runCoopOutbox(env: Bindings, store: CoopStore, nowMs = Date.now()): Promise<number | null> {
  const job = store.outboxHead();
  if (!job) return null;
  if (job.next_attempt_at > nowMs) return job.next_attempt_at;
  if (job.targets === null) {
    try {
      if (job.kind === 'soldout') {
        if (
          !store.soldoutStillDue(job, nowMs) ||
          !(await cafeteriaOpened(env, javaWall.kst(nowMs), job.payload.type!, false))
        ) {
          store.outboxDrop(job.id);
          return nowMs;
        }
      }
      job.targets = await notificationTargets(env, job);
      job.cursor = 0;
      store.outboxTargets(job.id, job.targets);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 500 && nowMs - job.created_at < RETRY_WINDOW_MS) {
        store.outboxRetry(job, nowMs);
        return store.outboxHead()?.next_attempt_at ?? null;
      }
      captureError(error);
      store.outboxDrop(job.id);
      return nowMs;
    }
  }
  const batch = job.targets.slice(job.cursor, job.cursor + SEND_BATCH);
  let failure: unknown = null;
  for (let index = 0; index < batch.length; index += SEND_CONCURRENCY) {
    const results = await Promise.allSettled(
      batch.slice(index, index + SEND_CONCURRENCY).map((token) => sendFcmMessage(env, diningPushMessage(token, job))),
    );
    for (const result of results) {
      // 만료 토큰 등 메시지별 FCM 오류는 Java도 결과만 기록하고 넘어간다.
      if (result.status === 'rejected' && !(result.reason instanceof FcmError)) failure ??= result.reason;
    }
  }
  if (failure !== null) captureError(failure);
  const cursor = job.cursor + batch.length;
  if (cursor >= job.targets.length) store.outboxFinish(job, Date.now());
  else store.outboxAdvance(job.id, cursor);
  return Date.now();
}
