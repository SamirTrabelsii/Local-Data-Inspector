import { toast } from 'sonner'
import { api, type DryRun, type WNode } from './api'
import { fmtBytes, fmtUsd } from './format'
import { catalogQueries } from './catalog'
import { cachedNode, queryClient, refreshWorkspace } from './queryClient'
import { WarningList } from '../features/editor/Warnings'
import { confirmDialog, flushDraft, saveConfig, useDrafts } from './store'

export interface DryRunOpts {
  samplePercent?: number
  nodeId?: string
}

export const dryRunKey = (sql: string, opts: DryRunOpts = {}) =>
  ['dryrun', sql.trim(), opts.samplePercent ?? 0, opts.nodeId ?? ''] as const

export const fetchDryRun = (sql: string, opts: DryRunOpts = {}) =>
  queryClient.fetchQuery({
    queryKey: dryRunKey(sql, opts),
    queryFn: ({ signal }) => api.dryRun(sql.trim(), opts, signal),
    staleTime: 60_000,
  })

async function start(node: WNode) {
  try {
    await api.run(node.id)
  } catch (e) {
    toast.error('Could not start run', { description: (e as Error).message })
    return
  }
  await refreshWorkspace()
}

/** Table reads are free of query costs, but can be big: confirm above the same threshold as queries. */
async function runTableSource(node: WNode) {
  const table = node.config.table
  if (!table) {
    toast.error('Pick a table to read first')
    return
  }
  try {
    const [info, settings] = await Promise.all([
      queryClient.fetchQuery(catalogQueries.table(table)),
      queryClient.fetchQuery({ queryKey: ['settings'], queryFn: api.getSettings }),
    ])
    if (!['TABLE', 'SNAPSHOT', 'EXTERNAL'].includes(info.type)) {
      toast.error(`${table} is a ${info.type.toLowerCase()}`, {
        description: "Views can't be read directly. Use a query source for it.",
      })
      return
    }
    const sample = node.config.sample_percent
    const bytes = ((info.num_bytes ?? 0) * (sample ?? 100)) / 100
    if (bytes > settings.confirm_above_bytes) {
      const ok = await confirmDialog({
        title: 'Copy this table to your machine?',
        body: (
          <div className="space-y-3">
            <p>
              <b className="text-fg">{table}</b> holds <b className="text-fg">{fmtBytes(info.num_bytes)}</b>
              {sample ? `, and a ${sample}% sample is about ${fmtBytes(bytes)}` : ''}
              {node.config.columns?.length || node.config.row_filter
                ? ' before your column selection and row filter.'
                : '.'}
            </p>
            <p className="text-faint">
              It's read with the BigQuery Storage API: no query job and no analysis cost, but it uses your Storage API
              read quota and local disk.
            </p>
          </div>
        ),
        confirmLabel: 'Read table',
      })
      if (!ok) return
    }
  } catch (e) {
    toast.error('Could not read the table', { description: (e as Error).message })
    return
  }
  await start(node)
}

/** Source runs cost money: dry-run first, refuse above the cap, confirm above the threshold. */
export async function runNode(node: WNode) {
  const sql = useDrafts.getState().drafts[node.id] ?? node.sql
  await flushDraft(node.id)
  if (node.source_type === 'bq_table') return runTableSource(cachedNode(node.id) ?? node)
  if (node.source_type === 'file') return start(node)
  if (!sql.trim()) {
    toast.error('Write some SQL first')
    return
  }

  if (node.kind === 'source') {
    let dr: DryRun
    const sample = node.config.sample_percent
    try {
      dr = await fetchDryRun(sql, { samplePercent: sample, nodeId: node.id })
    } catch (e) {
      toast.error('BigQuery rejected the query', { description: (e as Error).message })
      return
    }
    if (dr.exceeds_cap) {
      toast.error(`Would process ${fmtBytes(dr.bytes_processed)}`, {
        description: `That's above your ${fmtBytes(dr.max_bytes_billed)} safety cap. Narrow the query or raise the cap in Settings.`,
      })
      return
    }
    if (dr.needs_confirm || dr.warnings.length) {
      const ok = await confirmDialog({
        title: 'Run this query on BigQuery?',
        body: (
          <div className="space-y-3">
            <p>
              BigQuery estimates this query will process <b className="text-fg">{fmtBytes(dr.bytes_processed)}</b>,
              about <b className="text-fg">{fmtUsd(dr.estimated_cost_usd)}</b> at on-demand pricing
              {sample ? ` (a ${sample}% sample)` : ''}.
            </p>
            <WarningList warnings={dr.warnings} />
            <p className="text-faint">
              Hard cap: {fmtBytes(dr.max_bytes_billed)}. Once cached, every downstream transform is free.
            </p>
          </div>
        ),
        confirmLabel: 'Run on BigQuery',
      })
      if (!ok) return
    }
  }

  await start(node)
}

/** Promote a sample run: turn sampling off and run the node in full (with the usual cost checks). */
export async function runFull(node: WNode) {
  await saveConfig(node.id, { sample_percent: undefined })
  const fresh = cachedNode(node.id)
  if (fresh) await runNode(fresh)
}

export async function cancelNode(node: WNode) {
  try {
    const { cancelled } = await api.cancel(node.id)
    if (cancelled) toast(`Cancelling ${node.name}...`, { description: 'The previous result is kept.' })
  } catch (e) {
    toast.error('Could not cancel', { description: (e as Error).message })
  }
  await refreshWorkspace()
}

export async function runDownstream(node: WNode) {
  await flushDraft(node.id)
  try {
    const { queued } = await api.runDownstream(node.id)
    toast.success(`Running ${queued.length} node${queued.length === 1 ? '' : 's'} downstream`, {
      description: 'Transforms run locally on DuckDB, no BigQuery cost.',
    })
  } catch (e) {
    toast.error('Could not run downstream', { description: (e as Error).message })
  }
  await refreshWorkspace()
}
