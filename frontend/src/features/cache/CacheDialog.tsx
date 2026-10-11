import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Pin, PinOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog } from '../../components/ui'
import { api, type CacheEntry, type CleanResult, type CleanScope } from '../../lib/api'
import { fmtBytes, fmtCompact, fmtUsd, timeAgo, useNow } from '../../lib/format'
import { refreshWorkspace } from '../../lib/queryClient'
import { confirmDialog, useUi } from '../../lib/store'

const SCOPES: { value: CleanScope; label: string }[] = [
  { value: 'unpinned', label: 'All unpinned' },
  { value: 'stale', label: 'Stale (out of date)' },
  { value: 'older_than', label: 'Older than...' },
]

/** What a clean-up will do, including what it costs to get BigQuery data back. */
function CleanSummary({ result }: { result: CleanResult }) {
  const rebuild = result.nodes.filter((n) => n.rebuild_from_bigquery)
  const usd = rebuild.reduce((sum, n) => sum + n.rebuild_usd, 0)
  return (
    <div className="space-y-3">
      <p>
        This deletes the cached results of <b className="text-fg">{result.nodes.length}</b> node
        {result.nodes.length === 1 ? '' : 's'} and frees <b className="text-fg">{fmtBytes(result.freed_bytes)}</b>:
      </p>
      <ul className="max-h-40 space-y-1 overflow-auto font-mono text-[12px]">
        {result.nodes.map((n) => (
          <li key={n.node_id} className="flex justify-between gap-3">
            <span className="truncate text-fg">{n.name}</span>
            <span className="shrink-0 text-faint">{fmtBytes(n.bytes)}</span>
          </li>
        ))}
      </ul>
      {rebuild.length > 0 && (
        <p className="text-warn">
          {rebuild.length === 1 ? 'A BigQuery source is' : `${rebuild.length} BigQuery sources are`} included. Getting
          the data back means querying BigQuery again
          {usd > 0 ? `, about ${fmtUsd(usd)} at the last run's size` : ''}. Transforms can be re-run for free.
        </p>
      )}
    </div>
  )
}

