import { toast } from 'sonner'
import { api, type DryRun, type WNode } from './api'
import { fmtBytes, fmtUsd } from './format'
import { queryClient, refreshWorkspace } from './queryClient'
import { confirmDialog, flushDraft, useDrafts } from './store'

export const dryRunKey = (sql: string) => ['dryrun', sql.trim()] as const

export const fetchDryRun = (sql: string) =>
  queryClient.fetchQuery({
    queryKey: dryRunKey(sql),
    queryFn: ({ signal }) => api.dryRun(sql.trim(), signal),
    staleTime: 60_000,
  })

/** Source runs cost money: dry-run first, refuse above the cap, confirm above the threshold. */
export async function runNode(node: WNode) {
  const sql = useDrafts.getState().drafts[node.id] ?? node.sql
  await flushDraft(node.id)
  if (!sql.trim()) {
    toast.error('Write some SQL first')
    return
  }

  if (node.kind === 'source') {
    let dr: DryRun
    try {
      dr = await fetchDryRun(sql)
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
    if (dr.needs_confirm) {
      const ok = await confirmDialog({
        title: 'Run this query on BigQuery?',
        body: (
          <div className="space-y-3">
            <p>
              BigQuery estimates this query will process{' '}
              <b className="text-fg">{fmtBytes(dr.bytes_processed)}</b>, about{' '}
              <b className="text-fg">{fmtUsd(dr.estimated_cost_usd)}</b> at on-demand pricing.
            </p>
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

  try {
    await api.run(node.id)
  } catch (e) {
    toast.error('Could not start run', { description: (e as Error).message })
    return
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
