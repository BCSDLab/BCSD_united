import { DurableObject } from 'cloudflare:workers';
import { CoopObject } from '@api/koin-db/coop-object';
import {
  CoopStore,
  type Actor,
  type ChangeRow,
  type DeliveryOutcome,
  type DiningMeta,
  type ImportedDining,
  type ImportedReport,
  type Opened,
} from '@api/koin-db/coop-store';
import {
  diningCacheKey,
  DINING_CACHE_TTL_SECONDS,
  DiningStore,
  type DiningRow,
  type LikePair,
  type LikeResult,
  type OwnedEntry,
} from '@api/koin-db/dining-store';
import type { Bindings } from '@api/runtime';

/**
 * KST 날짜 하나(idFromName(YYYY-MM-DD))의 식단·좋아요 원본. 이름이 "index"인 인스턴스는 식단 ID → 날짜 색인만,
 * "coop"인 인스턴스는 품절·사진 소유 값·품절 제보·알림 outbox(CoopObject)만 둔다.
 * 날짜 DO는 변경이 생기면 1초 뒤 alarm으로 BATCH_KV 스냅샷을 다시 써서 익명 조회는 KV만 읽는다(키당 초당 1회 쓰기 제한 준수).
 */
export class DiningDurableObject extends DurableObject<Bindings> {
  private readonly store: DiningStore;
  private coopObject: CoopObject | null = null;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.store = new DiningStore(ctx.storage.sql, (operation) => ctx.storage.transactionSync(operation));
  }

  private get coop(): CoopObject {
    this.coopObject ??= new CoopObject(
      new CoopStore(this.ctx.storage.sql, (operation) => this.ctx.storage.transactionSync(operation)),
      this.env,
      (date) => this.env.DINING!.get(this.env.DINING!.idFromName(date)),
      async (at) => {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > at) await this.ctx.storage.setAlarm(at);
      },
    );
    return this.coopObject;
  }

  private async publishLater(): Promise<void> {
    if (this.store.pendingSnapshot() && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }

  /** KV 스냅샷이 만료·유실됐으면 republish로 다시 쓰게 한다. */
  async view(userId: number | null, republish = false) {
    if (republish) this.store.markPublished(null);
    await this.publishLater();
    return this.store.view(userId);
  }

  /** bridge 행과 coop 소유 값(null이면 MySQL 값)을 함께 반영해 중간 상태를 공개하지 않는다. */
  async sync(date: string, rows: DiningRow[], owned: OwnedEntry[] | null) {
    const result = this.store.sync(date, rows, Date.now());
    this.store.applyOwned(owned);
    await this.publishLater();
    return result;
  }

  async applyOwned(entries: OwnedEntry[] | null): Promise<void> {
    this.store.applyOwned(entries);
    await this.publishLater();
  }

  diningMeta(id: number) {
    return this.store.diningMeta(id);
  }

  async importLikes(pairs: LikePair[]) {
    const result = this.store.importLikes(pairs);
    await this.publishLater();
    return result;
  }

  async like(userId: number, diningId: number, liked: boolean): Promise<LikeResult> {
    const result = liked ? this.store.like(userId, diningId) : this.store.cancel(userId, diningId);
    if (result === 'OK') await this.publishLater();
    return result;
  }

  remember(date: string, ids: number[]): void {
    this.store.remember(date, ids);
  }

  locate(id: number): string | null {
    return this.store.locate(id);
  }

  locateMany(ids: number[]) {
    return this.store.locateMany(ids);
  }

  // ── "coop" 인스턴스 ──────────────────────────────────────────────────────

  ownedFor(date: string) {
    return this.coop.ownedFor(date);
  }

  ownedRange(from: string, to: string) {
    return this.coop.ownedRange(from, to);
  }

  ownedByIds(ids: number[]) {
    return this.coop.ownedByIds(ids);
  }

  createReport(meta: DiningMeta, reporterId: number, imageUrl: string, nowMs: number) {
    return this.coop.createReport(meta, reporterId, imageUrl, nowMs);
  }

  reportDining(reportId: number) {
    return this.coop.reportDining(reportId);
  }

  decide(reportId: number, actor: Actor, result: 'APPROVED' | 'REJECTED', nowMs: number, opened: Opened) {
    return this.coop.decide(reportId, actor, result, nowMs, opened);
  }

  changeSoldOut(meta: DiningMeta, soldOut: boolean, nowMs: number, opened: Opened) {
    return this.coop.changeSoldOut(meta, soldOut, nowMs, opened);
  }

  saveImage(meta: DiningMeta, imageUrl: string, nowMs: number, opened: boolean) {
    return this.coop.saveImage(meta, imageUrl, nowMs, opened);
  }

  claim(nowMs: number) {
    return this.coop.claim(nowMs);
  }

  recordResult(deliveryId: string, token: string, outcome: DeliveryOutcome, nowMs: number) {
    return this.coop.recordResult(deliveryId, token, outcome, nowMs);
  }

  botReport(reportId: number) {
    return this.coop.botReport(reportId);
  }

  adminReport(reportId: number) {
    return this.coop.adminReport(reportId);
  }

  adminReports(onlyPending: boolean, page: number, limit: number) {
    return this.coop.adminReports(onlyPending, page, limit);
  }

  excelGuard(startDate: string, endDate: string, nowMs: number) {
    return this.coop.excelGuard(startDate, endDate, nowMs);
  }

  importBegin(force: boolean) {
    return this.coop.importBegin(force);
  }

  importDinings(rows: ImportedDining[]) {
    this.coop.importDinings(rows);
  }

  importReports(rows: ImportedReport[]) {
    this.coop.importReports(rows);
  }

  importChanges(rows: ChangeRow[]) {
    this.coop.importChanges(rows);
  }

  importFinish(lastSequence: number) {
    return this.coop.importFinish(lastSequence);
  }

  async alarm(): Promise<void> {
    const coop =
      this.coopObject !== null ||
      this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coop_meta'").toArray()
        .length > 0;
    if (coop) {
      await this.coop.alarm();
      return;
    }
    const pending = this.store.pendingSnapshot();
    if (!pending || !this.env.BATCH_KV) return;
    await this.env.BATCH_KV.put(diningCacheKey(pending.date), pending.value, {
      expirationTtl: DINING_CACHE_TTL_SECONDS,
    });
    this.store.markPublished(pending.value);
    // put 대기 중 들어온 좋아요는 다음 alarm에서 반영한다.
    await this.publishLater();
  }
}
