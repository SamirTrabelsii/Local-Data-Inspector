export type NodeKind = 'source' | 'transform' | 'chart'
export type SourceType = 'bq_query' | 'bq_table' | 'file'
export type NodeStatus = 'running' | 'error' | 'never_run' | 'stale' | 'fresh'

export interface Column {
  name: string
  type: string
}

export interface RunResult {
  row_count: number
  columns: Column[]
  exec_ms: number
  bytes_processed: number | null
  bytes_billed: number | null
  finished_at: string
}

export interface TableSourceConfig {
  table: string
  columns?: string[]
  row_filter?: string
}

/** Sample-first mode: read only this percentage of the table(s). Absent = full run. */
export interface SampleConfig {
  sample_percent?: number
}

export interface FileSourceConfig {
  file: string
  name: string
  format: 'csv' | 'parquet' | 'excel' | 'json'
  size: number
  sheets?: string[]
  sheet?: string
}

export type ChartType = 'bar' | 'line' | 'scatter' | 'pivot'
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct'

export interface ChartConfig {
  type: ChartType
  agg: Agg
  x?: string
  y: string[]
  series?: string
  rows?: string
  cols?: string
  value?: string
}

export interface WNode {
  id: string
  kind: NodeKind
  source_type: SourceType | null
  config: Partial<TableSourceConfig & FileSourceConfig & SampleConfig & ChartConfig>
  name: string
  sql: string
  x: number
  y: number
  status: NodeStatus
  stale: boolean
  error: string | null
  inputs: string[]
  input_ids: string[]
  /** Names of the {{parameters}} this node's SQL uses, and those that no parameter defines yet. */
  params_used: string[]
  params_missing: string[]
  result: RunResult | null
  pinned: boolean
  /** Built from a sample: this source is sampled, or a transform reads one upstream. */
  sampled: boolean
}

export interface WEdge {
  source: string
  target: string
}

export interface Workspace {
  nodes: WNode[]
  edges: WEdge[]
}

export interface ResultPage {
  columns: Column[]
  rows: unknown[][]
  offset: number
  total: number
}

export interface CostWarning {
  code: 'missing_partition_filter' | 'select_star_wide' | 'large_scan'
  table: string | null
  message: string
}

export interface DryRun {
  warnings: CostWarning[]
  sample_percent: number | null
  bytes_processed: number
  estimated_cost_usd: number
  max_bytes_billed: number
  needs_confirm: boolean
  exceeds_cap: boolean
}

export interface Settings {
  bq_project: string
  bq_location: string
  max_bytes_billed: number
  confirm_above_bytes: number
  price_per_tib_usd: number
  bq_pinned_projects: string[]
}

export interface BqStatus {
  ok: boolean
  project: string | null
  account: string | null
  error: string | null
  hint: string | null
}

export interface BqField {
  name: string
  type: string
  mode: string
  description: string | null
  fields?: BqField[]
}

export interface BqTableInfo {
  id: string
  type: string
  num_rows: number | null
  num_bytes: number | null
  location: string | null
  created: string | null
  modified: string | null
  description: string | null
  partitioning: { type: string; field: string | null } | null
  clustering: string[] | null
  columns: BqField[]
}

export interface SavingsTotals {
  spent_bytes: number
  avoided_bytes: number
  spent_usd: number
  avoided_usd: number
  bq_runs: number
  local_runs: number
  since: string | null
}

export interface NodeSavings {
  node_id: string
  name: string
  spent_bytes: number
  avoided_bytes: number
  spent_usd: number
  avoided_usd: number
  runs: number
}

export interface CacheEntry {
  node_id: string
  name: string
  kind: NodeKind
  source_type: SourceType | null
  bytes: number
  row_count: number
  finished_at: string
  pinned: boolean
  stale: boolean
  rebuild_usd: number
  rebuild_from_bigquery: boolean
}

export type CleanScope = 'unpinned' | 'stale' | 'older_than'

export interface CleanResult {
  preview: boolean
  freed_bytes: number
  nodes: Pick<CacheEntry, 'node_id' | 'name' | 'bytes' | 'rebuild_usd' | 'rebuild_from_bigquery'>[]
}

