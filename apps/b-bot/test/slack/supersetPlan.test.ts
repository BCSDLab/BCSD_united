import { beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => ({ generateStructured: vi.fn() }));
const api = vi.hoisted(() => ({
  createSupersetClient: vi.fn(),
  getAllowedDatasetIds: vi.fn(),
  getDatasetMetadata: vi.fn(),
  queryDataset: vi.fn(),
  createSupersetDashboard: vi.fn(),
}));
vi.mock('@koin/b-bot-ai', () => model);
vi.mock('~/infra/superset', () => api);
import { planDashboard, createDashboard, answer, classifyRequest } from '~/services/superset';
const chart = { title: '매출', datasetId: 1, chartType: 'bar', columns: [], metrics: ['sales'], groupby: ['month'] };
beforeEach(() => {
  vi.resetAllMocks();
  api.getAllowedDatasetIds.mockReturnValue(new Set([1]));
  api.getDatasetMetadata.mockResolvedValue({
    id: 1,
    datasource_type: 'table',
    columns: [
      { column_name: 'month', type: 'VARCHAR' },
      { column_name: 'created_at', type: 'TIMESTAMP', is_dttm: true },
      { column_name: 'false_timestamp', type: 'TIMESTAMP', is_dttm: false },
      { column_name: 'main_date', type: 'DATE', is_dttm: false },
    ],
    main_dttm_col: 'main_date',
    metrics: [{ metric_name: 'sales' }],
  });
});
describe('Superset model output boundaries', () => {
  it.each([
    { datasetId: 999 },
    { columns: ['password'] },
    { metrics: ['SUM(secret)'] },
    { groupby: ['unknown'] },
    { timeColumn: 'false_timestamp', timeRange: 'Last month' },
    { chartType: 'line', timeColumn: 'month' },
    { timeGrain: 'quarter', timeColumn: 'created_at' },
    { filters: [{ column: 'month', operator: 'SQL', value: 'DROP TABLE users' }] },
    { orderBy: [{ field: 'password', ascending: false }] },
    { orderBy: [{ field: 'sales', ascending: 'false' }] },
    { rowLimit: 0 },
    { rowLimit: 101 },
  ])('rejects an unsafe plan before any Superset write: %j', async (patch) => {
    model.generateStructured.mockResolvedValue({ title: '매출', charts: [{ ...chart, ...patch }] });
    await expect(planDashboard('매출 대시보드 만들어줘')).rejects.toThrow();
    expect(api.createSupersetDashboard).not.toHaveBeenCalled();
  });
  it('accepts the dataset main temporal column but rejects SQL-type inference', async () => {
    model.generateStructured.mockResolvedValue({
      title: '매출',
      charts: [{ ...chart, groupby: [], timeColumn: 'main_date', timeGrain: 'P1M' }],
    });
    await expect(planDashboard('월별 매출')).resolves.toMatchObject({
      charts: [{ timeColumn: 'main_date', timeGrain: 'P1M' }],
    });
  });
  it('accepts and preserves a listed time grain', async () => {
    model.generateStructured.mockResolvedValue({
      title: '매출',
      charts: [{ ...chart, groupby: [], timeColumn: 'created_at', timeGrain: 'P1M' }],
    });
    await expect(planDashboard('월별 매출 대시보드')).resolves.toMatchObject({
      charts: [{ timeColumn: 'created_at', timeGrain: 'P1M' }],
    });
  });
  it('adds a deterministic warning when the requested result is truncated', async () => {
    model.generateStructured
      .mockResolvedValueOnce({
        datasetId: 1,
        columns: [],
        metrics: ['sales'],
        groupby: ['month'],
        timeRange: null,
        timeColumn: null,
        timeGrain: null,
        orderBy: [{ field: 'sales', ascending: false }],
        rowLimit: 1,
        filters: [],
      })
      .mockResolvedValueOnce({ answer: 'Top result' });
    api.queryDataset.mockResolvedValue({ rows: [{ month: 'May', sales: 99 }], limit: 1, truncated: true });
    await expect(answer('매출 상위')).resolves.toContain('⚠️ 상위 1행만 반영한 값입니다.');
  });
  it('revalidates saved plans against current dataset metadata before creating', async () => {
    api.getDatasetMetadata.mockResolvedValue({
      id: 1,
      datasource_type: 'table',
      columns: [{ column_name: 'month', type: 'VARCHAR' }],
      metrics: [],
    });
    await expect(createDashboard({ title: '매출', charts: [chart] } as never)).rejects.toThrow();
    expect(api.createSupersetDashboard).not.toHaveBeenCalled();
  });
});

