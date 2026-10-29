export type RegularTermName = '1학기' | '2학기';
export type VacationSeason = '하계' | '동계';
export type VacationPeriodKind = '계절학기' | '방학';

export interface RawOperationHour {
  dayLabel: string;
  type: string;
  openTime: string;
  closeTime: string;
  rawText: string;
}

export interface RawCoopShop {
  groupLabel: string;
  shopLabel: string;
  phone: string;
  remark: string;
  operationHours: RawOperationHour[];
}

/** 비전 모델이 이미지에서 읽어낸 원문 중심의 중간 표현. */
export interface RawRegularCoopTimetable {
  title: string;
  semesterLabel: string;
  fromDate: string;
  toDate: string;
  shops: RawCoopShop[];
}

export interface BaselineOperationHour {
  day_of_week: string;
  type: string | null;
  open_time: string;
  close_time: string;
}

export interface BaselineCoopShop {
  id: number;
  name: string;
  opens: BaselineOperationHour[];
  phone: string;
  location: string;
  remarks: string | null;
  icon_url?: string;
}

export interface CoopShopBaseline {
  semester: string;
  from_date: string;
  to_date: string;
  coop_shops: BaselineCoopShop[];
}

export interface AdminOperationHour {
  type?: string;
  day_of_week: string;
  open_time: string;
  close_time: string;
}

export interface AdminCoopShopInfo {
  name: string;
  phone: string;
  location: string;
  remark?: string;
}

export interface AdminCoopShop {
  coop_shop_info: AdminCoopShopInfo;
  operation_hours: AdminOperationHour[];
}

export interface AdminUpdateSemesterRequest {
  coop_shops: AdminCoopShop[];
}

export type ConversionIssueCode =
  | 'excluded_second_campus'
  | 'invalid_semester'
  | 'invalid_date'
  | 'invalid_day'
  | 'invalid_time'
  | 'invalid_phone'
  | 'duplicate_operation_hour'
  | 'unmatched_shop'
  | 'missing_shop'
  | 'phone_changed'
  | 'baseline_phone_used'
  | 'vacation_hours_closed';

export interface ConversionIssue {
  code: ConversionIssueCode;
  severity: 'blocking' | 'info';
  shop: string;
  detail: string;
}

export interface ConvertedCoopShop {
  source: RawCoopShop;
  baseline: BaselineCoopShop;
  admin: AdminCoopShop;
}

export interface RegularConversionResult {
  semester: string;
  fromDate: string;
  toDate: string;
  request: AdminUpdateSemesterRequest;
  shops: ConvertedCoopShop[];
  excludedShops: RawCoopShop[];
  issues: ConversionIssue[];
}

export interface VacationSplitConversionResult {
  year: number;
  season: VacationSeason;
  vacationStartDate: string;
  seasonal: RegularConversionResult;
  vacation: RegularConversionResult;
}