export interface ColumnProfile {
  name: string
  type: string
  kind: 'numeric' | 'temporal' | 'text' | 'bool' | 'other'
  count: number
  null_pct: number
  distinct: number
  min: string | null
  max: string | null
  avg: string | null
  q50: string | null
  histogram: { lo: number; hi: number; counts: number[] } | null
  top: { value: string; count: number }[] | null
}

export interface Profile {
  rows: number
  columns: ColumnProfile[]
  truncated: boolean
}

interface SeriesData {
  name: string
  values: (number | null)[]
}

export type ChartData =
  | { type: 'bar'; labels: string[]; series: SeriesData[]; truncated: boolean; categories: number }
  | {
      type: 'line'
      xkind: 'numeric' | 'temporal' | 'category'
      x: number[]
      labels: string[] | null
      series: SeriesData[]
      truncated: boolean
    }
  | {
      type: 'scatter'
      xkind: 'numeric' | 'temporal'
      x: number[]
      series: SeriesData[]
      total: number
      shown: number
    }
  | {
      type: 'pivot'
      rows_label: string
      cols_label: string | null
      measure: string
      row_labels: string[]
      col_labels: string[]
      cells: (number | null)[][]
      truncated: boolean
      row_count: number
      col_count: number
    }

export interface HistoryEntry {
  id: number
  sql: string
  config: Record<string, unknown>
  /** {name: "type:value"} of the parameters this run used. */
  params: Record<string, string | null>
  sql_hash: string
  row_count: number
  columns: Column[]
  exec_ms: number
  bytes_processed: number | null
  bytes_billed: number | null
  finished_at: string
}

export interface RunComparison {
  a: number
  b: number
  sql_changed: boolean
  sql_diff: { op: 'same' | 'add' | 'del'; text: string }[]
  config_changed: boolean
  params_changed: Record<string, { before: string | null; after: string | null }>
  columns: {
    added: Column[]
    removed: Column[]
    retyped: { name: string; before: string; after: string }[]
  }
  stats: Record<'row_count' | 'exec_ms' | 'bytes_processed' | 'bytes_billed', { a: number | null; b: number | null; delta: number | null }>
}

export type ParamType = 'string' | 'number' | 'date' | 'bool'

export interface Param {
  name: string
  /** null = used in SQL but not defined yet. */
  type: ParamType | null
  value: string | null
  used_by: string[]
}

export type ExportFormat = 'csv' | 'parquet' | 'xlsx'
export type PushMode = 'create' | 'overwrite' | 'append'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const raw = body instanceof Blob
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined || raw ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (typeof data.detail === 'string') message = data.detail
      else if (Array.isArray(data.detail)) message = data.detail.map((d: { msg: string }) => d.msg).join('; ')
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status)
  }
  if (res.status === 204) return undefined as T
  return (res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()) as T
}

const qs = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()