const table = { title: '매출', datasetId: 1, chartType: 'table', columns: [], metrics: ['sales'], groupby: ['month'] };
const rawTable = { title: '원본', datasetId: 1, chartType: 'table', columns: ['month'], metrics: [], groupby: [] };

describe('Aggregate table sorting matches the saved chart plugin', () => {
  it.each([
    { orderBy: [{ field: 'month', ascending: true }] },
    {
      orderBy: [
        { field: 'sales', ascending: false },
        { field: 'sales', ascending: true },
      ],
    },
  ])('rejects a dimension or multi-key sort before any write: %j', async (patch) => {
    model.generateStructured.mockResolvedValue({ title: '매출', charts: [{ ...table, ...patch }] });
    await expect(planDashboard('매출 대시보드 만들어줘')).rejects.toThrow();
    expect(api.createSupersetDashboard).not.toHaveBeenCalled();
  });
  it('rejects invalid sorts for a saved plan before creating anything', async () => {
    await expect(
      createDashboard({
        title: '매출',
        charts: [
          {
            ...table,
            orderBy: [
              { field: 'sales', ascending: false },
              { field: 'month', ascending: true },
            ],
          },
        ],
      } as never),
    ).rejects.toThrow();
    expect(api.createSupersetDashboard).not.toHaveBeenCalled();
  });
  it('normalizes an unspecified aggregate sort to the first metric descending', async () => {
    model.generateStructured.mockResolvedValue({ title: '매출', charts: [{ ...table }] });
    await expect(planDashboard('매출 대시보드')).resolves.toMatchObject({
      charts: [{ orderBy: [{ field: 'sales', ascending: false }] }],
    });
  });
  it('accepts a single selected saved-metric sort', async () => {
    model.generateStructured.mockResolvedValue({
      title: '매출',
      charts: [{ ...table, orderBy: [{ field: 'sales', ascending: true }] }],
    });
    await expect(planDashboard('매출 대시보드')).resolves.toMatchObject({
      charts: [{ orderBy: [{ field: 'sales', ascending: true }] }],
    });
  });
  it('keeps multi-key raw table sorts and normalizes duplicate columns', async () => {
    model.generateStructured.mockResolvedValue({
      title: '원본',
      charts: [
        {
          ...rawTable,
          columns: ['month', 'month', 'created_at'],
          orderBy: [
            { field: 'month', ascending: true },
            { field: 'created_at', ascending: false },
          ],
        },
      ],
    });
    await expect(planDashboard('원본 테이블')).resolves.toMatchObject({
      charts: [
        {
          columns: ['month', 'created_at'],
          orderBy: [
            { field: 'month', ascending: true },
            { field: 'created_at', ascending: false },
          ],
        },
      ],
    });
  });
  it('does not restrict ordering or add a metric sort for a group-only table', async () => {
    model.generateStructured.mockResolvedValue({
      title: '그룹',
      charts: [{ ...table, metrics: [], orderBy: [{ field: 'month', ascending: true }] }],
    });
    await expect(planDashboard('그룹 테이블')).resolves.toMatchObject({
      charts: [{ metrics: [], orderBy: [{ field: 'month', ascending: true }] }],
    });
    model.generateStructured.mockResolvedValue({ title: '그룹', charts: [{ ...table, metrics: [] }] });
    await expect(planDashboard('그룹 테이블')).resolves.toMatchObject({ charts: [{ metrics: [], orderBy: [] }] });
  });
});

