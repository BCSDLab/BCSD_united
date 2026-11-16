import { fail, kstDate } from '@api/domains/dining/protocol';
import { ApiError } from '@api/errors';
import type { OwnedEntry } from '@api/koin-db/dining-store';

export type DiningType = 'BREAKFAST' | 'LUNCH' | 'DINNER';
export type ReportStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ProcessingType = 'MANUAL' | 'SAME_DINING_APPROVED' | 'COOP_PREPROCESSED';
export type DeliveryState = 'QUEUED' | 'IN_PROGRESS' | 'DELIVERED';
export type DeliveryOutcome = 'SUCCEEDED' | 'FAILED';

export type DiningMeta = {
  id: number;
  date: string;
  type: DiningType;
  place: string;
};
type CoopDining = DiningMeta & {
  sold_out: string | null;
  sold_out_source: string | null;
  image_url: string | null;
  touched_at: string | null;
  version: number;
};
export interface Actor {
  workspace_id: string;
  user_id: string;
  display_name: string;
}
export type ReportRow = {
  id: number;
  dining_id: number;
  reporter_id: number | null;
  image_url: string;
  status: ReportStatus;
  processing_type: ProcessingType | null;
  processing_id: string | null;
  source_report_id: number | null;
  processor_workspace_id: string | null;
  processor_user_id: string | null;
  processor_name: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ChangeRow = {
  sequence: number;
  report_id: number;
  event_type: 'CREATED' | 'PROCESSED';
  status: ReportStatus;
  processing_type: ProcessingType | null;
  processing_id: string | null;
  occurred_at: string;
  delivery_id: string | null;
  report_snapshot: string | null;
  delivery_state: DeliveryState;
  attempt_token: string | null;
  /** epoch ms. MySQL DATETIME(6) 한국시간 값을 변환해 둔다. */
  expires_at: number | null;
  next_attempt_at: number | null;
  accepted_outcome: DeliveryOutcome | null;
};
export interface ImportedDining extends DiningMeta {
  sold_out: string | null;
  sold_out_source: string | null;
  image_url: string | null;
}
export interface ImportedReport extends ReportRow {
  dining_date: string;
  dining_type: DiningType;
  dining_place: string;
}
export interface OutboxJob {
  id: number;
  kind: 'soldout' | 'image';
  payload: { dining_id: number; place?: string; type?: DiningType; image_url?: string | null };
  created_at: number;
  attempts: number;
  next_attempt_at: number;
  targets: string[] | null;
  cursor: number;
}

/** RPC로 넘길 수 있는 오류. Java 응답 코드·메시지 그대로다. */
export interface ErrorShape {
  status: number;
  code: string;
  message: string;
}
export type Outcome<T> = { value: T } | { error: ErrorShape };
/**
 * Java CoopShopService.getIsOpened 결과. null은 Java가 평가하지 않는 경로(오늘 식단이 아님),
 * ErrorShape는 그 시점에 Java가 던질 예외(학기·매장 없음 등)다. 실제로 평가할 때만 던진다.
 */
export type Opened = boolean | ErrorShape | null;

const KST_OFFSET_MS = 9 * 3_600_000;
/** Java LocalDateTime.now(KST).withNano(0)의 DATETIME 문자열. */
export const kstWall = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
/** BaseEntity updated_at(JVM UTC) 응답 문자열. */
export const utcWall = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** 한국시간 DATETIME(6) 문자열 → epoch ms(마이크로초는 버린다). */
export function kstWallToMs(value: string): number {
  const [date, time = ''] = value.split(' ');
  const ms = Date.parse(`${date}T${time.slice(0, 12)}Z`);
  if (Number.isNaN(ms)) throw new Error('Invalid KST timestamp');
  return ms - KST_OFFSET_MS;
}
/** Jackson ISO_OFFSET_DATE_TIME: 한국시간, 소수 초는 0이 아닐 때만 끝자리 0을 지워 쓴다. */
export function kstOffsetTime(ms: number): string {
  const iso = new Date(ms + KST_OFFSET_MS).toISOString();
  const fraction = iso.slice(20, 23).replace(/0+$/, '');
  return `${iso.slice(0, 19)}${fraction ? `.${fraction}` : ''}+09:00`;
}

// Spring UriUtils.encodePath 허용 문자(pchar + '/'). 그 외 UTF-8 바이트는 대문자 %XX로 바꾼다.
const pathCharacter = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/;
/** DiningReportResponse.withEncodedImageUrl: encodePath 후 '+'를 %2B로. */
export function encodeImagePath(value: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    encoded +=
      byte < 0x80 && pathCharacter.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded.replace(/\+/g, '%2B');
}

const reasons: Record<ProcessingType, (status: ReportStatus) => string> = {
  MANUAL: (status) => (status === 'APPROVED' ? '담당자 승인' : '담당자 반려'),
  SAME_DINING_APPROVED: () => '동일 코스 제보 승인에 따른 자동 처리',
  COOP_PREPROCESSED: () => '영양사 선처리로 제보 확인 없이 종료',
};

/** DiningReportResponse(JSON). 필드 순서는 Java record 순서다. */
export interface ReportResponse {
  report_id: number;
  dining: { id: number; date: string; type: DiningType; place: string };
  status: ReportStatus;
  processing_type: ProcessingType | null;
  reason: string | null;
  created_at: string;
  processed_at: string | null;
  processor: { workspace_id: string | null; user_id: string | null; display_name: string | null } | null;
  image_url: string;
  processing_id: string | null;
  source_report_id: number | null;
  updated_at: string;
}

/** DiningReportResponse.from(report). */
export function reportResponse(report: ReportRow, dining: DiningMeta): ReportResponse {
  const manual = report.processing_type === 'MANUAL';
  return {
    report_id: report.id,
    dining: { id: dining.id, date: dining.date, type: dining.type, place: dining.place },
    status: report.status,
    processing_type: report.processing_type,
    reason: report.processing_type === null ? null : reasons[report.processing_type](report.status),
    created_at: report.created_at,
    processed_at: manual ? report.processed_at : null,
    processor: manual
      ? {
          workspace_id: report.processor_workspace_id,
          user_id: report.processor_user_id,
          display_name: report.processor_name,
        }
      : null,
    image_url: report.image_url,
    processing_id: report.processing_id,
    source_report_id: report.source_report_id,
    updated_at: report.updated_at,
  };
}

/** 저장된 스냅샷을 Java가 다시 읽어 쓴 것처럼 필드 순서를 맞추고 사진 URL을 인코딩한다. */
function encodedSnapshot(snapshot: string): ReportResponse {
  const value = JSON.parse(snapshot) as ReportResponse;
  return {
    report_id: value.report_id,
    dining: value.dining && {
      id: value.dining.id,
      date: value.dining.date,
      type: value.dining.type,
      place: value.dining.place,
    },
    status: value.status,
    processing_type: value.processing_type,
    reason: value.reason,
    created_at: value.created_at,
    processed_at: value.processed_at,
    processor: value.processor && {
      workspace_id: value.processor.workspace_id,
      user_id: value.processor.user_id,
      display_name: value.processor.display_name,
    },
    image_url: encodeImagePath(value.image_url),
    processing_id: value.processing_id,
    source_report_id: value.source_report_id,
    updated_at: value.updated_at,
  };
}
const encoded = (report: ReportRow, dining: DiningMeta): ReportResponse => ({
  ...reportResponse(report, dining),
  image_url: encodeImagePath(report.image_url),
});

export const SOLDOUT_THROTTLE_MS = 2 * 3_600_000;
const EXCEL_THROTTLE_MS = 30_000;

type Sql = Pick<SqlStorage, 'exec'>;
type Transaction = <T>(operation: () => T) => T;

const schema = [
  'CREATE TABLE IF NOT EXISTS coop_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS coop_dinings (id INTEGER PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, place TEXT NOT NULL,
     sold_out TEXT, sold_out_source TEXT, image_url TEXT, touched_at TEXT, version INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS coop_dinings_date ON coop_dinings (date, type)',
  `CREATE TABLE IF NOT EXISTS coop_reports (id INTEGER PRIMARY KEY, dining_id INTEGER NOT NULL, reporter_id INTEGER,
     image_url TEXT NOT NULL, status TEXT NOT NULL, processing_type TEXT, processing_id TEXT, source_report_id INTEGER,
     processor_workspace_id TEXT, processor_user_id TEXT, processor_name TEXT, processed_at TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // uk_dining_report_student
  'CREATE UNIQUE INDEX IF NOT EXISTS coop_reports_student ON coop_reports (reporter_id, dining_id)',
  'CREATE INDEX IF NOT EXISTS coop_reports_dining ON coop_reports (dining_id, id)',
  'CREATE INDEX IF NOT EXISTS coop_reports_created ON coop_reports (created_at, id)',
  `CREATE TABLE IF NOT EXISTS coop_changes (sequence INTEGER PRIMARY KEY, report_id INTEGER NOT NULL, event_type TEXT NOT NULL,
     status TEXT NOT NULL, processing_type TEXT, processing_id TEXT, occurred_at TEXT NOT NULL, delivery_id TEXT UNIQUE,
     report_snapshot TEXT, delivery_state TEXT NOT NULL, attempt_token TEXT UNIQUE, expires_at INTEGER,
     next_attempt_at INTEGER, accepted_outcome TEXT)`,
  'CREATE INDEX IF NOT EXISTS coop_changes_report ON coop_changes (report_id, sequence)',
  // 알림 outbox. 한 줄로 순서대로 처리한다(앞 작업이 끝나야 다음 작업).
  `CREATE TABLE IF NOT EXISTS coop_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
     created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
     targets TEXT, cursor INTEGER NOT NULL DEFAULT 0)`,
  // Redis TTL 캐시 대체: soldout:<place>(2시간), excel:<start><end>(30초).
  'CREATE TABLE IF NOT EXISTS coop_throttle (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)',
  // 날짜 DO에 아직 반영하지 못한 소유 값 변경.
  'CREATE TABLE IF NOT EXISTS coop_push (date TEXT PRIMARY KEY, version INTEGER NOT NULL)',
];

/**
 * "coop" Durable Object의 SQLite 상태: 식단 품절·사진(소유 값), 품절 제보·변경 작업, 알림 outbox.
 * MySQL의 행 잠금 대신 DO 단일 실행으로 Java DiningReportService·CoopService 트랜잭션을 그대로 재현한다.
 * 모든 메서드는 await 없이 동기 실행되며 실패하면 트랜잭션 전체가 되돌아간다.
 */
export class CoopStore {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction,
  ) {
    for (const statement of schema) sql.exec(statement);
  }

  private meta(key: string): string | null {
    const [row] = this.sql.exec<{ value: string }>('SELECT value FROM coop_meta WHERE key = ?', key).toArray();
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('INSERT OR REPLACE INTO coop_meta (key, value) VALUES (?, ?)', key, value);
  }

  private counter(key: string): number {
    const next = Number(this.meta(key) ?? '0') + 1;
    this.setMeta(key, String(next));
    return next;
  }

  imported(): boolean {
    return this.meta('imported') === '1';
  }

  private run<T>(operation: () => T): Outcome<T> {
    try {
      return { value: this.transaction(operation) };
    } catch (error) {
      if (error instanceof ApiError)
        return { error: { status: error.status, code: error.code, message: error.message } };
      throw error;
    }
  }

  private ready(): void {
    if (!this.imported()) throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', '학식 저장소가 준비되지 않았습니다.');
  }

  // ── 식단 소유 값 ──────────────────────────────────────────────────────────

  private dining(id: number): CoopDining | null {
    const [row] = this.sql.exec<CoopDining>('SELECT * FROM coop_dinings WHERE id = ?', id).toArray();
    return row ? { ...row, id: Number(row.id), version: Number(row.version) } : null;
  }

  private ensureDining(meta: DiningMeta): CoopDining {
    this.sql.exec(
      `INSERT INTO coop_dinings (id, date, type, place, version) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET date = excluded.date, type = excluded.type, place = excluded.place`,
      meta.id,
      meta.date,
      meta.type,
      meta.place,
    );
    return this.dining(meta.id)!;
  }

  /** Hibernate dirty checking처럼 값이 바뀔 때만 updated_at(touched_at)·버전을 올리고 날짜 DO 반영을 예약한다. */
  private setOwned(
    dining: CoopDining,
    fields: Pick<CoopDining, 'sold_out' | 'sold_out_source' | 'image_url'>,
    nowMs: number,
  ): void {
    if (
      fields.sold_out === dining.sold_out &&
      fields.sold_out_source === dining.sold_out_source &&
      fields.image_url === dining.image_url
    ) {
      return;
    }
    const version = this.counter('version');
    Object.assign(dining, fields, { touched_at: utcWall(nowMs), version });
    this.sql.exec(
      `UPDATE coop_dinings SET sold_out = ?, sold_out_source = ?, image_url = ?, touched_at = ?, version = ? WHERE id = ?`,
      dining.sold_out,
      dining.sold_out_source,
      dining.image_url,
      dining.touched_at,
      version,
      dining.id,
    );
    this.sql.exec(
      'INSERT INTO coop_push (date, version) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET version = excluded.version',
      dining.date,
      version,
    );
  }

  /** Dining.markSoldOut: 이미 품절이면 바꾸지 않는다. */
  private markSoldOut(dining: CoopDining, nowMs: number, source: 'COOP' | 'REPORT'): boolean {
    if (dining.sold_out !== null) return false;
    this.setOwned(dining, { sold_out: kstWall(nowMs), sold_out_source: source, image_url: dining.image_url }, nowMs);
    return true;
  }

  private entries(where: string, ...bindings: (string | number)[]): OwnedEntry[] {
    return this.sql
      .exec<OwnedEntry>(
        `SELECT id, sold_out, image_url, touched_at, version FROM coop_dinings WHERE version > 0 AND ${where} ORDER BY id`,
        ...bindings,
      )
      .toArray()
      .map((row) => ({ ...row, id: Number(row.id), version: Number(row.version) }));
  }

  /** 날짜 DO에 내려 줄 소유 값. 가져오기 전이면 null(MySQL 값을 쓴다). */
  ownedFor(date: string): OwnedEntry[] | null {
    return this.imported() ? this.entries('date = ?', date) : null;
  }

  ownedRange(from: string, to: string): OwnedEntry[] | null {
    return this.imported() ? this.entries('date BETWEEN ? AND ?', from, to) : null;
  }

  ownedByIds(ids: number[]): OwnedEntry[] | null {
    if (!this.imported()) return null;
    return ids.flatMap((id) => this.entries('id = ?', id));
  }

  pendingPushes(): { date: string; version: number }[] {
    return this.sql
      .exec<{ date: string; version: number }>('SELECT date, version FROM coop_push ORDER BY date')
      .toArray()
      .map((row) => ({ date: row.date, version: Number(row.version) }));
  }

  /** 반영 중 더 새 변경이 들어왔으면 남겨 둔다. */
  pushed(date: string, version: number): void {
    this.sql.exec('DELETE FROM coop_push WHERE date = ? AND version <= ?', date, version);
  }

  // ── 제보 ─────────────────────────────────────────────────────────────────

  private reportsOf(diningId: number): ReportRow[] {
    return this.sql
      .exec<ReportRow>('SELECT * FROM coop_reports WHERE dining_id = ? ORDER BY id', diningId)
      .toArray()
      .map(normalizeReport);
  }

  private report(id: number): ReportRow | null {
    const [row] = this.sql.exec<ReportRow>('SELECT * FROM coop_reports WHERE id = ?', id).toArray();
    return row ? normalizeReport(row) : null;
  }

  /** DiningReport.process. */
  private process(
    report: ReportRow,
    status: Exclude<ReportStatus, 'PENDING'>,
    type: ProcessingType,
    batchId: string,
    sourceId: number | null,
    now: string,
    actor: Actor | null,
  ): ReportRow {
    if (report.status !== 'PENDING') throw new ApiError(400, 'ILLEGAL_STATE', '잘못된 상태입니다.');
    const updated: ReportRow = {
      ...report,
      status,
      processing_type: type,
      processing_id: batchId,
      source_report_id: sourceId,
      processed_at: now,
      updated_at: now,
      processor_workspace_id: actor?.workspace_id ?? null,
      processor_user_id: actor?.user_id ?? null,
      processor_name: actor?.display_name ?? null,
    };
    this.sql.exec(
      `UPDATE coop_reports SET status = ?, processing_type = ?, processing_id = ?, source_report_id = ?, processed_at = ?,
         updated_at = ?, processor_workspace_id = ?, processor_user_id = ?, processor_name = ? WHERE id = ?`,
      updated.status,
      updated.processing_type,
      updated.processing_id,
      updated.source_report_id,
      updated.processed_at,
      updated.updated_at,
      updated.processor_workspace_id,
      updated.processor_user_id,
      updated.processor_name,
      updated.id,
    );
    return updated;
  }

  /** DiningReportChangeService.append: 순번을 이어 붙이고 변경 시점 스냅샷을 고정한다. */
  private append(reports: ReportRow[], dining: DiningMeta, event: 'CREATED' | 'PROCESSED', now: string): void {
    if (!reports.length) return;
    const last = this.meta('last_sequence');
    if (last === null) throw new Error('식단 제보 변경 순번 초기값이 없습니다.');
    let sequence = Number(last);
    for (const report of reports) {
      sequence++;
      this.sql.exec(
        `INSERT INTO coop_changes (sequence, report_id, event_type, status, processing_type, processing_id, occurred_at,
           delivery_id, report_snapshot, delivery_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')`,
        sequence,
        report.id,
        event,
        report.status,
        report.processing_type,
        report.processing_id,
        now,
        crypto.randomUUID(),
        JSON.stringify(reportResponse(report, dining)),
      );
    }
    this.setMeta('last_sequence', String(sequence));
  }

  /** DiningReportService.publishSoldOut: 오늘 식단·운영 시간·장소별 2시간 제한을 통과하면 알림을 예약한다. */
  private publishSoldOut(dining: CoopDining, nowMs: number, opened: Opened): void {
    if (dining.date !== kstDate(new Date(nowMs))) return;
    if (opened === null) throw new Error('Opened state was not evaluated for today');
    if (typeof opened === 'object') throw new ApiError(opened.status, opened.code, opened.message);
    if (!opened || this.throttled(`soldout:${dining.place}`, nowMs)) return;
    this.enqueue('soldout', { dining_id: dining.id, place: dining.place, type: dining.type }, nowMs);
  }

  /** POST /dinings/{id}/soldout-reports. 사진 검증과 식단 존재 확인은 호출자가 먼저 한다. */
  createReport(meta: DiningMeta, reporterId: number, imageUrl: string, nowMs: number) {
    return this.run(() => {
      this.ready();
      const dining = this.ensureDining(meta);
      if (this.reportsOf(dining.id).some((report) => report.reporter_id === reporterId)) {
        fail('DINING_REPORT_ALREADY_SUBMITTED');
      }
      if (dining.date !== kstDate(new Date(nowMs))) fail('DINING_REPORT_DATE_NOT_ALLOWED');
      if (dining.sold_out !== null) fail('DINING_ALREADY_SOLD_OUT');
      const now = kstWall(nowMs);
      const report: ReportRow = {
        id: this.counter('last_report_id'),
        dining_id: dining.id,
        reporter_id: reporterId,
        image_url: imageUrl,
        status: 'PENDING',
        processing_type: null,
        processing_id: null,
        source_report_id: null,
        processor_workspace_id: null,
        processor_user_id: null,
        processor_name: null,
        processed_at: null,
        created_at: now,
        updated_at: now,
      };
      this.sql.exec(
        `INSERT INTO coop_reports (id, dining_id, reporter_id, image_url, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        report.id,
        report.dining_id,
        reporterId,
        imageUrl,
        now,
        now,
      );
      this.append([report], dining, 'CREATED', now);
      return { report_id: report.id, status: 'PENDING' as const, created_at: now };
    });
  }

  /** 승인·반려 전에 운영 시간 판정에 필요한 대상 식단. */
  reportDining(reportId: number): Outcome<DiningMeta> {
    return this.run(() => {
      this.ready();
      const report = this.report(reportId);
      if (!report) fail('NOT_FOUND_DINING_REPORT');
      const dining = this.dining(report.dining_id);
      if (!dining) fail('NOT_FOUND_DINING');
      return { id: dining.id, date: dining.date, type: dining.type, place: dining.place };
    });
  }

  /** DiningReportService.approve/reject. 같은 결과 재호출은 최초 처리 묶음을 그대로 돌려준다. */
  decide(reportId: number, actor: Actor, result: 'APPROVED' | 'REJECTED', nowMs: number, opened: Opened) {
    return this.run(() => {
      this.ready();
      const found = this.report(reportId);
      if (!found) fail('NOT_FOUND_DINING_REPORT');
      const dining = this.dining(found.dining_id);
      if (!dining) fail('NOT_FOUND_DINING');
      const reports = this.reportsOf(dining.id);
      const target = reports.find((report) => report.id === reportId);
      if (!target) fail('NOT_FOUND_DINING_REPORT');
      if (target.status !== 'PENDING') {
        if (target.status !== result) fail('DINING_REPORT_ALREADY_PROCESSED');
        return {
          report: encoded(target, dining),
          affected_report_ids: reports
            .filter((report) => report.processing_id === target.processing_id)
            .map((report) => report.id),
          already_processed: true,
        };
      }
      const now = kstWall(nowMs);
      const batchId = crypto.randomUUID();
      const affected = (result === 'APPROVED' ? reports.filter((report) => report.status === 'PENDING') : [target]).map(
        (report) => {
          const manual = report.id === reportId;
          return this.process(
            report,
            result,
            manual ? 'MANUAL' : 'SAME_DINING_APPROVED',
            batchId,
            manual ? null : reportId,
            now,
            manual ? actor : null,
          );
        },
      );
      if (result === 'APPROVED' && this.markSoldOut(dining, nowMs, 'REPORT'))
        this.publishSoldOut(dining, nowMs, opened);
      this.append(affected, dining, 'PROCESSED', now);
      return {
        report: encoded(
          affected.find((report) => report.id === reportId)!,
          dining,
        ),
        affected_report_ids: affected.map((report) => report.id),
        already_processed: false,
      };
    });
  }

  /** PATCH /coop/dining/soldout (DiningReportService.changeSoldOutByCoop). */
  changeSoldOut(meta: DiningMeta, soldOut: boolean, nowMs: number, opened: Opened): Outcome<void> {
    return this.run(() => {
      this.ready();
      const dining = this.ensureDining(meta);
      if (!soldOut) {
        this.setOwned(dining, { sold_out: null, sold_out_source: null, image_url: dining.image_url }, nowMs);
        return;
      }
      const pending = this.reportsOf(dining.id).filter((report) => report.status === 'PENDING');
      const changed = this.markSoldOut(dining, nowMs, 'COOP');
      const now = kstWall(nowMs);
      const batchId = crypto.randomUUID();
      const affected = pending.map((report) =>
        this.process(report, 'REJECTED', 'COOP_PREPROCESSED', batchId, null, now, null),
      );
      if (changed) this.publishSoldOut(dining, nowMs, opened);
      this.append(affected, dining, 'PROCESSED', now);
    });
  }

  /**
   * PATCH /coop/dining/image (CoopService.saveDiningImage). 같은 날짜·끼니에 사진이 하나도 없고 운영 중이면
   * 기존 사진 URL(=null)로 업로드 알림을 예약한다. `opened`는 호출자가 Java와 같은 시각 기준으로 계산한다.
   */
  saveImage(meta: DiningMeta, imageUrl: string, nowMs: number, opened: boolean): Outcome<void> {
    return this.run(() => {
      this.ready();
      const dining = this.ensureDining(meta);
      const imageExists =
        this.sql
          .exec(
            'SELECT 1 FROM coop_dinings WHERE date = ? AND type = ? AND image_url IS NOT NULL LIMIT 1',
            dining.date,
            dining.type,
          )
          .toArray().length > 0;
      if (opened && !imageExists) this.enqueue('image', { dining_id: dining.id, image_url: dining.image_url }, nowMs);
      this.setOwned(
        dining,
        { sold_out: dining.sold_out, sold_out_source: dining.sold_out_source, image_url: imageUrl },
        nowMs,
      );
    });
  }

  // ── 삐봇 작업 배정 ────────────────────────────────────────────────────────

  /** DiningReportDeliveryService.claim. 같은 제보의 앞선 변경이 끝나야 다음 변경을 배정한다. */
  claim(nowMs: number) {
    return this.run(() => {
      this.ready();
      const [row] = this.sql
        .exec<ChangeRow>(
          `SELECT c.* FROM coop_changes c
            WHERE ((c.delivery_state = 'QUEUED' AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= ?))
                OR (c.delivery_state = 'IN_PROGRESS' AND c.expires_at <= ?))
              AND NOT EXISTS (SELECT 1 FROM coop_changes e WHERE e.report_id = c.report_id
                                AND e.sequence < c.sequence AND e.delivery_state <> 'DELIVERED')
            ORDER BY c.sequence LIMIT 1`,
          nowMs,
          nowMs,
        )
        .toArray();
      if (!row) return null;
      let snapshot = row.report_snapshot;
      if (snapshot === null) {
        // 이전 버전이 넣은 작업은 현재 제보로 스냅샷을 만든다.
        const report = this.report(Number(row.report_id));
        if (!report) fail('NOT_FOUND_DINING_REPORT');
        snapshot = JSON.stringify(reportResponse(report, this.dining(report.dining_id)!));
      }
      const deliveryId = row.delivery_id ?? crypto.randomUUID();
      const token = crypto.randomUUID();
      const expires = nowMs + 60_000;
      this.sql.exec(
        `UPDATE coop_changes SET delivery_id = ?, report_snapshot = ?, attempt_token = ?, expires_at = ?, next_attempt_at = NULL,
           accepted_outcome = NULL, delivery_state = 'IN_PROGRESS' WHERE sequence = ?`,
        deliveryId,
        snapshot,
        token,
        expires,
        row.sequence,
      );
      return {
        delivery_id: deliveryId,
        attempt_token: token,
        expires_at: kstOffsetTime(expires),
        report: encodedSnapshot(snapshot),
      };
    });
  }

  /** DiningReportDeliveryService.recordResult. */
  recordResult(deliveryId: string, token: string, outcome: DeliveryOutcome, nowMs: number) {
    return this.run(() => {
      this.ready();
      const [change] = this.sql
        .exec<ChangeRow>('SELECT * FROM coop_changes WHERE delivery_id = ?', deliveryId)
        .toArray();
      if (!change) fail('NOT_FOUND_DINING_REPORT_DELIVERY');
      if (token !== change.attempt_token) {
        const elsewhere = this.sql
          .exec('SELECT 1 FROM coop_changes WHERE attempt_token = ? AND delivery_id IS NOT ?', token, deliveryId)
          .toArray().length;
        fail(elsewhere ? 'NOT_FOUND_DINING_REPORT_DELIVERY' : 'DINING_REPORT_DELIVERY_CONFLICT');
      }
      if (change.accepted_outcome !== null) {
        if (change.accepted_outcome !== outcome) fail('DINING_REPORT_DELIVERY_CONFLICT');
        return { delivery_id: deliveryId, delivery_state: change.delivery_state };
      }
      if (change.delivery_state !== 'IN_PROGRESS') fail('DINING_REPORT_DELIVERY_CONFLICT');
      const state: DeliveryState = outcome === 'SUCCEEDED' ? 'DELIVERED' : 'QUEUED';
      this.sql.exec(
        'UPDATE coop_changes SET accepted_outcome = ?, delivery_state = ?, next_attempt_at = ? WHERE sequence = ?',
        outcome,
        state,
        state === 'QUEUED' ? nowMs + 5_000 : null,
        change.sequence,
      );
      return { delivery_id: deliveryId, delivery_state: state };
    });
  }

  // ── 조회 ─────────────────────────────────────────────────────────────────

  /** GET /internal/dining/soldout-reports/{id}: 인코딩한 사진 URL, 제보자 정보 없음. */
  botReport(reportId: number) {
    return this.run(() => {
      this.ready();
      const report = this.report(reportId);
      if (!report) fail('NOT_FOUND_DINING_REPORT');
      return encoded(report, this.dining(report.dining_id)!);
    });
  }

  /** GET /admin/dining/soldout-reports/{id}: 원본 사진 URL과 제보자 ID(이름은 호출자가 조회). */
  adminReport(reportId: number) {
    return this.run(() => {
      this.ready();
      const report = this.report(reportId);
      if (!report) fail('NOT_FOUND_DINING_REPORT');
      return { report: reportResponse(report, this.dining(report.dining_id)!), reporter_id: report.reporter_id };
    });
  }

  /** GET /admin/dining/soldout-reports. Criteria.of(page, limit, total)로 보정하고 접수 시각·ID 내림차순. */
  adminReports(onlyPending: boolean, page: number, limit: number) {
    return this.run(() => {
      this.ready();
      const where = onlyPending ? "WHERE r.status = 'PENDING'" : '';
      const [count] = this.sql
        .exec<{ total: number }>(`SELECT COUNT(*) AS total FROM coop_reports r ${where}`)
        .toArray();
      const total = Number(count!.total);
      const size = Math.min(Math.max(limit, 1), 50);
      const totalPage = total === 0 ? 1 : Math.ceil(total / size);
      const current = Math.min(Math.max(page, 1), totalPage);
      const rows = this.sql
        .exec<ReportRow & { date: string; type: DiningType; place: string }>(
          `SELECT r.*, d.date, d.type, d.place FROM coop_reports r JOIN coop_dinings d ON d.id = r.dining_id ${where}
            ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
          size,
          (current - 1) * size,
        )
        .toArray();
      const reports = rows.map((row) => {
        const detail = reportResponse(normalizeReport(row), {
          id: Number(row.dining_id),
          date: row.date,
          type: row.type,
          place: row.place,
        });
        return {
          report_id: detail.report_id,
          dining: detail.dining,
          status: detail.status,
          processing_type: detail.processing_type,
          reason: detail.reason,
          created_at: detail.created_at,
          processed_at: detail.processed_at,
          processor: detail.processor,
        };
      });
      return {
        reports,
        total_count: total,
        current_count: reports.length,
        total_page: totalPage,
        current_page: current,
      };
    });
  }

  // ── 제한·outbox ──────────────────────────────────────────────────────────

  private throttled(key: string, nowMs: number): boolean {
    this.sql.exec('DELETE FROM coop_throttle WHERE expires_at <= ?', nowMs);
    return this.sql.exec('SELECT 1 FROM coop_throttle WHERE key = ?', key).toArray().length > 0;
  }

  private throttle(key: string, untilMs: number): void {
    this.sql.exec('INSERT OR REPLACE INTO coop_throttle (key, expires_at) VALUES (?, ?)', key, untilMs);
  }

  /** CoopService.checkDuplicateExcelRequest: 같은 기간 엑셀 요청은 30초에 한 번(isCafeteria 무관). */
  excelGuard(startDate: string, endDate: string, nowMs: number): Outcome<void> {
    return this.run(() => {
      const key = `excel:${startDate}${endDate}`;
      if (this.throttled(key, nowMs)) {
        throw new ApiError(
          409,
          '',
          `동일한 요청을 30초 안에 다시 보낼 수 없습니다! startDate: '${startDate}'endDate: ${endDate}`,
        );
      }
      this.throttle(key, nowMs + EXCEL_THROTTLE_MS);
    });
  }

  private enqueue(kind: OutboxJob['kind'], payload: OutboxJob['payload'], nowMs: number): void {
    this.sql.exec(
      'INSERT INTO coop_outbox (kind, payload, created_at, next_attempt_at) VALUES (?, ?, ?, ?)',
      kind,
      JSON.stringify(payload),
      nowMs,
      nowMs,
    );
  }

  outboxHead(): OutboxJob | null {
    const [row] = this.sql
      .exec<Omit<OutboxJob, 'payload' | 'targets'> & { payload: string; targets: string | null }>(
        'SELECT * FROM coop_outbox ORDER BY id LIMIT 1',
      )
      .toArray();
    if (!row) return null;
    return {
      id: Number(row.id),
      kind: row.kind,
      payload: JSON.parse(row.payload) as OutboxJob['payload'],
      created_at: Number(row.created_at),
      attempts: Number(row.attempts),
      next_attempt_at: Number(row.next_attempt_at),
      targets: row.targets === null ? null : (JSON.parse(row.targets) as string[]),
      cursor: Number(row.cursor),
    };
  }

  /** CoopNotificationService 재확인: 아직 품절이고 오늘 식단이며 장소별 제한이 없을 때만 보낸다. */
  soldoutStillDue(job: OutboxJob, nowMs: number): boolean {
    const dining = this.dining(job.payload.dining_id);
    return (
      dining !== null &&
      dining.sold_out !== null &&
      dining.date === kstDate(new Date(nowMs)) &&
      !this.throttled(`soldout:${job.payload.place}`, nowMs)
    );
  }

  outboxTargets(id: number, targets: string[]): void {
    this.sql.exec('UPDATE coop_outbox SET targets = ?, cursor = 0 WHERE id = ?', JSON.stringify(targets), id);
  }

  outboxAdvance(id: number, cursor: number): void {
    this.sql.exec('UPDATE coop_outbox SET cursor = ? WHERE id = ?', cursor, id);
  }

  /** 전송을 마쳤다. 품절 알림은 그 뒤에 장소별 2시간 제한을 건다(DiningSoldOutCache 저장 시점과 같다). */
  outboxFinish(job: OutboxJob, nowMs: number): void {
    this.transaction(() => {
      if (job.kind === 'soldout') this.throttle(`soldout:${job.payload.place}`, nowMs + SOLDOUT_THROTTLE_MS);
      this.sql.exec('DELETE FROM coop_outbox WHERE id = ?', job.id);
    });
  }

  outboxDrop(id: number): void {
    this.sql.exec('DELETE FROM coop_outbox WHERE id = ?', id);
  }

  outboxRetry(job: OutboxJob, nowMs: number): void {
    const delay = Math.min(5_000 * 2 ** job.attempts, 300_000);
    this.sql.exec(
      'UPDATE coop_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?',
      nowMs + delay,
      job.id,
    );
  }

  // ── MySQL 상태 가져오기(1회) ─────────────────────────────────────────────

  /**
   * 가져오기를 (다시) 시작한다. 이미 끝났으면 거부한다(그 뒤의 DO 쓰기를 덮어쓰지 않도록).
   * `force`는 되돌림(Java가 다시 MySQL에 쓴 뒤) 후 재전환에만 쓴다. DO에서만 생긴 제보·변경은 사라진다.
   */
  importBegin(force: boolean): Outcome<void> {
    return this.run(() => {
      if (this.imported() && !force) {
        throw new ApiError(409, 'DINING_COOP_ALREADY_IMPORTED', '이미 가져온 학식 상태입니다.');
      }
      for (const table of ['coop_dinings', 'coop_reports', 'coop_changes', 'coop_outbox', 'coop_push']) {
        this.sql.exec(`DELETE FROM ${table}`);
      }
      // 날짜 DO는 더 큰 version만 받으므로 버전 순번은 이어 간다.
      this.sql.exec("DELETE FROM coop_meta WHERE key <> 'version'");
    });
  }

  /** 완료 뒤 늦게 도착한 가져오기 페이지는 DO에서 쓴 값을 덮어쓸 수 없다. */
  importDinings(rows: ImportedDining[]): void {
    this.transaction(() => {
      if (this.imported()) throw new ApiError(409, 'DINING_COOP_ALREADY_IMPORTED', '이미 가져온 학식 상태입니다.');
      for (const row of rows) {
        this.sql.exec(
          `INSERT OR REPLACE INTO coop_dinings (id, date, type, place, sold_out, sold_out_source, image_url, touched_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          row.id,
          row.date,
          row.type,
          row.place,
          row.sold_out,
          row.sold_out_source,
          row.image_url,
          this.counter('version'),
        );
      }
    });
  }

  importReports(rows: ImportedReport[]): void {
    this.transaction(() => {
      if (this.imported()) throw new ApiError(409, 'DINING_COOP_ALREADY_IMPORTED', '이미 가져온 학식 상태입니다.');
      for (const row of rows) {
        this.sql.exec(
          'INSERT OR IGNORE INTO coop_dinings (id, date, type, place, version) VALUES (?, ?, ?, ?, 0)',
          row.dining_id,
          row.dining_date,
          row.dining_type,
          row.dining_place,
        );
        this.sql.exec(
          `INSERT OR REPLACE INTO coop_reports (id, dining_id, reporter_id, image_url, status, processing_type, processing_id,
             source_report_id, processor_workspace_id, processor_user_id, processor_name, processed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.dining_id,
          row.reporter_id,
          row.image_url,
          row.status,
          row.processing_type,
          row.processing_id,
          row.source_report_id,
          row.processor_workspace_id,
          row.processor_user_id,
          row.processor_name,
          row.processed_at,
          row.created_at,
          row.updated_at,
        );
      }
    });
  }

  importChanges(rows: ChangeRow[]): void {
    this.transaction(() => {
      if (this.imported()) throw new ApiError(409, 'DINING_COOP_ALREADY_IMPORTED', '이미 가져온 학식 상태입니다.');
      for (const row of rows) {
        this.sql.exec(
          `INSERT OR REPLACE INTO coop_changes (sequence, report_id, event_type, status, processing_type, processing_id,
             occurred_at, delivery_id, report_snapshot, delivery_state, attempt_token, expires_at, next_attempt_at, accepted_outcome)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.sequence,
          row.report_id,
          row.event_type,
          row.status,
          row.processing_type,
          row.processing_id,
          row.occurred_at,
          row.delivery_id,
          row.report_snapshot,
          row.delivery_state,
          row.attempt_token,
          row.expires_at,
          row.next_attempt_at,
          row.accepted_outcome,
        );
      }
    });
  }

  /** 순번·제보 ID를 이어 받고 소유권을 넘겨받는다. */
  importFinish(lastSequence: number) {
    return this.run(() => {
      if (this.imported()) throw new ApiError(409, 'DINING_COOP_ALREADY_IMPORTED', '이미 가져온 학식 상태입니다.');
      const count = (table: string) =>
        Number(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]!.n);
      const [max] = this.sql
        .exec<{ id: number | null; sequence: number | null }>(
          'SELECT (SELECT MAX(id) FROM coop_reports) AS id, (SELECT MAX(sequence) FROM coop_changes) AS sequence',
        )
        .toArray();
      this.setMeta('last_sequence', String(Math.max(lastSequence, Number(max?.sequence ?? 0))));
      this.setMeta('last_report_id', String(Number(max?.id ?? 0)));
      this.setMeta('imported', '1');
      return {
        dinings: count('coop_dinings'),
        reports: count('coop_reports'),
        changes: count('coop_changes'),
        last_sequence: Number(this.meta('last_sequence')),
      };
    });
  }
}

function normalizeReport(row: ReportRow): ReportRow {
  return {
    id: Number(row.id),
    dining_id: Number(row.dining_id),
    reporter_id: row.reporter_id === null ? null : Number(row.reporter_id),
    image_url: row.image_url,
    status: row.status,
    processing_type: row.processing_type,
    processing_id: row.processing_id,
    source_report_id: row.source_report_id === null ? null : Number(row.source_report_id),
    processor_workspace_id: row.processor_workspace_id,
    processor_user_id: row.processor_user_id,
    processor_name: row.processor_name,
    processed_at: row.processed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
