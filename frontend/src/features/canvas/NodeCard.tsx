import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import clsx from 'clsx'
import { Columns3, FlaskConical, Pin, Rows3, Square, Timer } from 'lucide-react'
import type { WNode } from '../../lib/api'
import { fmtBytes, fmtCompact, fmtDateTime, fmtMs, fmtUsd, timeAgo, useNow } from '../../lib/format'
import { useSavings } from '../../lib/queryClient'
import { cancelNode } from '../../lib/run'
import { KindIcon, StatusPill, sourceLabel } from '../../components/ui'

export type LdiNode = Node<{ node: WNode }, 'ldi'>

function Stat({ icon: Icon, value, label }: { icon: typeof Rows3; value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-faint">
        <Icon className="size-3" />
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-[13px] tabular-nums text-fg">{value}</div>
    </div>
  )
}

export function NodeCard({ data, selected }: NodeProps<LdiNode>) {
  const n = data.node
  const now = useNow()
  const r = n.result
  const mine = useSavings().data?.nodes.find((x) => x.node_id === n.id)
  return (
    <div
      className={clsx(
        'group relative w-[264px] rounded-xl border bg-panel/95 backdrop-blur-sm transition-[border-color,box-shadow] duration-150',
        'shadow-[0_10px_30px_-14px_rgba(0,0,0,0.9)]',
        selected ? 'border-accent/70 shadow-[0_0_0_3px_rgba(139,124,255,0.16)]' : 'border-line2 hover:border-[#3b4153]',
      )}
    >
      {n.status === 'running' && <div className="running-sheen absolute inset-x-4 -top-px h-px" />}
      {n.kind !== 'source' && <Handle type="target" position={Position.Left} />}

      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
        <KindIcon kind={n.kind} sourceType={n.source_type} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] font-medium text-fg">{n.name}</div>
          <div className="truncate text-[11px] text-faint">
            {n.kind === 'source'
              ? sourceLabel(n.source_type, n.config.format)
              : n.kind === 'chart'
                ? `Chart · ${n.config.type ?? 'bar'}`
                : 'DuckDB transform'}
          </div>
        </div>
        {n.pinned && <Pin className="size-3 shrink-0 fill-current text-accent" aria-label="Pinned" />}
        <StatusPill status={n.status} />
        {n.status === 'running' && (
          <button
            type="button"
            title="Cancel this run"
            onClick={(e) => {
              e.stopPropagation()
              void cancelNode(n)
            }}
            className="nodrag -mr-1 grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-err/15 hover:text-err"
          >
            <Square className="size-3 fill-current" />
          </button>
        )}
      </div>

      <div className="border-t border-line px-3 py-2.5">
        {n.kind === 'chart' ? (
          <div className="truncate text-xs text-faint">
            {n.inputs[0] ? (
              <>
                Reads <span className="font-mono text-muted">{n.inputs[0]}</span>
              </>
            ) : (
              'Connect an input'
            )}
          </div>
        ) : r ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat icon={Rows3} label="rows" value={fmtCompact(r.row_count)} />
              <Stat icon={Columns3} label="cols" value={String(r.columns.length)} />
              <Stat icon={Timer} label="time" value={fmtMs(r.exec_ms)} />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
              <span title={fmtDateTime(r.finished_at)}>
                {n.kind === 'source' ? 'Refreshed' : 'Ran'} {timeAgo(r.finished_at, now)}
              </span>
              {n.source_type === 'bq_query' ? (
                r.bytes_billed != null && (
                  <span title={mine ? `${fmtUsd(mine.spent_usd)} spent over ${mine.runs} runs` : undefined}>
                    {fmtBytes(r.bytes_billed)} billed
                  </span>
                )
              ) : n.source_type === 'bq_table' ? (
                <span>no query cost</span>
              ) : mine && mine.avoided_bytes > 0 ? (
                <span
                  className="text-ok/80"
                  title={`Avoided ${fmtBytes(mine.avoided_bytes)} of BigQuery scans over ${mine.runs} local runs`}
                >
                  saved {fmtUsd(mine.avoided_usd)}
                </span>
              ) : (
                <span className="text-ok/70">free</span>
              )}
            </div>
            {n.sampled && (
              <div
                className="mt-1.5 flex items-center gap-1 text-[11px] text-warn"
                title="Built from a sample of the data. Run the source in full to promote it."
              >
                <FlaskConical className="size-3" />
                {n.config.sample_percent ? `${n.config.sample_percent}% sample` : 'from a sample'}
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-faint">{n.status === 'running' ? 'Running...' : 'Not run yet'}</div>
        )}
        {n.params_missing.length > 0 && (
          <div className="mt-2 truncate rounded-md bg-warn/10 px-2 py-1 font-mono text-[11px] text-warn">
            undefined: {n.params_missing.map((p) => `{{${p}}}`).join(' ')}
          </div>
        )}
        {n.status === 'error' && n.error && (
          <div className="mt-2 line-clamp-2 rounded-md bg-err/10 px-2 py-1 font-mono text-[11px] leading-snug text-err">
            {n.error}
          </div>
        )}
      </div>

      {n.kind !== 'chart' && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
