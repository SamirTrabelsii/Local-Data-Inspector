import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChartColumn, ChartLine, ChartScatter, LoaderCircle, Table2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type Agg, api, type ChartConfig, type ChartData, type ChartType, type Column, type WNode } from '../../lib/api'
import { refreshWorkspace } from '../../lib/queryClient'
import { BarChart } from './BarChart'
import { LineScatter } from './LineScatter'
import { PivotTable } from './PivotTable'

const NUMERIC = /^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|FLOAT|DOUBLE|REAL|DECIMAL.*)$/i

const TYPES: { id: ChartType; label: string; icon: typeof ChartColumn }[] = [
  { id: 'bar', label: 'Bar', icon: ChartColumn },
  { id: 'line', label: 'Line', icon: ChartLine },
  { id: 'scatter', label: 'Scatter', icon: ChartScatter },
  { id: 'pivot', label: 'Pivot', icon: Table2 },
]

const AGGS: { id: Agg; label: string }[] = [
  { id: 'sum', label: 'Sum' },
  { id: 'avg', label: 'Average' },
  { id: 'count', label: 'Count' },
  { id: 'count_distinct', label: 'Distinct count' },
  { id: 'min', label: 'Min' },
  { id: 'max', label: 'Max' },
]

/** A sensible first chart: a text column against the first measure-like numeric column (not an id). */
export function defaultChartConfig(columns: Column[]): ChartConfig {
  const numeric = columns.filter((c) => NUMERIC.test(c.type))
  const num = numeric.find((c) => !/(^|_)id$/i.test(c.name)) ?? numeric[0]
  const cat =
    columns.find((c) => c.type.toUpperCase() === 'VARCHAR') ?? columns.find((c) => !NUMERIC.test(c.type)) ?? columns[0]
  return { type: 'bar', agg: num ? 'sum' : 'count', x: cat?.name, y: num ? [num.name] : [] }
}

/** Switching type keeps what still applies: pivot rows/columns/value follow X/series/Y and back. */
function retype(cfg: ChartConfig, type: ChartType): Partial<ChartConfig> {
  if (type === 'pivot') return { type, rows: cfg.rows ?? cfg.x, cols: cfg.cols ?? cfg.series, value: cfg.value ?? cfg.y[0] }
  return { type, x: cfg.x ?? cfg.rows, series: cfg.series ?? cfg.cols, y: cfg.y.length ? cfg.y : cfg.value ? [cfg.value] : [] }
}

function Select({
  label,
  value,
  onChange,
  options,
  none,
}: {
  label: string
  value: string | undefined
  onChange: (v: string | undefined) => void
  options: { id: string; label: string }[]
  none?: string
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] text-faint">
      {label}
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-8 min-w-0 rounded-lg border border-line2 bg-panel3 px-2 font-mono text-[12px] text-fg outline-none focus:border-accent/60"
      >
        {none !== undefined && <option value="">{none}</option>}
        {value && !options.some((o) => o.id === value) && <option value={value}>{value} (missing)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function ConfigForm({
  cfg,
  columns,
  onChange,
}: {
  cfg: ChartConfig
  columns: Column[]
  onChange: (patch: Partial<ChartConfig>) => void
}) {
  const all = columns.map((c) => ({ id: c.name, label: c.name }))
  const numeric = columns.filter((c) => NUMERIC.test(c.type)).map((c) => ({ id: c.name, label: c.name }))
  const aggSelect = (
    <Select
      label="Aggregate"
      value={cfg.agg}
      onChange={(v) => onChange({ agg: (v as Agg) ?? 'sum' })}
      options={AGGS.map((a) => ({ id: a.id, label: a.label }))}
    />
  )
  return (
    <div className="space-y-3 border-b border-line px-4 py-3">
      <div className="flex gap-1 rounded-lg bg-panel2 p-0.5" role="tablist" aria-label="Chart type">
        {TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={cfg.type === t.id}
            onClick={() => onChange(retype(cfg, t.id))}
            className={clsx(
              'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors',
              cfg.type === t.id ? 'bg-panel3 text-fg shadow-sm ring-1 ring-line2' : 'text-muted hover:text-fg',
            )}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {cfg.type === 'pivot' ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select label="Rows" value={cfg.rows} onChange={(rows) => onChange({ rows })} options={all} none="Pick a column" />
          <Select label="Columns" value={cfg.cols} onChange={(cols) => onChange({ cols })} options={all} none="None" />
          <Select
            label="Value"
            value={cfg.value}
            onChange={(value) => onChange({ value })}
            options={cfg.agg === 'sum' || cfg.agg === 'avg' ? numeric : all}
            none="Row count"
          />
          {aggSelect}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select label="X axis" value={cfg.x} onChange={(x) => onChange({ x })} options={all} none="Pick a column" />
          {cfg.type === 'scatter' ? (
            <Select
              label="Y axis"
              value={cfg.y[0]}
              onChange={(y) => onChange({ y: y ? [y] : [] })}
              options={numeric}
              none="Pick a column"
            />
          ) : (
            <div className="flex min-w-0 flex-col gap-1 text-[11px] text-faint">
              Y axis
              <div className="flex min-h-8 flex-wrap items-center gap-1">
                {(cfg.agg === 'sum' || cfg.agg === 'avg' ? numeric : all).slice(0, 12).map((c) => {
                  const on = cfg.y.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onChange({ y: on ? cfg.y.filter((y) => y !== c.id) : [...cfg.y, c.id].slice(-6) })}
                      className={clsx(
                        'h-6 rounded-md px-2 font-mono text-[11px] ring-1 ring-inset transition-colors',
                        on ? 'bg-accent/15 text-fg ring-accent/50' : 'bg-panel3 text-muted ring-line2 hover:text-fg',
                      )}
                    >
                      {c.label}
                    </button>
                  )
                })}
                {numeric.length === 0 && cfg.agg !== 'count' && <span className="text-warn">no numeric columns</span>}
              </div>
            </div>
          )}
          {cfg.type !== 'scatter' && aggSelect}
          <Select label="Series" value={cfg.series} onChange={(series) => onChange({ series })} options={all} none="None" />
        </div>
      )}
    </div>
  )
}

