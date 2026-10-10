import { api } from './api'
import { queryClient } from './queryClient'

/** BigQuery metadata, shared by the schema browser and SQL autocomplete. Listing is free. */
const STALE = 10 * 60_000

export const catalogKeys = {
  all: ['bq-catalog'] as const,
  projects: ['bq-catalog', 'projects'] as const,
  datasets: (project: string) => ['bq-catalog', 'datasets', project] as const,
  tables: (project: string, dataset: string) => ['bq-catalog', 'tables', project, dataset] as const,
  table: (id: string) => ['bq-catalog', 'table', id] as const,
}

export const catalogQueries = {
  projects: () => ({ queryKey: catalogKeys.projects, queryFn: api.bqProjects, staleTime: STALE }),
  datasets: (project: string) => ({
    queryKey: catalogKeys.datasets(project),
    queryFn: () => api.bqDatasets(project),
    staleTime: STALE,
  }),
  tables: (project: string, dataset: string) => ({
    queryKey: catalogKeys.tables(project, dataset),
    queryFn: () => api.bqTables(project, dataset),
    staleTime: STALE,
  }),
  table: (id: string) => ({ queryKey: catalogKeys.table(id), queryFn: () => api.bqTable(id), staleTime: STALE }),
}

/** Fetch through the cache; metadata lookups for autocomplete never throw. */
export async function fetchCatalog<T>(opts: { queryKey: readonly unknown[]; queryFn: () => Promise<T> }) {
  try {
    return await queryClient.fetchQuery({ ...opts, staleTime: STALE, retry: false })
  } catch {
    return undefined
  }
}

export const refreshCatalog = () => queryClient.invalidateQueries({ queryKey: catalogKeys.all })

export const queryForTable = (id: string) => `SELECT\n  *\nFROM \`${id}\`\nLIMIT 1000\n`

/** MIME type used when dragging a table from the browser onto the canvas. */
export const TABLE_DRAG_TYPE = 'application/x-ldi-bq-table'
