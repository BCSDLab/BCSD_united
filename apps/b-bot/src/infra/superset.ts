const MAX_ROWS = 100;
const TIMEOUT_MS = 15_000;
type JsonObject = Record<string, unknown>;
export interface DatasetMetadata {
  id: number;
  datasource_type: string;
  sql?: string | null;
  is_sqllab_view?: boolean;
  main_dttm_col?: string | null;
  columns?: Array<{ column_name: string; groupby?: boolean; type?: string; is_dttm?: boolean }>;
  metrics?: Array<{ metric_name: string }>;
}

function config() {
  const env = process.env;
  if (!env.SUPERSET_BASE_URL || !env.SUPERSET_USERNAME || !env.SUPERSET_PASSWORD)
    throw new Error('Superset is not configured.');
  let url: URL;
  try {
    url = new URL(env.SUPERSET_BASE_URL);
  } catch {
    throw new Error('Superset is not configured correctly.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Superset URL is not configured safely.');
  return url.toString().replace(/\/$/, '');
}

export function getAllowedDatasetIds(): Set<number> {
  const entries = (process.env.SUPERSET_DATASET_IDS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!entries.length || entries.some((id) => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))))
    throw new Error('Superset datasets are not configured.');
  return new Set(entries.map(Number));
}

class SupersetClient {
  private token = '';
  private csrf = '';
  private cookies = new Map<string, string>();
  private loginPromise?: Promise<void>;

