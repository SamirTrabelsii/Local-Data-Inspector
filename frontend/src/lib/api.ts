export type NodeKind = 'source' | 'transform'
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

export interface WNode {
  id: string
  kind: NodeKind
  name: string
  sql: string
  x: number
  y: number
  status: NodeStatus
  stale: boolean
  error: string | null
  inputs: string[]
  result: RunResult | null
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

export interface DryRun {
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
}

export interface BqStatus {
  ok: boolean
  project: string | null
  account: string | null
  error: string | null
  hint: string | null
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const api = {
  workspace: () => req<Workspace>('GET', '/workspace'),
  createNode: (body: { kind: NodeKind; name?: string; sql?: string; x: number; y: number; inputs?: string[] }) =>
    req<WNode>('POST', '/nodes', body),
  updateNode: (id: string, body: Partial<Pick<WNode, 'name' | 'sql' | 'x' | 'y'>>) =>
    req<WNode>('PATCH', `/nodes/${id}`, body),
  deleteNode: (id: string) => req<void>('DELETE', `/nodes/${id}`),
  createEdge: (source: string, target: string) => req<WEdge>('POST', '/edges', { source, target }),
  deleteEdge: (source: string, target: string) => req<void>('DELETE', `/edges/${source}/${target}`),
  run: (id: string) => req<{ queued: string[] }>('POST', `/nodes/${id}/run`),
  runDownstream: (id: string) => req<{ queued: string[] }>('POST', `/nodes/${id}/run-downstream`),
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
  dryRun: (sql: string, signal?: AbortSignal) => req<DryRun>('POST', '/bq/dry-run', { sql }, signal),
  getSettings: () => req<Settings>('GET', '/settings'),
  putSettings: (s: Settings) => req<Settings>('PUT', '/settings', s),
}