describe('Non-table selections cannot discard columns', () => {
  it('rejects a column that is neither the axis nor a series', async () => {
    model.generateStructured.mockResolvedValue({ title: '매출', charts: [{ ...chart, columns: ['created_at'] }] });
    await expect(planDashboard('매출 차트')).rejects.toThrow();
    expect(api.createSupersetDashboard).not.toHaveBeenCalled();
  });
  it('accepts no-op duplicates of the axis and series', async () => {
    model.generateStructured.mockResolvedValue({ title: '매출', charts: [{ ...chart, columns: ['month'] }] });
    await expect(planDashboard('매출 차트')).resolves.toMatchObject({ charts: [{ columns: ['month'] }] });
  });
  it('keeps multi-key ordering on the axis and series, including a temporal axis', async () => {
    model.generateStructured.mockResolvedValue({
      title: '추세',
      charts: [
        {
          title: '추세',
          datasetId: 1,
          chartType: 'line',
          columns: [],
          metrics: ['sales'],
          groupby: ['month'],
          timeColumn: 'created_at',
          orderBy: [
            { field: 'created_at', ascending: true },
            { field: 'sales', ascending: false },
          ],
        },
      ],
    });
    await expect(planDashboard('추세 차트')).resolves.toMatchObject({
      charts: [
        {
          orderBy: [
            { field: 'created_at', ascending: true },
            { field: 'sales', ascending: false },
          ],
        },
      ],
    });
  });
  it('rejects ordering by a field that is not selected', async () => {
    model.generateStructured.mockResolvedValue({
      title: '매출',
      charts: [{ ...chart, orderBy: [{ field: 'main_date', ascending: true }] }],
    });
    await expect(planDashboard('매출 차트')).rejects.toThrow();
  });
});

describe('Registered SQL data boundaries', () => {
  it('uses virtual dataset metadata without sending stored SQL or Jinja to the model', async () => {
    api.getDatasetMetadata.mockResolvedValue({
      id: 1,
      datasource_type: 'table',
      sql: "SELECT 'NEVER_SEND_RAW_SQL' AS month WHERE {{ filter_values('region') }}",
      columns: [{ column_name: 'month', type: 'VARCHAR' }],
      metrics: [{ metric_name: 'sales' }],
    });
    model.generateStructured.mockResolvedValue({ title: '매출', charts: [chart] });
    await planDashboard('매출 대시보드');
    const request = model.generateStructured.mock.calls[0][0];
    expect(request.prompt).not.toContain('NEVER_SEND_RAW_SQL');
    expect(request.prompt).not.toContain('filter_values');
    expect(JSON.parse(request.prompt).datasets[0]).not.toHaveProperty('sql');
  });
});

describe('Claude schema compatibility', () => {
  const unsupported = /^(maxItems|minLength|maxLength|minimum|maximum|multipleOf|maxProperties|minProperties)$/;
  /** Mirrors the API rules: no unsupported keywords and no enum on a multi-type field. */
  function assertAcceptable(node: unknown, path = '$'): void {
    if (Array.isArray(node)) {
      node.forEach((child, index) => assertAcceptable(child, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    expect(Object.keys(schema).filter((key) => unsupported.test(key))).toEqual([]);
    if (Array.isArray(schema.type) && schema.type.length > 1) {
      throw new Error(`${path} must use anyOf instead of a union type`);
    }
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'enum' || key === 'required' || key === 'type') continue;
      assertAcceptable(value, `${path}.${key}`);
    }
  }

  it('sends schemas the Claude API accepts for every structured request', async () => {
    api.getDatasetMetadata.mockResolvedValue({
      id: 1,
      datasource_type: 'table',
      columns: [
        { column_name: 'month', type: 'VARCHAR' },
        { column_name: 'created_at', type: 'TIMESTAMP', is_dttm: true },
      ],
      metrics: [{ metric_name: 'sales' }],
    });
    api.queryDataset.mockResolvedValue({ rows: [], limit: 100, truncated: false });
    model.generateStructured
      .mockResolvedValueOnce({ title: '매출', charts: [chart] })
      .mockResolvedValueOnce({
        datasetId: 1,
        columns: ['month'],
        metrics: [],
        groupby: [],
        timeRange: null,
        timeColumn: null,
        timeGrain: null,
        orderBy: [],
        rowLimit: null,
        filters: [],
      })
      .mockResolvedValueOnce({ answer: 'ok' })
      .mockResolvedValueOnce({ intent: 'answer' });
    await planDashboard('매출 대시보드');
    await answer('지난달 매출');
    await classifyRequest('질문');
    const schemas = model.generateStructured.mock.calls.map(([request]) => request.schema);
    expect(schemas).toHaveLength(4);
    schemas.forEach((schema) => assertAcceptable(schema));
  });
});