  private rememberCookies(response: Response) {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<JsonObject> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (init.body) headers.set('Content-Type', 'application/json');
    if (this.csrf && init.method && init.method !== 'GET') headers.set('X-CSRFToken', this.csrf);
    const response = await fetch(`${config()}${path}`, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    this.rememberCookies(response);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Superset ${init.method ?? 'GET'} ${path} failed (${response.status}). ${detail.slice(0, 200)}`.trim(),
      );
    }
    try {
      return (await response.json()) as JsonObject;
    } catch {
      throw new Error('Superset returned an invalid response.');
    }
  }

  async authenticate() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const login = await this.request('/api/v1/security/login', {
        method: 'POST',
        body: JSON.stringify({
          username: process.env.SUPERSET_USERNAME,
          password: process.env.SUPERSET_PASSWORD,
          provider: 'db',
          refresh: true,
        }),
      });
      if (typeof login.access_token !== 'string') throw new Error('Superset authentication failed.');
      this.token = login.access_token;
      const csrf = await this.request('/api/v1/security/csrf_token/');
      if (typeof csrf.result !== 'string') throw new Error('Superset authentication failed.');
      this.csrf = csrf.result;
    })();
    try {
      await this.loginPromise;
    } catch (error) {
      this.loginPromise = undefined;
      throw new Error(`Superset authentication failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  async get(path: string) {
    await this.authenticate();
    return this.request(path);
  }
  async post(path: string, body: unknown) {
    await this.authenticate();
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }
  async put(path: string, body: unknown) {
    await this.authenticate();
    return this.request(path, { method: 'PUT', body: JSON.stringify(body) });
  }
}

export function createSupersetClient() {
  return new SupersetClient();
}
export async function getDatasetMetadata(client: SupersetClient, id: number): Promise<DatasetMetadata> {
  const response = await client.get(`/api/v1/dataset/${id}`);
  const dataset = response.result as DatasetMetadata | undefined;
  // Physical and registered SQL datasets both use "table"; Superset owns the stored SQL.
  if (!dataset || dataset.id !== id || dataset.datasource_type !== 'table')
    throw new Error('Unsupported Superset dataset.');
  return dataset;
}

export interface DatasetQuery {
  columns: string[];
  metrics: string[];
  groupby: string[];
  timeRange?: string;
  filters: Array<{ column: string; operator: string; value: string | number }>;
  timeColumn?: string;
  timeGrain?: 'PT1H' | 'P1D' | 'P1W' | 'P1M' | 'P1Y';
  orderBy: Array<{ field: string; ascending: boolean }>;
  rowLimit: number;
}

export async function queryDataset(client: SupersetClient, id: number, query: DatasetQuery) {
  const limit = Math.min(Math.max(1, query.rowLimit), MAX_ROWS);
  const temporalColumn: Array<{
    columnType: string;
    sqlExpression: string;
    label: string;
    expressionType: string;
    timeGrain: NonNullable<DatasetQuery['timeGrain']>;
  }> =
    query.timeColumn && query.timeGrain
      ? [
          {
            columnType: 'BASE_AXIS',
            sqlExpression: query.timeColumn,
            label: query.timeColumn,
            expressionType: 'SQL',
            timeGrain: query.timeGrain,
          },
        ]
      : [];
  const queryColumns: Array<string | (typeof temporalColumn)[number]> = [
    ...new Set([...query.columns, ...query.groupby]),
  ].filter((column) => !temporalColumn.length || column !== query.timeColumn);
  queryColumns.push(...temporalColumn);
  // Superset treats an absent `metrics` as a raw (non-grouped) SELECT, while `metrics: []`
  // still groups the selected columns. Only a query with neither metrics nor grouping is raw.
  const rawSelection = query.groupby.length === 0 && query.metrics.length === 0;
  const response = await client.post('/api/v1/chart/data', {
    datasource: { id, type: 'table' },
    queries: [
      {
        columns: queryColumns,
        ...(rawSelection ? {} : { metrics: [...new Set(query.metrics)] }),
        granularity: query.timeColumn,
        row_limit: limit + 1,
        orderby: query.orderBy.map(({ field, ascending }) => [field, ascending]),
        filters: query.filters.map(({ column, operator, value }) => ({ col: column, op: operator, val: value })),
        time_range: query.timeRange ?? 'No filter',
        extras: query.timeGrain ? { time_grain_sqla: query.timeGrain } : {},
        annotation_layers: [],
      },
    ],
    result_format: 'json',
    result_type: 'full',
  });
  const queries = response.result as Array<{ data?: unknown[] }> | undefined;
  if (!queries || !Array.isArray(queries[0]?.data)) throw new Error('Superset returned an invalid query result.');
  const data = queries[0].data;
  return { rows: data.slice(0, limit), limit, truncated: data.length > limit };
}

export async function createSupersetDashboard(
  title: string,
  charts: Array<{
    title: string;
    datasetId: number;
    chartType: string;
    columns: string[];
    metrics: string[];
    groupby: string[];
    temporalColumns?: string[];
    timeColumn?: string;
    timeRange?: string;
    filters?: Array<{ column: string; operator: string; value: string | number }>;
    timeGrain?: 'PT1H' | 'P1D' | 'P1W' | 'P1M' | 'P1Y';
    orderBy?: Array<{ field: string; ascending: boolean }>;
    rowLimit?: number;
  }>,
): Promise<string> {
  const client = createSupersetClient();
  const initialPosition = JSON.stringify({
    DASHBOARD_VERSION_KEY: 'v2',
    ROOT_ID: { id: 'ROOT_ID', type: 'ROOT', children: ['GRID_ID'] },
    GRID_ID: { id: 'GRID_ID', type: 'GRID', children: [], parents: ['ROOT_ID'] },
  });
  const createdDashboard = await client.post('/api/v1/dashboard/', {
    dashboard_title: title,
    published: false,
    position_json: initialPosition,
    json_metadata: JSON.stringify({
      chart_configuration: {},
      global_chart_configuration: {},
      native_filter_configuration: [],
    }),
  });
  const dashboardId = createdDashboard.id;
  if (typeof dashboardId !== 'number') throw new Error('Superset could not create a dashboard.');
  const chartIds: number[] = [];
  for (const chart of charts) {
    const vizType =
      chart.chartType === 'table'
        ? 'table'
        : chart.chartType === 'line'
          ? 'echarts_timeseries_line'
          : 'echarts_timeseries_bar';
    const xAxis = chart.timeGrain
      ? chart.timeColumn!
      : chart.chartType === 'line'
        ? chart.timeColumn!
        : (chart.groupby[0] ?? chart.timeColumn ?? '');
    // The table plugin only turns a physical groupby column into a grained BASE_AXIS when
    // `temporal_columns_lookup` marks it temporal, so the temporal axis must be first.
    const dimensions = [
      ...new Set([
        ...(chart.timeGrain && chart.timeColumn ? [chart.timeColumn] : []),
        ...chart.columns,
        ...chart.groupby,
      ]),
    ];
    const temporalColumns = [
      ...new Set([...(chart.temporalColumns ?? []), ...(chart.timeColumn ? [chart.timeColumn] : [])]),
    ];
    const series = chart.groupby.filter((column) => column !== xAxis);
    const rowLimit = Math.min(Math.max(1, chart.rowLimit ?? MAX_ROWS), MAX_ROWS);
    const orderby = (chart.orderBy ?? []).map(({ field, ascending }) => [field, ascending] as [string, boolean]);
    // Matches buildQuery: raw mode omits `metrics`, while any grouping keeps GROUP BY semantics.
    const rawSelection = chart.chartType === 'table' && chart.groupby.length === 0 && chart.metrics.length === 0;
    const query = {
      columns: (chart.chartType === 'table' ? dimensions : [xAxis, ...series]).map((column) =>
        chart.timeColumn === column && chart.timeGrain
          ? {
              columnType: 'BASE_AXIS',
              sqlExpression: column,
              label: column,
              expressionType: 'SQL',
              timeGrain: chart.timeGrain,
            }
          : column,
      ),
      ...(rawSelection ? {} : { metrics: chart.metrics }),
      granularity: chart.timeColumn,
      row_limit: rowLimit,
      orderby,
      filters: (chart.filters ?? []).map(({ column, operator, value }) => ({ col: column, op: operator, val: value })),
      time_range: chart.timeRange ?? 'No filter',
      extras: chart.timeGrain ? { time_grain_sqla: chart.timeGrain } : {},
      annotation_layers: [],
      ...(chart.chartType === 'table'
        ? {}
        : {
            series_columns: series,
            post_processing: [
              {
                operation: 'pivot',
                options: {
                  index: [xAxis],
                  columns: series,
                  aggregates: Object.fromEntries(chart.metrics.map((metric) => [metric, { operator: 'mean' }])),
                  drop_missing_columns: true,
                },
              },
              { operation: 'flatten' },
            ],
          }),
    };
    const params = {
      datasource: `${chart.datasetId}__table`,
      viz_type: vizType,
      slice_name: chart.title,
      groupby: chart.chartType === 'table' ? dimensions : series,
      metrics: chart.metrics,
      all_columns: dimensions,
      query_mode:
        chart.chartType !== 'table' || chart.metrics.length > 0 || chart.groupby.length > 0 ? 'aggregate' : 'raw',
      ...(chart.chartType === 'table' && temporalColumns.length
        ? { temporal_columns_lookup: Object.fromEntries(temporalColumns.map((column) => [column, true])) }
        : {}),
      row_limit: rowLimit,
      order_by_cols: orderby.map(([field, ascending]) => JSON.stringify([field, ascending])),
      timeseries_limit_metric: chart.orderBy?.find(({ field }) => chart.metrics.includes(field))?.field,
      order_desc: chart.orderBy?.find(({ field }) => chart.metrics.includes(field))?.ascending === false,
      x_axis: xAxis,
      granularity_sqla: chart.timeColumn,
      time_grain_sqla: chart.timeGrain,
      time_range: chart.timeRange ?? 'No filter',
      adhoc_filters: (chart.filters ?? []).map(({ column, operator, value }) => ({
        expressionType: 'SIMPLE',
        subject: column,
        operator,
        comparator: value,
        clause: 'WHERE',
      })),
    };
    const createdChart = await client.post('/api/v1/chart/', {
      slice_name: chart.title,
      viz_type: vizType,
      datasource_id: chart.datasetId,
      datasource_type: 'table',
      dashboards: [dashboardId],
      params: JSON.stringify(params),
      query_context: JSON.stringify({
        datasource: { id: chart.datasetId, type: 'table' },
        queries: [query],
        result_format: 'json',
        result_type: 'full',
      }),
    });
    const id = createdChart.id;
    if (typeof id !== 'number') throw new Error('Superset could not create a chart.');
    chartIds.push(id);
  }
  const positions: JsonObject = {
    DASHBOARD_VERSION_KEY: 'v2',
    ROOT_ID: { id: 'ROOT_ID', type: 'ROOT', children: ['GRID_ID'] },
  };
  const rowIds: string[] = [];
  for (const [index, chartId] of chartIds.entries()) {
    const rowId = `ROW-${index}`;
    const chartNode = `CHART-${chartId}`;
    rowIds.push(rowId);
    positions[rowId] = {
      id: rowId,
      type: 'ROW',
      children: [chartNode],
      parents: ['ROOT_ID', 'GRID_ID'],
      meta: { background: 'BACKGROUND_TRANSPARENT' },
    };
    positions[chartNode] = {
      id: chartNode,
      type: 'CHART',
      children: [],
      parents: ['ROOT_ID', 'GRID_ID', rowId],
      meta: { chartId, width: 12, height: 50, sliceName: charts[index].title },
    };
  }
  positions.GRID_ID = { id: 'GRID_ID', type: 'GRID', children: rowIds, parents: ['ROOT_ID'] };
  await client.put(`/api/v1/dashboard/${dashboardId}`, { position_json: JSON.stringify(positions) });
  return `${config()}/superset/dashboard/${dashboardId}/`;
}
