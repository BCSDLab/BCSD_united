import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupersetClient, createSupersetDashboard, getDatasetMetadata, queryDataset } from '~/infra/superset';

beforeEach(() => {
  vi.stubEnv('SUPERSET_BASE_URL', 'https://superset.test');
  vi.stubEnv('SUPERSET_USERNAME', 'fixture');
  vi.stubEnv('SUPERSET_PASSWORD', 'fixture');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

interface SupersetCall {
  url: string;
  body: Record<string, unknown>;
}

function stubSuperset(responses: unknown[]): SupersetCall[] {
  const calls: SupersetCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
      return Response.json(responses.shift());
    }),
  );
  return calls;
}

describe('Superset result boundaries', () => {
  it.each([
    { count: 0, limit: 100, truncated: false },
    { count: 100, limit: 100, truncated: false },
    { count: 101, limit: 100, truncated: true },
    { count: 2, limit: 1, truncated: true },
  ])(
    'returns at most $limit rows and reports omitted data for $count returned rows',
    async ({ count, limit, truncated }) => {
      const rows = Array.from({ length: count }, (_, index) => ({ product: `p${index}`, revenue: index }));
      const responses = [{ access_token: 'fixture' }, { result: 'csrf' }, { result: [{ data: rows }] }];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(responses.shift())),
      );
      const result = await queryDataset(createSupersetClient(), 1, {
        columns: [],
        metrics: ['revenue'],
        groupby: ['product'],
        filters: [],
        orderBy: [{ field: 'revenue', ascending: false }],
        rowLimit: limit,
      });
      expect(result.rows).toEqual(rows.slice(0, limit));
      expect(result.truncated).toBe(truncated);
      expect(result.limit).toBe(limit);
    },
  );
});

describe('Superset query boundaries', () => {
  it('omits metrics for plain raw column selections and preserves them for group-only queries', async () => {
    const calls = stubSuperset([
      { access_token: 'fixture' },
      { result: 'csrf' },
      { result: [{ data: [] }] },
      { access_token: 'fixture' },
      { result: 'csrf' },
      { result: [{ data: [] }] },
    ]);
    await queryDataset(createSupersetClient(), 1, {
      columns: ['product', 'product'],
      metrics: [],
      groupby: [],
      filters: [],
      orderBy: [],
      rowLimit: 10,
    });
    await queryDataset(createSupersetClient(), 1, {
      columns: [],
      metrics: [],
      groupby: ['product'],
      filters: [],
      orderBy: [],
      rowLimit: 10,
    });
    const [raw, grouped] = calls
      .filter((call) => call.url.endsWith('/api/v1/chart/data'))
      .map((call) => (call.body.queries as Array<Record<string, unknown>>)[0]);
    expect(raw).toMatchObject({ columns: ['product'] });
    expect(raw).not.toHaveProperty('metrics');
    expect(grouped).toMatchObject({ columns: ['product'], metrics: [] });
  });
});

