import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ChevronRight,
  Cloud,
  Copy,
  Database,
  Eye,
  FolderKanban,
  LoaderCircle,
  Pin,
  RefreshCw,
  Search,
  Table2,
  View,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../components/ui'
import type { BqField } from '../../lib/api'
import { catalogQueries, refreshCatalog, TABLE_DRAG_TYPE } from '../../lib/catalog'
import { useUi } from '../../lib/store'
import { useAddSources } from '../canvas/placement'

const isTable = (type: string) => type === 'TABLE' || type === 'SNAPSHOT' || type === 'EXTERNAL'

export function Explorer() {
  const projects = useQuery(catalogQueries.projects())
  const [filter, setFilter] = useState('')
  const openSettings = useUi((s) => s.setSettingsOpen)

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <Database className="size-3.5 text-src" />
        <span className="flex-1 text-xs font-semibold tracking-tight">BigQuery</span>
        <Button variant="ghost" size="icon" className="size-7" title="Reload metadata" onClick={() => refreshCatalog()}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <div className="shrink-0 border-b border-line p-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-2 focus-within:border-accent/60">
          <Search className="size-3.5 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter datasets and tables"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-xs">
        {projects.isLoading && <Loading depth={0} />}
        {projects.error && <ErrorRow depth={0} message={projects.error.message} />}
        {projects.data?.projects.map((p) => (
          <ProjectRow key={p} project={p} billing={p === projects.data.billing} filter={filter.trim().toLowerCase()} />
        ))}
        <button
          type="button"
          onClick={() => openSettings(true)}
          className="mt-1 flex w-full items-center gap-1.5 px-3 py-1.5 text-faint transition-colors hover:text-muted"
        >
          <Pin className="size-3" /> Pin another project in Settings
        </button>
      </div>
      <div className="shrink-0 border-t border-line px-3 py-2 text-[11px] leading-snug text-faint">
        Browsing and previews are free. Drag a table onto the canvas or into a query.
      </div>
    </div>
  )
}

function Row({
  depth,
  open,
  onToggle,
  icon,
  children,
  actions,
  draggable,
  onDragStart,
  title,
}: {
  depth: number
  open?: boolean
  onToggle?: () => void
  icon: ReactNode
  children: ReactNode
  actions?: ReactNode
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  title?: string
}) {
  return (
    <div
      className="group flex h-7 items-center gap-1 pr-1 hover:bg-white/[0.03]"
      style={{ paddingLeft: 6 + depth * 14 }}
      draggable={draggable}
      onDragStart={onDragStart}
      title={title}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        disabled={!onToggle}
      >
        <ChevronRight
          className={clsx(
            'size-3 shrink-0 text-faint transition-transform',
            open && 'rotate-90',
            !onToggle && 'invisible',
          )}
        />
        {icon}
        <span className="truncate">{children}</span>
      </button>
      {actions && <div className="hidden shrink-0 items-center group-hover:flex">{actions}</div>}
    </div>
  )
}

const Loading = ({ depth }: { depth: number }) => (
  <div className="flex h-7 items-center gap-1.5 text-faint" style={{ paddingLeft: 24 + depth * 14 }}>
    <LoaderCircle className="size-3 animate-spin" /> Loading...
  </div>
)

const ErrorRow = ({ depth, message }: { depth: number; message: string }) => (
  <div className="py-1 pr-2 text-[11px] leading-snug text-err" style={{ paddingLeft: 24 + depth * 14 }}>
    {message}
  </div>
)

const Empty = ({ depth, children }: { depth: number; children: ReactNode }) => (
  <div className="flex h-7 items-center text-faint" style={{ paddingLeft: 24 + depth * 14 }}>
    {children}
  </div>
)

function ProjectRow({ project, billing, filter }: { project: string; billing: boolean; filter: string }) {
  const [open, setOpen] = useState(billing)
  const datasets = useQuery({ ...catalogQueries.datasets(project), enabled: open })
  const shown = datasets.data?.filter((d) => !filter || d.id.toLowerCase().includes(filter) || filter.includes('.'))
  return (
    <>
      <Row
        depth={0}
        open={open}
        onToggle={() => setOpen(!open)}
        icon={<FolderKanban className="size-3.5 shrink-0 text-muted" />}
        title={billing ? 'Billing project: query jobs and Storage reads are billed here' : 'Pinned project'}
      >
        <span className="font-medium text-fg">{project}</span>
        {billing && <span className="ml-1.5 text-[10px] text-faint">billing</span>}
      </Row>
      {open && datasets.isLoading && <Loading depth={1} />}
      {open && datasets.error && <ErrorRow depth={1} message={datasets.error.message} />}
      {open && shown?.length === 0 && <Empty depth={1}>{filter ? 'No match' : 'No datasets'}</Empty>}
      {open && shown?.map((d) => <DatasetRow key={d.id} project={project} dataset={d.id} filter={filter} />)}
    </>
  )
}