export const api = {
  workspace: () => req<Workspace>('GET', '/workspace'),
  createNode: (body: {
    kind: NodeKind
    source_type?: 'bq_query' | 'bq_table'
    name?: string
    name_hint?: string
    sql?: string
    config?: WNode['config']
    x: number
    y: number
    inputs?: string[]
  }) => req<WNode>('POST', '/nodes', body),
  updateNode: (id: string, body: Partial<Pick<WNode, 'name' | 'sql' | 'config' | 'x' | 'y'>>) =>
    req<WNode>('PATCH', `/nodes/${id}`, body),
  renamePreview: (id: string, name: string) =>
    req<{ affected: { id: string; name: string; references: number }[] }>(
      'GET',
      `/nodes/${id}/rename-preview?${qs({ name })}`,
    ),
  uploadFile: (file: File, pos: { x: number; y: number }) =>
    req<WNode>('POST', `/files?${qs({ filename: file.name, ...pos })}`, file),
  replaceFile: (id: string, file: File) => req<WNode>('PUT', `/nodes/${id}/file?${qs({ filename: file.name })}`, file),
  deleteNode: (id: string) => req<void>('DELETE', `/nodes/${id}`),
  createEdge: (source: string, target: string) => req<WEdge>('POST', '/edges', { source, target }),
  deleteEdge: (source: string, target: string) => req<void>('DELETE', `/edges/${source}/${target}`),
  run: (id: string) => req<{ queued: string[] }>('POST', `/nodes/${id}/run`),
  runDownstream: (id: string) => req<{ queued: string[] }>('POST', `/nodes/${id}/run-downstream`),
  cancel: (id: string) => req<{ cancelled: boolean }>('POST', `/nodes/${id}/cancel`),
  exportUrl: (id: string, format: ExportFormat) => `/api/nodes/${id}/export?${qs({ format })}`,
  exportTsv: (id: string, limit: number) => req<string>('GET', `/nodes/${id}/export?${qs({ format: 'tsv', limit })}`),
  push: (id: string, table: string, mode: PushMode) =>
    req<{ table: string; rows: number }>('POST', `/nodes/${id}/push`, { table, mode }),
  results: (
    id: string,
    params: { offset: number; limit: number; sort?: string; desc?: boolean },
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams({ offset: String(params.offset), limit: String(params.limit) })
    if (params.sort) {
      q.set('sort', params.sort)
      q.set('desc', String(!!params.desc))
    }
    return req<ResultPage>('GET', `/nodes/${id}/results?${q}`, undefined, signal)
  },
  bqStatus: () => req<BqStatus>('GET', '/bq/status'),
  dryRun: (sql: string, opts: { samplePercent?: number; nodeId?: string } = {}, signal?: AbortSignal) =>
    req<DryRun>('POST', '/bq/dry-run', { sql, sample_percent: opts.samplePercent, node_id: opts.nodeId }, signal),
  savings: () => req<{ total: SavingsTotals; nodes: NodeSavings[] }>('GET', '/savings'),
  cache: () => req<{ entries: CacheEntry[]; total_bytes: number; pinned_bytes: number; location: string }>('GET', '/cache'),
  pin: (id: string, pinned: boolean) => req<WNode>('POST', `/nodes/${id}/pin`, { pinned }),
  clearCache: (id: string) => req<{ freed_bytes: number }>('DELETE', `/cache/${id}`),
  cleanCache: (scope: CleanScope, olderThanDays: number, preview: boolean) =>
    req<CleanResult>('POST', '/cache/clean', { scope, older_than_days: olderThanDays, preview }),
  bqProjects: () => req<{ billing: string | null; projects: string[] }>('GET', '/bq/projects'),
  bqDatasets: (project: string) =>
    req<{ id: string; location: string | null }[]>('GET', `/bq/datasets?${qs({ project })}`),
  bqTables: (project: string, dataset: string) =>
    req<{ id: string; type: string }[]>('GET', `/bq/tables?${qs({ project, dataset })}`),
  bqTable: (id: string) => req<BqTableInfo>('GET', `/bq/table?${qs({ id })}`),
  bqPreview: (id: string, limit = 100) =>
    req<{ columns: Column[]; rows: unknown[][] }>('GET', `/bq/preview?${qs({ id, limit })}`),
  profile: (id: string) => req<Profile>('GET', `/nodes/${id}/profile`),
  chartData: (id: string, config?: ChartConfig, signal?: AbortSignal) =>
    req<ChartData>('POST', `/nodes/${id}/chart-data`, { config }, signal),
  history: (id: string) => req<HistoryEntry[]>('GET', `/nodes/${id}/history`),
  compareRuns: (id: string, a: number, b: number) =>
    req<RunComparison>('GET', `/nodes/${id}/history/compare?${qs({ a, b })}`),
  params: () => req<Param[]>('GET', '/params'),
  putParam: (name: string, type: ParamType, value: string) =>
    req<Param[]>('PUT', `/params/${encodeURIComponent(name)}`, { type, value }),
  deleteParam: (name: string) => req<void>('DELETE', `/params/${encodeURIComponent(name)}`),
  getSettings: () => req<Settings>('GET', '/settings'),
  putSettings: (s: Settings) => req<Settings>('PUT', '/settings', s),
}