describe('Superset saved table boundaries', () => {
  function createdChart(calls: SupersetCall[]) {
    const call = calls.find((entry) => entry.url.endsWith('/api/v1/chart/'));
    if (!call) throw new Error('chart was not created');
    return {
      params: JSON.parse(String(call.body.params)),
      query: JSON.parse(String(call.body.query_context)).queries[0],
    };
  }

  it('persists temporal columns in the lookup so the saved table keeps its monthly grain', async () => {
    const calls = stubSuperset([
      { access_token: 'fixture' },
      { result: 'csrf' },
      { id: 7 },
      { id: 11 },
      { result: {} },
    ]);
    await createSupersetDashboard('매출', [
      {
        title: '월별 매출',
        datasetId: 1,
        chartType: 'table',
        columns: [],
        metrics: ['sales'],
        groupby: [],
        temporalColumns: ['created_at', 'main_date'],
        timeColumn: 'created_at',
        timeGrain: 'P1M',
      },
    ]);
    const { params, query } = createdChart(calls);
    expect(params.temporal_columns_lookup).toEqual({ created_at: true, main_date: true });
    expect(params.time_grain_sqla).toBe('P1M');
    expect(params.groupby).toEqual(['created_at']);
    expect(params.query_mode).toBe('aggregate');
    expect(query.columns[0]).toMatchObject({ columnType: 'BASE_AXIS', sqlExpression: 'created_at', timeGrain: 'P1M' });
    expect(query.metrics).toEqual(['sales']);
  });

  it('omits metrics for a raw saved table with selected columns only', async () => {
    const calls = stubSuperset([
      { access_token: 'fixture' },
      { result: 'csrf' },
      { id: 7 },
      { id: 11 },
      { result: {} },
    ]);
    await createSupersetDashboard('원본', [
      { title: '원본', datasetId: 1, chartType: 'table', columns: ['product'], metrics: [], groupby: [] },
    ]);
    const { params, query } = createdChart(calls);
    expect(params.query_mode).toBe('raw');
    expect(query).toMatchObject({ columns: ['product'] });
    expect(query).not.toHaveProperty('metrics');
  });

  it('deduplicates raw table columns while staying in raw mode', async () => {
    const calls = stubSuperset([
      { access_token: 'fixture' },
      { result: 'csrf' },
      { id: 7 },
      { id: 11 },
      { result: {} },
    ]);
    await createSupersetDashboard('원본', [
      { title: '원본', datasetId: 1, chartType: 'table', columns: ['product', 'product'], metrics: [], groupby: [] },
    ]);
    const { params, query } = createdChart(calls);
    expect(params.query_mode).toBe('raw');
    expect(params.all_columns).toEqual(['product']);
    expect(params.groupby).toEqual(['product']);
    expect(query).toMatchObject({ columns: ['product'] });
    expect(query).not.toHaveProperty('metrics');
  });

  it('keeps empty metrics for a group-only saved table so grouping semantics survive', async () => {
    const calls = stubSuperset([
      { access_token: 'fixture' },
      { result: 'csrf' },
      { id: 7 },
      { id: 11 },
      { result: {} },
    ]);
    await createSupersetDashboard('그룹', [
      { title: '그룹', datasetId: 1, chartType: 'table', columns: [], metrics: [], groupby: ['product'] },
    ]);
    const { params, query } = createdChart(calls);
    expect(params.query_mode).toBe('aggregate');
    expect(query).toMatchObject({ columns: ['product'], metrics: [] });
  });
});

describe('Superset registered datasets', () => {
  it('accepts a registered SQL dataset without interpreting its stored SQL or Jinja', async () => {
    stubSuperset([
      { access_token: 'fixture' },
      { result: 'csrf' },
      {
        result: {
          id: 16,
          datasource_type: 'table',
          kind: 'virtual',
          is_sqllab_view: true,
          sql: "SELECT * FROM facts WHERE region IN {{ filter_values('region') | where_in }}",
          columns: [{ column_name: 'region', type: 'VARCHAR' }],
          metrics: [{ metric_name: 'count' }],
        },
      },
    ]);
    const dataset = await getDatasetMetadata(createSupersetClient(), 16);
    expect(dataset.id).toBe(16);
    expect(dataset.columns).toEqual([{ column_name: 'region', type: 'VARCHAR' }]);
    expect(dataset.metrics).toEqual([{ metric_name: 'count' }]);
  });

  it.each([
    { id: 99, datasource_type: 'table' },
    { id: 16, datasource_type: 'druid' },
  ])('rejects a mismatched dataset identity or unsupported datasource: %j', async (dataset) => {
    stubSuperset([{ access_token: 'fixture' }, { result: 'csrf' }, { result: dataset }]);
    await expect(getDatasetMetadata(createSupersetClient(), 16)).rejects.toThrow('Unsupported Superset dataset.');
  });

  it('reports which Superset call failed and why', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return Response.json({ access_token: 'fixture' });
        if (calls === 2) return Response.json({ result: 'csrf' });
        return new Response('{"message":"Forbidden"}', { status: 403 });
      }),
    );
    await expect(getDatasetMetadata(createSupersetClient(), 16)).rejects.toThrow(
      'Superset GET /api/v1/dataset/16 failed (403). {"message":"Forbidden"}',
    );
  });
});