function DatasetRow({ project, dataset, filter }: { project: string; dataset: string; filter: string }) {
  const [open, setOpen] = useState(false)
  const tables = useQuery({ ...catalogQueries.tables(project, dataset), enabled: open })
  // "dataset.tab" filters tables of a matching dataset; a plain word filters dataset names (done by the parent).
  const tableFilter = filter.includes('.') ? filter.split('.').pop()! : ''
  const datasetMatches = !filter.includes('.') || dataset.toLowerCase().includes(filter.split('.')[0])
  if (!datasetMatches) return null
  const shown = tables.data?.filter((t) => !tableFilter || t.id.toLowerCase().includes(tableFilter))
  return (
    <>
      <Row
        depth={1}
        open={open}
        onToggle={() => setOpen(!open)}
        icon={<Database className="size-3.5 shrink-0 text-faint" />}
      >
        {dataset}
      </Row>
      {open && tables.isLoading && <Loading depth={2} />}
      {open && tables.error && <ErrorRow depth={2} message={tables.error.message} />}
      {open && shown?.length === 0 && <Empty depth={2}>{tableFilter ? 'No match' : 'No tables'}</Empty>}
      {open &&
        shown?.map((t) => <TableRow key={t.id} id={`${project}.${dataset}.${t.id}`} name={t.id} type={t.type} />)}
    </>
  )
}

function TableRow({ id, name, type }: { id: string; name: string; type: string }) {
  const [open, setOpen] = useState(false)
  const info = useQuery({ ...catalogQueries.table(id), enabled: open })
  const preview = useUi((s) => s.setPreviewTable)
  const add = useAddSources()
  const icon = isTable(type) ? (
    <Table2 className="size-3.5 shrink-0 text-src/80" />
  ) : (
    <View className="size-3.5 shrink-0 text-trf/80" />
  )
  return (
    <>
      <Row
        depth={2}
        open={open}
        onToggle={() => setOpen(!open)}
        icon={icon}
        title={`${id} · ${type.toLowerCase()}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(TABLE_DRAG_TYPE, id)
          e.dataTransfer.setData('text/plain', `\`${id}\``)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        actions={
          <>
            <IconAction title="Preview rows (free)" onClick={() => preview(id)} icon={Eye} />
            {isTable(type) && (
              <IconAction
                title="Add as a table source: copies it via the Storage API, no query job"
                onClick={() => add.table(id)}
                icon={Table2}
              />
            )}
            <IconAction title="Add as a query source (SELECT * ...)" onClick={() => add.query(id)} icon={Cloud} />
            <IconAction
              title="Copy table id"
              onClick={() => navigator.clipboard.writeText(id).then(() => toast.success('Copied table id'))}
              icon={Copy}
            />
          </>
        }
      >
        {name}
      </Row>
      {open && info.isLoading && <Loading depth={3} />}
      {open && info.error && <ErrorRow depth={3} message={info.error.message} />}
      {open && info.data && <Columns fields={info.data.columns} depth={3} />}
    </>
  )
}

function Columns({ fields, depth }: { fields: BqField[]; depth: number }) {
  return fields.map((f) => (
    <div key={f.name}>
      <div
        className="flex h-6 items-center gap-2 pr-2 font-mono text-[11px]"
        style={{ paddingLeft: 24 + depth * 14 }}
        title={f.description ?? undefined}
      >
        <span className="truncate text-muted">{f.name}</span>
        <span className="ml-auto shrink-0 text-[10px] uppercase text-faint">
          {f.mode === 'REPEATED' ? `${f.type}[]` : f.type}
        </span>
      </div>
      {f.fields && <Columns fields={f.fields} depth={depth + 1} />}
    </div>
  ))
}

function IconAction({ icon: Icon, title, onClick }: { icon: typeof Eye; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-panel3 hover:text-fg"
    >
      <Icon className="size-3.5" />
    </button>
  )
}
