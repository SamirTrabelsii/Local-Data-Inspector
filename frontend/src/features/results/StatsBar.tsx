import { Clock, Columns3, HardDrive, Rows3, Timer, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WNode } from '../../lib/api'
import { fmtBytes, fmtDateTime, fmtInt, fmtMs, timeAgo, useNow } from '../../lib/format'

function Item({ icon: Icon, label, children, title }: { icon: typeof Rows3; label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap" title={title}>
      <Icon className="size-3.5 text-faint" />
      <span className="text-faint">{label}</span>
      <span className="font-medium tabular-nums text-fg">{children}</span>
    </div>
  )
}

export function StatsBar({ node }: { node: WNode }) {
  const now = useNow()
  const r = node.result
  if (!r) return null
  return (
    <div className="flex h-10 shrink-0 items-center gap-5 overflow-x-auto border-b border-line px-4 text-xs">
      <Item icon={Rows3} label="Rows">
        {fmtInt(r.row_count)}
      </Item>
      <Item icon={Columns3} label="Columns">
        {r.columns.length}
      </Item>
      <Item icon={Timer} label="Execution">
        {fmtMs(r.exec_ms)}
      </Item>
      {node.kind === 'source' && (
        <Item
          icon={HardDrive}
          label="Billed"
          title={`Processed ${fmtBytes(r.bytes_processed)} · billed ${fmtBytes(r.bytes_billed)}`}
        >
          {fmtBytes(r.bytes_billed)}
        </Item>
      )}
      <Item icon={Clock} label={node.kind === 'source' ? 'Last refreshed' : 'Last run'} title={fmtDateTime(r.finished_at)}>
        {timeAgo(r.finished_at, now)}
      </Item>
      {node.stale && node.status !== 'running' && (
        <div className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-warn">
          <TriangleAlert className="size-3.5" />
          {node.kind === 'source' ? 'SQL changed since last refresh' : 'Out of date: SQL or inputs changed'}
        </div>
      )}
    </div>
  )
}
