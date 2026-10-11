import { Clock, Columns3, FlaskConical, HardDrive, PiggyBank, Rows3, Timer, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WNode } from '../../lib/api'
import { fmtBytes, fmtDateTime, fmtInt, fmtMs, fmtUsd, timeAgo, useNow } from '../../lib/format'
import { useSavings } from '../../lib/queryClient'
import { ExportMenu } from './ExportMenu'

function Item({
  icon: Icon,
  label,
  children,
  title,
}: {
  icon: typeof Rows3
  label: string
  children: ReactNode
  title?: string
}) {
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
  const mine = useSavings().data?.nodes.find((x) => x.node_id === node.id)
  if (!r) return null
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4 text-xs">
      <div className="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto">
        <Item icon={Rows3} label="Rows">
          {fmtInt(r.row_count)}
        </Item>
        <Item icon={Columns3} label="Columns">
          {r.columns.length}
        </Item>
        <Item icon={Timer} label="Execution">
          {fmtMs(r.exec_ms)}
        </Item>
        {node.source_type === 'bq_table' && r.bytes_processed != null && (
          <Item icon={HardDrive} label="Read" title="Estimated bytes scanned by the Storage Read API (no query job)">
            {fmtBytes(r.bytes_processed)}
          </Item>
        )}
        {node.source_type === 'bq_query' && (
          <Item
            icon={HardDrive}
            label="Billed"
            title={`Processed ${fmtBytes(r.bytes_processed)} · billed ${fmtBytes(r.bytes_billed)}`}
          >
            {fmtBytes(r.bytes_billed)}
          </Item>
        )}
        {mine && node.source_type === 'bq_query' && mine.spent_bytes > 0 && (
          <Item
            icon={PiggyBank}
            label="Spent, all runs"
            title={`${fmtBytes(mine.spent_bytes)} billed over ${mine.runs} run${mine.runs === 1 ? '' : 's'}`}
          >
            {fmtUsd(mine.spent_usd)}
          </Item>
        )}
        {mine && node.kind === 'transform' && mine.avoided_bytes > 0 && (
          <Item
            icon={PiggyBank}
            label="Saved, all runs"
            title={`${fmtBytes(mine.avoided_bytes)} of BigQuery scans avoided over ${mine.runs} local run${mine.runs === 1 ? '' : 's'}`}
          >
            {fmtUsd(mine.avoided_usd)}
          </Item>
        )}
        <Item
          icon={Clock}
          label={node.kind === 'source' ? 'Last refreshed' : 'Last run'}
          title={fmtDateTime(r.finished_at)}
        >
          {timeAgo(r.finished_at, now)}
        </Item>
        {node.sampled && (
          <div className="flex items-center gap-1.5 whitespace-nowrap text-warn">
            <FlaskConical className="size-3.5" />
            {node.kind === 'source' ? `${node.config.sample_percent}% sample` : 'Built from a sample'}
          </div>
        )}
        {node.stale && node.status !== 'running' && (
          <div className="flex items-center gap-1.5 whitespace-nowrap text-warn">
            <TriangleAlert className="size-3.5" />
            {node.kind === 'transform'
              ? 'Out of date: SQL or inputs changed'
              : node.source_type === 'bq_query'
                ? 'SQL changed since last refresh'
                : 'Settings changed since last refresh'}
          </div>
        )}
      </div>
      <ExportMenu node={node} />
    </div>
  )
}
