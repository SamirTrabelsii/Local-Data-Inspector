import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CircleAlert, Eye, FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../components/ui'
import { api, type WNode } from '../../lib/api'
import { catalogQueries } from '../../lib/catalog'
import { fmtBytes, fmtInt } from '../../lib/format'
import { refreshWorkspace } from '../../lib/queryClient'
import { saveConfig, useUi } from '../../lib/store'

const inputCls =
  'h-8 w-full rounded-lg border border-line2 bg-panel2 px-2.5 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/20'

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-xs font-medium text-fg">{label}</span>
        {hint && <span className="text-[11px] text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** A Source that copies a BigQuery table through the Storage Read API: no SQL, no query job. */
export function TableSourceEditor({ node }: { node: WNode }) {
  const cfg = node.config
  const [table, setTable] = useState(cfg.table ?? '')
  const [rowFilter, setRowFilter] = useState(cfg.row_filter ?? '')
  const preview = useUi((s) => s.setPreviewTable)
  const tableId = (cfg.table ?? '').trim()
  const info = useQuery({ ...catalogQueries.table(tableId), enabled: tableId.split('.').length === 3, retry: false })
  const selected = new Set(cfg.columns ?? [])
  const all = info.data?.columns.map((c) => c.name) ?? []

  const save = (patch: Partial<WNode['config']>) => saveConfig(node.id, patch)
  // Reads the latest config (not this render's), so quick successive clicks all count.
  const toggle = (col: string) =>
    saveConfig(node.id, (current) => {
      const next = new Set(current.columns?.length ? current.columns : all)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      // Every column selected == no selection: keeps the config (and staleness) stable.
      return { columns: next.size === all.length ? [] : all.filter((c) => next.has(c)) }
    })

  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <Field label="Table">
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={table}
            placeholder="project.dataset.table"
            spellCheck={false}
            onChange={(e) => setTable(e.target.value)}
            onBlur={() => table.trim() !== tableId && save({ table: table.trim(), columns: [] })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <Button size="md" onClick={() => tableId && preview(tableId)} disabled={!tableId} title="Preview rows (free)">
            <Eye className="size-3.5" /> Preview
          </Button>
        </div>
        <div className="mt-1.5 min-h-4 text-[11px] text-faint">
          {info.isLoading && 'Loading table metadata...'}
          {info.error && <span className="text-err">{info.error.message}</span>}
          {info.data && (
            <>
              {info.data.type.toLowerCase()} · {info.data.num_rows != null && `${fmtInt(info.data.num_rows)} rows · `}
              {fmtBytes(info.data.num_bytes)} · {info.data.location}
              {!['TABLE', 'SNAPSHOT', 'EXTERNAL'].includes(info.data.type) && (
                <span className="text-err"> · views can't be read directly, use a query source</span>
              )}
            </>
          )}
        </div>
      </Field>

      {all.length > 0 && (
        <Field
          label="Columns"
          hint={
            <>
              {selected.size ? `${selected.size} of ${all.length}` : `all ${all.length}`} ·{' '}
              <button type="button" className="hover:text-fg" onClick={() => save({ columns: [] })}>
                all
              </button>
            </>
          }
        >
          <div className="flex max-h-36 flex-wrap gap-1 overflow-auto">
            {info.data!.columns.map((c) => {
              const on = !selected.size || selected.has(c.name)
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => toggle(c.name)}
                  title={`${c.type}${c.description ? ` · ${c.description}` : ''}`}
                  className={clsx(
                    'rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset transition-colors',
                    on ? 'bg-src/10 text-fg ring-src/30' : 'text-faint ring-line2 hover:text-muted',
                  )}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        </Field>
      )}

      <Field label="Row filter" hint="optional BigQuery SQL condition, applied by BigQuery">
        <input
          className={inputCls}
          value={rowFilter}
          placeholder="e.g. country = 'TN' AND order_date >= '2024-01-01'"
          spellCheck={false}
          onChange={(e) => setRowFilter(e.target.value)}
          onBlur={() => rowFilter.trim() !== (cfg.row_filter ?? '') && save({ row_filter: rowFilter.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </Field>
    </div>
  )
}

/** A Source backed by a local file the user dropped; DuckDB reads it on Run. */
export function FileSourceEditor({ node }: { node: WNode }) {
  const cfg = node.config
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  const replace = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      await api.replaceFile(node.id, file)
      await api.run(node.id)
      toast.success(`Replaced with ${file.name}`)
    } catch (e) {
      toast.error('Could not replace the file', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
    await refreshWorkspace()
  }

  return (
    <div
      className={clsx('h-full overflow-auto p-4 transition-colors', dragging && 'bg-accent/[0.06]')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void replace(e.dataTransfer.files[0])
      }}
    >
      <div className="flex items-center gap-3 rounded-xl border border-line2 bg-panel2 p-3">
        <FileSpreadsheet className="size-5 shrink-0 text-src" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] text-fg">{cfg.name}</div>
          <div className="text-[11px] text-faint">
            {cfg.format === 'excel' ? 'Excel' : cfg.format?.toUpperCase()} · {fmtBytes(cfg.size)} · copied into the
            workspace
          </div>
        </div>
        <input ref={input} type="file" className="hidden" onChange={(e) => replace(e.target.files?.[0])} />
        <Button onClick={() => input.current?.click()} disabled={busy}>
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          Replace file
        </Button>
      </div>

      {cfg.format === 'excel' && (
        <div className="mt-4">
          <Field label="Sheet">
            <select
              className={inputCls}
              value={cfg.sheet ?? ''}
              onChange={(e) => saveConfig(node.id, { sheet: e.target.value || undefined })}
            >
              <option value="">First sheet{cfg.sheets?.[0] ? ` (${cfg.sheets[0]})` : ''}</option>
              {cfg.sheets?.slice(1).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      <p className="mt-4 flex items-start gap-2 text-[12px] leading-relaxed text-faint">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        DuckDB reads the file locally when you run this node, so it's free. Drop a new version here to replace it;
        downstream transforms will be marked stale.
      </p>
    </div>
  )
}