export function CacheDialog() {
  const open = useUi((s) => s.cacheOpen)
  const setOpen = useUi((s) => s.setCacheOpen)
  const select = useUi((s) => s.select)
  const now = useNow()
  const q = useQuery({ queryKey: ['cache'], queryFn: api.cache, enabled: open })
  const [scope, setScope] = useState<CleanScope>('unpinned')
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)
  const data = q.data
  const biggest = Math.max(1, ...(data?.entries.map((e) => e.bytes) ?? [1]))

  const togglePin = async (e: CacheEntry) => {
    try {
      await api.pin(e.node_id, !e.pinned)
    } catch (err) {
      toast.error('Could not change the pin', { description: (err as Error).message })
    }
    await refreshWorkspace()
  }

  const clearOne = async (e: CacheEntry) => {
    const ok = await confirmDialog({
      title: `Delete the cache of ${e.name}?`,
      body: (
        <CleanSummary
          result={{
            preview: true,
            freed_bytes: e.bytes,
            nodes: [{ node_id: e.node_id, name: e.name, bytes: e.bytes, rebuild_usd: e.rebuild_usd, rebuild_from_bigquery: e.rebuild_from_bigquery }],
          }}
        />
      ),
      confirmLabel: 'Delete cache',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const { freed_bytes } = await api.clearCache(e.node_id)
      toast.success(`Freed ${fmtBytes(freed_bytes)}`)
    } catch (err) {
      toast.error('Could not delete the cache', { description: (err as Error).message })
    }
    await refreshWorkspace()
  }

  const clean = async () => {
    setBusy(true)
    try {
      const preview = await api.cleanCache(scope, days, true)
      if (!preview.nodes.length) {
        toast('Nothing to clean', { description: 'No unpinned, idle node matches.' })
        return
      }
      const ok = await confirmDialog({
        title: 'Clean up the cache?',
        body: <CleanSummary result={preview} />,
        confirmLabel: `Delete ${fmtBytes(preview.freed_bytes)}`,
        tone: 'danger',
      })
      if (!ok) return
      const done = await api.cleanCache(scope, days, false)
      toast.success(`Freed ${fmtBytes(done.freed_bytes)}`, { description: `${done.nodes.length} caches deleted` })
    } catch (err) {
      toast.error('Clean-up failed', { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
    await refreshWorkspace()
  }

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Cache"
      width={760}
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <span className="mr-auto text-xs text-faint">
            {data ? (
              <>
                <b className="font-medium text-fg">{fmtBytes(data.total_bytes)}</b> used
                {data.pinned_bytes > 0 && <> · {fmtBytes(data.pinned_bytes)} pinned</>}
              </>
            ) : (
              'Loading...'
            )}
          </span>
          <span className="text-xs text-faint">Clean up</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as CleanScope)}
            className="h-8 rounded-lg border border-line2 bg-panel2 px-2 text-xs text-fg outline-none focus:border-accent/60"
          >
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {scope === 'older_than' && (
            <label className="flex items-center gap-1.5 text-xs text-faint">
              <input
                type="number"
                min={0}
                value={days}
                onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))}
                className="h-8 w-16 rounded-lg border border-line2 bg-panel2 px-2 text-xs text-fg outline-none focus:border-accent/60"
              />
              days
            </label>
          )}
          <Button variant="primary" onClick={clean} disabled={busy || !data?.entries.length}>
            <Trash2 className="size-3.5" />
            Review and clean
          </Button>
        </div>
      }
    >
      {q.error && <p className="text-err">{q.error.message}</p>}
      {data && data.entries.length === 0 && <p className="py-6 text-center text-faint">Nothing is cached yet.</p>}
      {data && data.entries.length > 0 && (
        <div className="-mx-1 max-h-[52vh] overflow-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-panel text-[10px] uppercase tracking-wider text-faint">
              <tr>
                <th className="px-1 py-1.5 font-medium">Node</th>
                <th className="w-44 px-1 py-1.5 font-medium">Size</th>
                <th className="px-1 py-1.5 text-right font-medium">Rows</th>
                <th className="px-1 py-1.5 font-medium">Last run</th>
                <th className="w-16 px-1 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.node_id} className="border-t border-line">
                  <td className="px-1 py-2">
                    <button
                      type="button"
                      className="max-w-48 truncate font-mono text-fg hover:text-accent"
                      onClick={() => {
                        select(e.node_id)
                        setOpen(false)
                      }}
                      title="Open this node"
                    >
                      {e.name}
                    </button>
                    <div className="text-[10px] text-faint">
                      {e.kind === 'transform' ? 'transform' : e.source_type === 'bq_query' ? 'BigQuery query' : e.source_type === 'bq_table' ? 'BigQuery table' : 'file'}
                      {e.stale && <span className="ml-1.5 text-warn">stale</span>}
                    </div>
                  </td>
                  <td className="px-1 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel3">
                        <div
                          className={clsx('h-full rounded-full', e.kind === 'source' ? 'bg-src' : 'bg-trf')}
                          style={{ width: `${Math.max(2, (e.bytes / biggest) * 100)}%` }}
                        />
                      </div>
                      <span className="w-16 text-right font-mono tabular-nums text-fg">{fmtBytes(e.bytes)}</span>
                    </div>
                  </td>
                  <td className="px-1 py-2 text-right font-mono tabular-nums">{fmtCompact(e.row_count)}</td>
                  <td className="px-1 py-2 text-faint">{timeAgo(e.finished_at, now)}</td>
                  <td className="px-1 py-2">
                    <div className="flex justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={clsx('size-7', e.pinned && 'text-accent')}
                        onClick={() => togglePin(e)}
                        title={e.pinned ? 'Pinned: clean-up skips it. Click to unpin' : 'Pin: clean-up will skip it'}
                      >
                        {e.pinned ? <Pin className="size-3.5 fill-current" /> : <PinOff className="size-3.5" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={e.pinned}
                        onClick={() => clearOne(e)}
                        title={e.pinned ? 'Unpin to delete this cache' : 'Delete this cache'}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <p className="mt-3 break-all text-[11px] text-faint">{data.location}</p>}
    </Dialog>
  )
}
