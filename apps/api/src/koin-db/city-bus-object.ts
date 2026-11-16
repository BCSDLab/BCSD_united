import { DurableObject } from 'cloudflare:workers';
import { CityBusLive, trackingMode, type HistoryQuery } from '@api/koin-db/city-bus-live';
import type { Bindings } from '@api/runtime';

/**
 * 천안 시내버스 실시간·도착 이력 원본. 인스턴스는 "cheonan" 하나다.
 * cron이 1분마다 tick을 부르고, GET /bus(시내버스)·/bus/city/arrival-history가 RPC로 읽는다.
 */
export class CityBusDurableObject extends DurableObject<Bindings> {
  private readonly live: CityBusLive;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.live = new CityBusLive(ctx.storage.sql, (operation) => ctx.storage.transactionSync(operation), {
      key: env.TAGO_SERVICE_KEY,
      kv: env.BATCH_KV,
      mode: trackingMode(env.CITY_BUS_TRACKING),
    });
  }

  tick(now: number): Promise<void> {
    return this.live.tick(now);
  }

  remain(departNodes: string[], arrivalNodes: string[], now: number) {
    return this.live.remain(departNodes, arrivalNodes, now);
  }

  history(query: HistoryQuery) {
    return this.live.history(query);
  }
}
