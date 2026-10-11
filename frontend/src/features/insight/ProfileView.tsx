import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { LoaderCircle } from 'lucide-react'
import { api, type ColumnProfile } from '../../lib/api'
import { fmtCompact, fmtInt } from '../../lib/format'

/** Bars for 20 histogram buckets, or a single bar when every value is the same. */
function Histogram({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts)
  return (
    <div className="flex h-9 items-end gap-px" role="img" aria-label="Histogram">
      {counts.map((c, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
          key={i}
          className="min-w-[3px] flex-1 rounded-t-[2px] bg-accent/70"
          style={{ height: `${Math.max(c ? 8 : 0, (c / max) * 100)}%` }}
          title={`${fmtInt(c)} rows`}
        />
      ))}
    </div>
  )
}

function TopValues({ items, total }: { items: { value: string; count: number }[]; total: number }) {
  return (
    <div className="space-y-0.5">
      {items.map((t) => (
        <div key={t.value} className="flex items-center gap-2 text-[11px]" title={`${t.value}: ${fmtInt(t.count)} rows`}>
          <div className="relative h-4 flex-1 overflow-hidden rounded bg-panel3">
            <div className="absolute inset-y-0 left-0 bg-accent/35" style={{ width: `${(t.count / Math.max(1, total)) * 100}%` }} />
            <span className="absolute inset-y-0 left-1.5 flex items-center truncate font-mono text-fg">
              {t.value === '' ? '(empty string)' : t.value}
            </span>
          </div>
          <span className="w-12 text-right tabular-nums text-faint">{fmtCompact(t.count)}</span>
        </div>
      ))}
    </div>
  )
}

function Row({ c }: { c: ColumnProfile }) {
  const nulls = c.null_pct
  return (
    <div className="grid grid-cols-[minmax(120px,1.1fr)_90px_minmax(110px,1fr)_minmax(150px,1.6fr)] items-center gap-4 border-b border-line px-4 py-2.5">
      <div className="min-w-0">
        <div className="truncate font-mono text-[12.5px] font-medium text-fg" title={c.name}>
          {c.name}
        </div>
        <div className="truncate text-[10.5px] uppercase tracking-wide text-faint">{c.type}</div>
      </div>

      <div title={`${nulls}% of values are null`}>
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-faint">null</span>
          <span className={clsx('tabular-nums', nulls > 0 ? (nulls > 20 ? 'text-warn' : 'text-fg') : 'text-faint')}>
            {nulls === 0 ? '0%' : nulls < 0.1 ? '<0.1%' : `${nulls}%`}
          </span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-panel3">
          <div className={clsx('h-full', nulls > 20 ? 'bg-warn' : 'bg-accent/70')} style={{ width: `${Math.min(100, nulls)}%` }} />
        </div>
        <div className="mt-1.5 text-[11px] text-faint" title="Approximate distinct count">
          ~<span className="tabular-nums text-fg">{fmtCompact(c.distinct)}</span> distinct
        </div>
      </div>

      <div className="min-w-0 space-y-0.5 font-mono text-[11px]">
        {c.min !== null && (
          <>
            <div className="truncate text-muted" title={c.min}>
              <span className="mr-1.5 font-sans text-faint">min</span>
              {c.min}
            </div>
            <div className="truncate text-muted" title={c.max ?? ''}>
              <span className="mr-1.5 font-sans text-faint">max</span>
              {c.max}
            </div>
          </>
        )}
        {c.avg !== null && (
          <div className="truncate text-muted" title={`median ${c.q50}`}>
            <span className="mr-1.5 font-sans text-faint">avg</span>
            {Number(c.avg).toLocaleString(undefined, { maximumFractionDigits: 3 })}
          </div>
        )}
      </div>

      <div className="min-w-0">
        {c.histogram ? (
          <>
            <Histogram counts={c.histogram.counts} />
            <div className="mt-0.5 flex justify-between font-mono text-[10px] text-faint">
              <span className="truncate">{c.min}</span>
              <span className="truncate">{c.max}</span>
            </div>
          </>
        ) : c.top && c.top.length > 0 ? (
          <TopValues items={c.top} total={c.count} />
        ) : (
          <span className="text-[11px] text-faint">{c.kind === 'other' ? 'No chart for this type' : 'All values are null'}</span>
        )}
      </div>
    </div>
  )
}

export function ProfileView({ nodeId, version }: { nodeId: string; version: string }) {
  const q = useQuery({ queryKey: ['profile', nodeId, version], queryFn: () => api.profile(nodeId), retry: false })
  if (q.isPending)
    return (
      <div className="grid h-full place-items-center text-[13px] text-faint">
        <div className="flex items-center gap-2">
          <LoaderCircle className="size-4 animate-spin" /> Profiling columns...
        </div>
      </div>
    )
  if (q.isError) return <div className="p-6 text-center text-[13px] text-err">{(q.error as Error).message}</div>
  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 border-b border-line2 bg-panel2 px-4 py-2 text-[11px] text-faint">
        {fmtInt(q.data.rows)} rows · {q.data.columns.length} columns
        {q.data.truncated && ' (first 200 shown)'}
      </div>
      {q.data.columns.map((c) => (
        <Row key={c.name} c={c} />
      ))}
    </div>
  )
}