export function ChartPanel({ node, inputColumns, inputVersion }: { node: WNode; inputColumns: Column[] | null; inputVersion: string | null }) {
  const initial = useMemo<ChartConfig>(
    () => ({ type: 'bar', agg: 'sum', y: [], ...node.config }) as ChartConfig,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.id],
  )
  const [cfg, setCfg] = useState<ChartConfig>(initial)
  const saved = useRef(JSON.stringify(node.config))

  // Persist changes after a short pause so the picker doesn't write on every click.
  useEffect(() => {
    const json = JSON.stringify(cfg)
    if (json === saved.current) return
    const t = setTimeout(() => {
      api
        .updateNode(node.id, { config: cfg })
        .then(() => {
          saved.current = json
          return refreshWorkspace()
        })
        .catch((e) => toast.error('Could not save the chart', { description: e.message }))
    }, 500)
    return () => clearTimeout(t)
  }, [cfg, node.id])

  const ready = inputColumns !== null && inputVersion !== null
  const query = useQuery({
    queryKey: ['chart', node.id, inputVersion, JSON.stringify(cfg)],
    queryFn: ({ signal }) => api.chartData(node.id, cfg, signal),
    enabled: ready,
    retry: false,
    placeholderData: (prev) => prev,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      {inputColumns && (
        <ConfigForm cfg={cfg} columns={inputColumns} onChange={(patch) => setCfg((c) => ({ ...c, ...patch }))} />
      )}
      <div className="relative min-h-0 flex-1 p-3">
        {!ready ? (
          <Empty>
            {node.inputs.length === 0
              ? 'Connect this chart to a node: drag from that node’s right handle onto this one.'
              : `Run ${node.inputs[0]} to chart its result.`}
          </Empty>
        ) : query.isError ? (
          <Empty tone="warn">{(query.error as Error).message}</Empty>
        ) : !query.data ? (
          <Empty>
            <LoaderCircle className="mr-2 size-4 animate-spin" /> Drawing...
          </Empty>
        ) : (
          <>
            {query.data.type === 'bar' && <BarChart data={query.data} />}
            {(query.data.type === 'line' || query.data.type === 'scatter') && <LineScatter data={query.data} />}
            {query.data.type === 'pivot' && <PivotTable data={query.data} />}
            <Caption data={query.data} />
          </>
        )}
        {query.isFetching && query.data && (
          <LoaderCircle className="absolute top-4 right-4 size-3.5 animate-spin text-faint" />
        )}
      </div>
    </div>
  )
}

function Caption({ data }: { data: ChartData }) {
  const note =
    data.type === 'bar' && data.truncated
      ? `Top 30 of ${data.categories} categories; the rest are grouped as Other.`
      : data.type === 'line' && data.truncated
        ? 'Showing the first 5,000 points.'
        : data.type === 'scatter' && data.shown < data.total
          ? `A random sample of ${data.shown.toLocaleString()} of ${data.total.toLocaleString()} points.`
          : data.type === 'pivot' && data.truncated
            ? `Showing ${data.row_labels.length} of ${data.row_count} rows and ${data.col_labels.length} of ${data.col_count} columns.`
            : null
  return note ? <div className="absolute bottom-1 left-4 text-[11px] text-faint">{note}</div> : null
}

function Empty({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <div
      className={clsx(
        'grid h-full place-items-center px-6 text-center text-[13px]',
        tone === 'warn' ? 'text-warn' : 'text-faint',
      )}
    >
      <div className="flex items-center">{children}</div>
    </div>
  )
}
