import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CircleAlert, Cloud, Copy, LoaderCircle, Table2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog } from '../../components/ui'
import { api, type BqField } from '../../lib/api'
import { catalogQueries } from '../../lib/catalog'
import { fmtBytes, fmtDateTime, fmtInt } from '../../lib/format'
import { useUi } from '../../lib/store'
import { useAddSources } from '../canvas/placement'

const PREVIEW_ROWS = 100

/** Table metadata, schema and the first rows, all free (no query job). */
export function TablePreview() {
  const id = useUi((s) => s.previewTable)
  const close = useUi((s) => s.setPreviewTable)
  return id ? <PreviewDialog key={id} id={id} onClose={() => close(null)} /> : null
}

function PreviewDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [tab, setTab] = useState<'rows' | 'schema'>('rows')
  const info = useQuery(catalogQueries.table(id))
  const readable = info.data ? ['TABLE', 'SNAPSHOT', 'EXTERNAL'].includes(info.data.type) : true
  const rows = useQuery({
    queryKey: ['bq-preview', id],
    queryFn: () => api.bqPreview(id, PREVIEW_ROWS),
    enabled: readable && tab === 'rows',
    staleTime: 60_000,
    retry: false,
  })
  const add = useAddSources()
  const d = info.data

  return (
    <Dialog
      open
      onClose={onClose}
      width={980}
      title={<span className="font-mono text-[14px]">{id}</span>}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => navigator.clipboard.writeText(id).then(() => toast.success('Copied table id'))}
          >
            <Copy className="size-3.5" /> Copy id
          </Button>
          <span className="flex-1" />
          <Button onClick={() => add.query(id).then((n) => n && onClose())}>
            <Cloud className="size-3.5 text-src" /> Add as query source
          </Button>
          {readable && (
            <Button variant="primary" onClick={() => add.table(id).then((n) => n && onClose())}>
              <Table2 className="size-3.5" /> Add as table source
            </Button>
          )}
        </>
      }
    >
      {info.isLoading && <Spinner label="Loading table metadata..." />}
      {info.error && <Problem message={info.error.message} />}
      {d && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <Meta label="Type">{d.type.toLowerCase()}</Meta>
            {d.num_rows != null && <Meta label="Rows">{fmtInt(d.num_rows)}</Meta>}
            {d.num_bytes != null && <Meta label="Size">{fmtBytes(d.num_bytes)}</Meta>}
            {d.location && <Meta label="Location">{d.location}</Meta>}
            {d.partitioning && (
              <Meta label="Partitioned">
                {d.partitioning.type.toLowerCase()} on {d.partitioning.field ?? '_PARTITIONTIME'}
              </Meta>
            )}
            {d.clustering && <Meta label="Clustered">{d.clustering.join(', ')}</Meta>}
            {d.modified && <Meta label="Modified">{fmtDateTime(d.modified)}</Meta>}
          </div>
          {d.description && <p className="text-xs text-muted">{d.description}</p>}
          <div className="flex gap-1 border-b border-line">
            {(['rows', 'schema'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={clsx(
                  '-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors',
                  tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {t === 'rows' ? `Preview (first ${PREVIEW_ROWS} rows, free)` : `Schema (${d.columns.length})`}
              </button>
            ))}
          </div>
          <div className="h-[52vh] overflow-auto rounded-lg border border-line">
            {tab === 'schema' ? (
              <Schema fields={d.columns} />
            ) : !readable ? (
              <div className="grid h-full place-items-center p-6 text-center text-xs text-muted">
                Views can't be previewed without running a query. Add it as a query source instead.
              </div>
            ) : rows.isLoading ? (
              <Spinner label="Reading the first rows..." />
            ) : rows.error ? (
              <Problem message={rows.error.message} />
            ) : rows.data ? (
              <PreviewGrid columns={rows.data.columns} rows={rows.data.rows} />
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  )
}

const Meta = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <span>
    <span className="text-faint">{label}</span> <span className="text-fg">{children}</span>
  </span>
)

const Spinner = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 p-4 text-xs text-faint">
    <LoaderCircle className="size-3.5 animate-spin" /> {label}
  </div>
)

const Problem = ({ message }: { message: string }) => (
  <div className="flex gap-2 p-4 text-xs text-err">
    <CircleAlert className="mt-px size-3.5 shrink-0" />
    <span className="whitespace-pre-wrap font-mono">{message}</span>
  </div>
)

function cell(v: unknown) {
  if (v === null || v === undefined) return <span className="italic text-faint/70">null</span>
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

function PreviewGrid({ columns, rows }: { columns: { name: string; type: string }[]; rows: unknown[][] }) {
  if (!rows.length) return <div className="p-6 text-center text-xs text-faint">The table is empty.</div>
  return (
    <table className="w-max min-w-full border-collapse font-mono text-[12px]">
      <thead className="sticky top-0 bg-panel2">
        <tr>
          {columns.map((c) => (
            <th key={c.name} className="border-r border-b border-line2 px-3 py-1.5 text-left font-medium">
              <div className="text-fg">{c.name}</div>
              <div className="text-[10px] font-normal uppercase text-faint">{c.type}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-white/[0.03]">
            {r.map((v, j) => (
              <td key={j} className="max-w-80 truncate border-r border-b border-line/60 px-3 py-1 text-fg">
                {cell(v)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Schema({ fields, depth = 0 }: { fields: BqField[]; depth?: number }) {
  const rows = (fs: BqField[], d: number): React.ReactNode[] =>
    fs.flatMap((f) => [
      <tr key={`${d}-${f.name}`} className="border-b border-line/60">
        <td className="px-3 py-1 font-mono text-fg" style={{ paddingLeft: 12 + d * 16 }}>
          {f.name}
        </td>
        <td className="px-3 py-1 font-mono text-[11px] uppercase text-muted">{f.type}</td>
        <td className="px-3 py-1 text-[11px] text-faint">{f.mode}</td>
        <td className="px-3 py-1 text-[11px] text-muted">{f.description}</td>
      </tr>,
      ...(f.fields ? rows(f.fields, d + 1) : []),
    ])
  return (
    <table className="w-full border-collapse text-xs">
      <tbody>{rows(fields, depth)}</tbody>
    </table>
  )
}
