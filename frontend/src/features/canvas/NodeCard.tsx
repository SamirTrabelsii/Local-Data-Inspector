import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import clsx from 'clsx'
import { Columns3, Rows3, Timer } from 'lucide-react'
import type { WNode } from '../../lib/api'
import { fmtBytes, fmtCompact, fmtDateTime, fmtMs, timeAgo, useNow } from '../../lib/format'
import { KindIcon, StatusPill } from '../../components/ui'

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
  return (
    <div
      className={clsx(
        'group relative w-[264px] rounded-xl border bg-panel/95 backdrop-blur-sm transition-[border-color,box-shadow] duration-150',
        'shadow-[0_10px_30px_-14px_rgba(0,0,0,0.9)]',
        selected ? 'border-accent/70 shadow-[0_0_0_3px_rgba(139,124,255,0.16)]' : 'border-line2 hover:border-[#3b4153]',
      )}
    >
      {n.status === 'running' && <div className="running-sheen absolute inset-x-4 -top-px h-px" />}
      {n.kind === 'transform' && <Handle type="target" position={Position.Left} />}

      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
        <KindIcon kind={n.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] font-medium text-fg">{n.name}</div>
          <div className="text-[11px] text-faint">{n.kind === 'source' ? 'BigQuery source' : 'DuckDB transform'}</div>
        </div>
        <StatusPill status={n.status} />
      </div>

      <div className="border-t border-line px-3 py-2.5">
        {r ? (
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
              {n.kind === 'source' ? (
                r.bytes_billed != null && <span>{fmtBytes(r.bytes_billed)} billed</span>
              ) : (
                <span className="text-ok/70">free</span>
              )}
            </div>
          </>
        ) : (
          <div className="text-xs text-faint">{n.status === 'running' ? 'Running...' : 'Not run yet'}</div>
        )}
        {n.status === 'error' && n.error && (
          <div className="mt-2 line-clamp-2 rounded-md bg-err/10 px-2 py-1 font-mono text-[11px] leading-snug text-err">
            {n.error}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  )
}
