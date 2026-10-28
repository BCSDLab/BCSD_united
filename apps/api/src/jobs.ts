export interface Job {
  kind: string;
  key: string;
  payload: Record<string, unknown>;
}
