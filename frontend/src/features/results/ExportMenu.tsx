import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ClipboardCopy, CloudUpload, Download, FileDown, FileSpreadsheet, Share } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog, Menu } from '../../components/ui'
import { api, type ExportFormat, type PushMode, type WNode } from '../../lib/api'
import { catalogQueries } from '../../lib/catalog'
import { fmtInt } from '../../lib/format'

const CLIPBOARD_ROWS = 10_000
const EXCEL_MAX_ROWS = 1_048_575
const PUSH_DATASET_KEY = 'ldi.pushDataset'

function download(node: WNode, format: ExportFormat) {
  if (format === 'xlsx' && node.result!.row_count > EXCEL_MAX_ROWS) {
    toast.error('Too many rows for Excel', {
      description: `Excel holds ${fmtInt(EXCEL_MAX_ROWS)} rows. Use CSV or Parquet.`,
    })
    return
  }
  const a = document.createElement('a')
  a.href = api.exportUrl(node.id, format)
  a.download = `${node.name}.${format}`
  a.click()
}

async function copyToClipboard(node: WNode) {
  try {
    const text = api.exportTsv(node.id, CLIPBOARD_ROWS)
    if (typeof ClipboardItem !== 'undefined') {
      // Hand the clipboard a pending blob right away, so the click still counts as the user gesture (Safari).
      const blob = text.then((t) => new Blob([t], { type: 'text/plain' }))
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
    } else {
      await navigator.clipboard.writeText(await text)
    }
    const total = node.result!.row_count
    if (total > CLIPBOARD_ROWS)
      toast.success(`Copied the first ${fmtInt(CLIPBOARD_ROWS)} of ${fmtInt(total)} rows`, {
        description: 'Download the full result as CSV or Parquet instead.',
      })
    else toast.success(`Copied ${fmtInt(total)} rows`, { description: 'Tab-separated: paste into Excel or Sheets.' })
  } catch (e) {
    toast.error('Could not copy', { description: (e as Error).message })
  }
}

export function ExportMenu({ node }: { node: WNode }) {
  const [pushing, setPushing] = useState(false)
  return (
    <>
      <Menu
        title="Export this result"
        trigger={
          <>
            <Share className="size-3.5" /> Export
          </>
        }
        items={[
          { label: 'Download CSV', icon: FileDown, onSelect: () => download(node, 'csv') },
          { label: 'Download Parquet', icon: Download, onSelect: () => download(node, 'parquet') },
          { label: 'Download Excel', icon: FileSpreadsheet, onSelect: () => download(node, 'xlsx') },
          'separator',
          {
            label: 'Copy to clipboard',
            hint: node.result!.row_count > CLIPBOARD_ROWS ? `first ${fmtInt(CLIPBOARD_ROWS)}` : undefined,
            icon: ClipboardCopy,
            onSelect: () => copyToClipboard(node),
          },
          { label: 'Push to BigQuery...', icon: CloudUpload, onSelect: () => setPushing(true) },
        ]}
      />
      {pushing && <PushDialog node={node} onClose={() => setPushing(false)} />}
    </>
  )
}

const MODES: { mode: PushMode; label: string; hint: string }[] = [
  { mode: 'create', label: 'Create', hint: 'Fails if the table already has data' },
  { mode: 'overwrite', label: 'Overwrite', hint: 'Replaces the table contents' },
  { mode: 'append', label: 'Append', hint: 'Adds rows to the table' },
]

function readDataset(): string | null {
  try {
    return localStorage.getItem(PUSH_DATASET_KEY)
  } catch {
    return null
  }
}

function PushDialog({ node, onClose }: { node: WNode; onClose: () => void }) {
  const projects = useQuery(catalogQueries.projects())
  const dataset = readDataset() ?? (projects.data?.billing ? `${projects.data.billing}.my_dataset` : 'project.dataset')
  const [table, setTable] = useState(`${dataset}.${node.name}`)
  const [mode, setMode] = useState<PushMode>('create')
  const [busy, setBusy] = useState(false)

  const push = async () => {
    setBusy(true)
    try {
      const res = await api.push(node.id, table.trim(), mode)
      try {
        localStorage.setItem(PUSH_DATASET_KEY, res.table.split('.').slice(0, 2).join('.'))
      } catch {
        /* remembering the dataset is a convenience only */
      }
      toast.success(`Pushed ${fmtInt(res.rows)} rows`, { description: res.table })
      onClose()
    } catch (e) {
      toast.error('Push failed', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Push to BigQuery"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={push} disabled={busy || table.trim().split('.').length !== 3}>
            <CloudUpload className="size-3.5" />
            {busy ? 'Pushing...' : `Push ${fmtInt(node.result!.row_count)} rows`}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-1">
        <p>
          Loads the cached result of <b className="font-mono text-fg">{node.name}</b> into a BigQuery table with a load
          job (free). This writes to BigQuery.
        </p>
        <label className="block">
          <span className="text-xs font-medium text-fg">Destination table</span>
          <input
            autoFocus
            className="mt-1.5 h-9 w-full rounded-lg border border-line2 bg-panel2 px-3 font-mono text-[13px] text-fg outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            spellCheck={false}
          />
          <span className="mt-1 block text-[11px] text-faint">project.dataset.table. The dataset must exist.</span>
        </label>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              onClick={() => setMode(m.mode)}
              className={clsx(
                'rounded-lg border p-2.5 text-left transition-colors',
                mode === m.mode ? 'border-accent/70 bg-accent/10' : 'border-line2 hover:border-[#3a4052]',
              )}
            >
              <div
                className={clsx(
                  'text-xs font-medium',
                  m.mode === 'overwrite' && mode === m.mode ? 'text-warn' : 'text-fg',
                )}
              >
                {m.label}
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-faint">{m.hint}</div>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
