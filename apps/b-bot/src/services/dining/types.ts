export type ReportStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type ProcessingType = 'MANUAL' | 'SAME_DINING_APPROVED' | 'COOP_PREPROCESSED';

export type DiningType = 'BREAKFAST' | 'LUNCH' | 'DINNER';

export interface DiningReference {
  id: number;
  date: string;
  type: DiningType;
  place: string;
}

export interface ReportActor {
  workspace_id: string;
  user_id: string;
  display_name: string;
}

export interface BotReportDetail {
  report_id: number;
  dining: DiningReference;
  status: ReportStatus;
  processing_type: ProcessingType | null;
  reason: string | null;
  created_at: string;
  processed_at: string | null;
  processor: ReportActor | null;
  image_url: string;
  processing_id: string | null;
  source_report_id: number | null;
  updated_at: string;
}

export interface DeliveryJob {
  delivery_id: string;
  attempt_token: string;
  expires_at: string;
  report: BotReportDetail;
}

export type DeliveryOutcome = 'SUCCEEDED' | 'FAILED';

export type DeliveryState = 'QUEUED' | 'IN_PROGRESS' | 'DELIVERED';

export interface DecisionResponse {
  report: BotReportDetail;
  affected_report_ids: number[];
  already_processed: boolean;
}
