import { captureError } from '@koin/telemetry/runtime';
import { runCoopOutbox } from '@api/koin-db/coop-notify';
import type {
  Actor,
  ChangeRow,
  CoopStore,
  DeliveryOutcome,
  DiningMeta,
  ImportedDining,
  ImportedReport,
  Opened,
} from '@api/koin-db/coop-store';
import type { OwnedEntry } from '@api/koin-db/dining-store';
import type { Bindings } from '@api/runtime';

// 날짜 DO 반영이 실패하면 이 간격으로 다시 시도한다.
const PUSH_RETRY_MS = 5_000;

/**
 * "coop" 인스턴스의 동작. Durable Object(cloudflare:workers) 없이 테스트할 수 있도록 DO 클래스는 이 객체에 위임한다.
 * 쓰기 뒤에는 바뀐 날짜 DO에 소유 값을 바로 반영하고, 실패분과 알림 outbox는 alarm이 이어서 처리한다.
 */
export class CoopObject {
  constructor(
    private readonly store: CoopStore,
    private readonly env: Bindings,
    private readonly dateObject: (date: string) => { applyOwned(entries: OwnedEntry[] | null): Promise<void> },
    private readonly scheduleAlarm: (at: number) => Promise<void>,
  ) {}

  private async afterWrite<T>(result: T): Promise<T> {
    await this.pushOwned();
    await this.schedule();
    return result;
  }

  private async schedule(): Promise<void> {
    const job = this.store.outboxHead();
    const pushes = this.store.pendingPushes().length > 0;
    if (!job && !pushes) return;
    const now = Date.now();
    await this.scheduleAlarm(
      Math.min(job ? Math.max(job.next_attempt_at, now) : Infinity, pushes ? now + PUSH_RETRY_MS : Infinity),
    );
  }

  /** 예약된 날짜마다 현재 소유 값을 날짜 DO에 내려 준다. 실패한 날짜는 남겨 두고 alarm에서 다시 한다. */
  private async pushOwned(): Promise<void> {
    for (const { date, version } of this.store.pendingPushes()) {
      try {
        await this.dateObject(date).applyOwned(this.store.ownedFor(date));
        this.store.pushed(date, version);
      } catch (error) {
        captureError(error);
      }
    }
  }

  async alarm(): Promise<void> {
    await this.pushOwned();
    try {
      await runCoopOutbox(this.env, this.store);
    } catch (error) {
      captureError(error);
    }
    await this.schedule();
  }

  ownedFor(date: string) {
    return this.store.ownedFor(date);
  }

  ownedRange(from: string, to: string) {
    return this.store.ownedRange(from, to);
  }

  ownedByIds(ids: number[]) {
    return this.store.ownedByIds(ids);
  }

  createReport(meta: DiningMeta, reporterId: number, imageUrl: string, nowMs: number) {
    return this.afterWrite(this.store.createReport(meta, reporterId, imageUrl, nowMs));
  }

  reportDining(reportId: number) {
    return this.store.reportDining(reportId);
  }

  decide(reportId: number, actor: Actor, result: 'APPROVED' | 'REJECTED', nowMs: number, opened: Opened) {
    return this.afterWrite(this.store.decide(reportId, actor, result, nowMs, opened));
  }

  changeSoldOut(meta: DiningMeta, soldOut: boolean, nowMs: number, opened: Opened) {
    return this.afterWrite(this.store.changeSoldOut(meta, soldOut, nowMs, opened));
  }

  saveImage(meta: DiningMeta, imageUrl: string, nowMs: number, opened: boolean) {
    return this.afterWrite(this.store.saveImage(meta, imageUrl, nowMs, opened));
  }

  claim(nowMs: number) {
    return this.store.claim(nowMs);
  }

  recordResult(deliveryId: string, token: string, outcome: DeliveryOutcome, nowMs: number) {
    return this.store.recordResult(deliveryId, token, outcome, nowMs);
  }

  botReport(reportId: number) {
    return this.store.botReport(reportId);
  }

  adminReport(reportId: number) {
    return this.store.adminReport(reportId);
  }

  adminReports(onlyPending: boolean, page: number, limit: number) {
    return this.store.adminReports(onlyPending, page, limit);
  }

  excelGuard(startDate: string, endDate: string, nowMs: number) {
    return this.store.excelGuard(startDate, endDate, nowMs);
  }

  importBegin(force: boolean) {
    return this.store.importBegin(force);
  }

  importDinings(rows: ImportedDining[]) {
    this.store.importDinings(rows);
  }

  importReports(rows: ImportedReport[]) {
    this.store.importReports(rows);
  }

  importChanges(rows: ChangeRow[]) {
    this.store.importChanges(rows);
  }

  async importFinish(lastSequence: number) {
    const result = this.store.importFinish(lastSequence);
    // 가져온 뒤 생긴 대기 작업(이전 Java 배정 만료 등)은 다음 claim이 처리한다. 알림 outbox는 비어 있다.
    await this.schedule();
    return result;
  }
}
