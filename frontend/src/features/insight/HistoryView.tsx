import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { History, LoaderCircle, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../components/ui'
import { api, type HistoryEntry, type RunComparison, type WNode } from '../../lib/api'
import { fmtBytes, fmtDateTime, fmtInt, fmtMs } from '../../lib/format'
import { editDraft } from '../../lib/store'

const paramText = (v: string | null | undefined) => (v == null ? 'undefined' : v.slice(v.indexOf(':') + 1))

/** A signed difference with a color: up is amber for time and bytes (more cost), neutral for rows. */
function Delta({ value, fmt, costly }: { value: number | null; fmt: (n: number) => string; costly?: boolean }) {
  if (value === null) return <span className="text-faint">-</span>
  if (value === 0) return <span className="text-faint">no change</span>
  return (
    <span className={clsx('tabular-nums', costly ? (value > 0 ? 'text-warn' : 'text-ok') : 'text-fg')}>
      {value > 0 ? '+' : '-'}
      {fmt(Math.abs(value))}
    </span>
  )
}

const STAT_ROWS: {
  key: keyof RunComparison['stats']
  label: string
  fmt: (n: number) => string
  costly?: boolean
  bq?: boolean
}[] = [
  { key: 'row_count', label: 'Rows', fmt: fmtInt },
  { key: 'exec_ms', label: 'Time', fmt: fmtMs, costly: true },
  { key: 'bytes_processed', label: 'Bytes processed', fmt: fmtBytes, costly: true, bq: true },
  { key: 'bytes_billed', label: 'Bytes billed', fmt: fmtBytes, costly: true, bq: true },
]

function Comparison({ cmp, older, newer }: { cmp: RunComparison; older: HistoryEntry; newer: HistoryEntry }) {
  const params = Object.entries(cmp.params_changed)
  const { added, removed, retyped } = cmp.columns
  const schemaSame = !added.length && !removed.length && !retyped.length
  const sameQuery = !cmp.sql_changed && !cmp.config_changed && !params.length
  return (
    <div className="space-y-4 border-t border-line2 bg-panel2/40 px-4 py-3 text-[12px]">
      <div className="flex items-center justify-between text-[11px] text-faint">
        <span>
          {fmtDateTime(older.finished_at)} <span className="mx-1">→</span> {fmtDateTime(newer.finished_at)}
        </span>
        {sameQuery && <span>Same query and parameters</span>}
      </div>

      <table className="w-full border-separate border-spacing-0 text-left">
        <thead>
          <tr className="text-[10.5px] uppercase tracking-wide text-faint">
            <th className="py-1 font-medium" />
            <th className="py-1 text-right font-medium">Earlier</th>
            <th className="py-1 text-right font-medium">Later</th>
            <th className="py-1 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {STAT_ROWS.filter((r) => !r.bq || cmp.stats[r.key].a !== null || cmp.stats[r.key].b !== null).map((r) => {
            const s = cmp.stats[r.key]
            return (
              <tr key={r.key} className="border-t border-line">
                <td className="border-t border-line py-1.5 font-sans text-muted">{r.label}</td>
                <td className="border-t border-line py-1.5 text-right tabular-nums text-muted">{s.a === null ? '-' : r.fmt(s.a)}</td>
                <td className="border-t border-line py-1.5 text-right tabular-nums text-fg">{s.b === null ? '-' : r.fmt(s.b)}</td>
                <td className="border-t border-line py-1.5 text-right">
                  <Delta value={s.delta} fmt={r.fmt} costly={r.costly} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {params.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">Parameters</h4>
          <div className="space-y-1 font-mono">
            {params.map(([name, v]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="text-muted">{`{{${name}}}`}</span>
                <span className="rounded bg-err/10 px-1.5 text-err">{paramText(v.before)}</span>
                <span className="text-faint">→</span>
                <span className="rounded bg-ok/10 px-1.5 text-ok">{paramText(v.after)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">Columns</h4>
        {schemaSame ? (
          <span className="text-faint">Same columns and types</span>
        ) : (
          <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
            {added.map((c) => (
              <span key={c.name} className="rounded bg-ok/10 px-1.5 py-0.5 text-ok" title={c.type}>
                + {c.name}
              </span>
            ))}
            {removed.map((c) => (
              <span key={c.name} className="rounded bg-err/10 px-1.5 py-0.5 text-err" title={c.type}>
                − {c.name}
              </span>
            ))}
            {retyped.map((c) => (
              <span key={c.name} className="rounded bg-warn/10 px-1.5 py-0.5 text-warn">
                {c.name}: {c.before} → {c.after}
              </span>
            ))}
          </div>
        )}
      </section>

      {cmp.sql_changed && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">SQL</h4>
          <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-panel py-1 font-mono text-[11.5px] leading-[1.55]">
            {cmp.sql_diff.map((l, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                key={i}
                className={clsx(
                  'whitespace-pre-wrap px-3',
                  l.op === 'add' && 'bg-ok/10 text-ok',
                  l.op === 'del' && 'bg-err/10 text-err',
                  l.op === 'same' && 'text-muted',
                )}
              >
                <span className="mr-2 inline-block w-2 select-none opacity-70">
                  {l.op === 'add' ? '+' : l.op === 'del' ? '-' : ' '}
                </span>
                {l.text || ' '}
              </div>
            ))}
          </pre>
        </section>
      )}
      {cmp.config_changed && <div className="text-[11px] text-warn">The node settings (sample size, columns, filter...) also changed.</div>}
    </div>
  )
}

export function HistoryView({ node }: { node: WNode }) {
  const version = node.result?.finished_at
  const history = useQuery({ queryKey: ['history', node.id, version], queryFn: () => api.history(node.id) })
  const entries = history.data ?? []
  const [picked, setPicked] = useState<number[]>([])

  // Compare the two newest runs by default; a new run resets the choice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the list changes
  useEffect(() => {
    setPicked(entries.slice(0, 2).map((e) => e.id))
  }, [history.data])

  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))

  const [a, b] = [...picked].sort((x, y) => x - y)
  const cmp = useQuery({
    queryKey: ['compare', node.id, a, b],
    queryFn: () => api.compareRuns(node.id, a, b),
    enabled: picked.length === 2,
  })
  const older = entries.find((e) => e.id === a)
  const newer = entries.find((e) => e.id === b)
  const editable = node.kind === 'transform' || node.source_type === 'bq_query'

  if (history.isPending)
    return (
      <div className="grid h-full place-items-center text-faint">
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    )
  if (entries.length === 0)
    return (
      <div className="grid h-full place-items-center text-center text-[13px] text-faint">
        <div>
          <History className="mx-auto mb-2 size-5" />
          Each successful run is recorded here
        </div>
      </div>
    )

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 border-b border-line2 bg-panel2 px-4 py-2 text-[11px] text-faint">
        {entries.length} run{entries.length === 1 ? '' : 's'} (last 50 are kept) · select two to compare
      </div>
      <ul>
        {entries.map((e, i) => {
          const on = picked.includes(e.id)
          const prev = entries[i + 1]
          const changed = prev && prev.sql_hash !== e.sql_hash
          const params = Object.entries(e.params)
          return (
            <li key={e.id} className={clsx('border-b border-line', on && 'bg-accent/[0.06]')}>
              <div className="flex items-center gap-3 px-4 py-2">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(e.id)}
                  aria-label={`Compare run from ${fmtDateTime(e.finished_at)}`}
                  className="size-3.5 accent-[#8b7cff]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px]">
                    <span className="text-fg">{fmtDateTime(e.finished_at)}</span>
                    {i === 0 && <span className="rounded-full bg-ok/10 px-1.5 text-[10px] font-medium text-ok">current</span>}
                    {changed && <span className="rounded-full bg-warn/10 px-1.5 text-[10px] font-medium text-warn">SQL changed</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] tabular-nums text-faint">
                    <span>{fmtInt(e.row_count)} rows</span>
                    <span>{e.columns.length} cols</span>
                    <span>{fmtMs(e.exec_ms)}</span>
                    {e.bytes_billed != null && <span>{fmtBytes(e.bytes_billed)} billed</span>}
                    {params.map(([name, v]) => (
                      <span key={name} className="font-mono text-muted">
                        {name}={paramText(v)}
                      </span>
                    ))}
                  </div>
                </div>
                {editable && i > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Load this run's SQL into the editor (not saved until you run it)"
                    onClick={() => {
                      editDraft(node.id, e.sql)
                      toast.success('SQL restored in the editor', { description: 'Run the node to use it.' })
                    }}
                  >
                    <RotateCcw className="size-3.5" />
                    Restore SQL
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {picked.length === 2 && (
        <div className="border-b border-line">
          {cmp.isPending || !older || !newer ? (
            <div className="grid h-20 place-items-center text-faint">
              <LoaderCircle className="size-4 animate-spin" />
            </div>
          ) : cmp.isError ? (
            <div className="p-4 text-[12px] text-err">{(cmp.error as Error).message}</div>
          ) : (
            <Comparison cmp={cmp.data} older={older} newer={newer} />
          )}
        </div>
      )}
    </div>
  )
}
