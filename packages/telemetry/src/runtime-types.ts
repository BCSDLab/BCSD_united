export interface TelemetrySpan {
  setAttribute(name: string, value: string | number | boolean): unknown;
}

export interface TraceOptions {
  name: string;
  op?: string;
  attributes?: Record<string, string | number | boolean>;
  onlyIfParent?: boolean;
}
