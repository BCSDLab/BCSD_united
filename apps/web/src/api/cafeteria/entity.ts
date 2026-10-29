import type { OriginalDining } from 'api/dinings/entity';
import type { APIResponse } from 'interfaces/APIResponse';

export type DiningResponseType = OriginalDining[] | { status: unknown };

export interface SoldoutReportRequest {
  image_url: string;
}

export interface SoldoutReportResponse extends APIResponse {
  report_id: number;
  status: 'PENDING';
  created_at: string;
}
