import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Braces, HardDrive, PanelLeft, PiggyBank, Settings, Workflow } from 'lucide-react'
import { Button } from '../components/ui'
import { api } from '../lib/api'
import { fmtBytes, fmtUsd } from '../lib/format'
import { useSavings, useWorkspace } from '../lib/queryClient'
import { useUi } from '../lib/store'

/** Lifetime BigQuery spend vs. the scans that free local runs avoided. */
function SavingsMeter() {
  const { data } = useSavings()
  const t = data?.total
  if (!t) return null
  return (
    <div
      className="flex h-7 items-center gap-3 rounded-full border border-line2 bg-panel2 px-3 text-xs"
      title={[
        `Spent on BigQuery: ${fmtBytes(t.spent_bytes)} billed over ${t.bq_runs} run${t.bq_runs === 1 ? '' : 's'}`,
        `Avoided: ${fmtBytes(t.avoided_bytes)} of BigQuery scans over ${t.local_runs} free local run${t.local_runs === 1 ? '' : 's'}`,
        'Avoided = what re-querying the upstream BigQuery sources would have processed each time.',
        t.since ? `Counting since ${new Date(t.since).toLocaleDateString()}` : 'Nothing recorded yet',
      ].join('\n')}
    >
      <PiggyBank className="size-3.5 text-ok" />
      <span className="text-faint">
        Spent <b className="font-medium tabular-nums text-fg">{fmtUsd(t.spent_usd)}</b>
      </span>
      <span className="text-faint">
        Saved <b className="font-medium tabular-nums text-ok">{fmtUsd(t.avoided_usd)}</b>
      </span>
    </div>
  )
}

/** Opens the parameters dialog; flags {{names}} that SQL uses but nothing defines. */
function ParamsButton() {
  const setParamsOpen = useUi((s) => s.setParamsOpen)
  const params = useQuery({ queryKey: ['params'], queryFn: api.params })
  const { data: ws } = useWorkspace()
  const missing = new Set(ws?.nodes.flatMap((n) => n.params_missing)).size
  const defined = params.data?.filter((p) => p.type !== null).length ?? 0
  return (
    <button
      type="button"
      onClick={() => setParamsOpen(true)}
      title={
        missing
          ? `${missing} parameter${missing === 1 ? ' is' : 's are'} used in SQL but not defined`
          : 'Workspace parameters: use {{name}} in Source and Transform SQL'
      }
      className="flex h-7 items-center gap-1.5 rounded-full border border-line2 bg-panel2 px-3 text-xs text-muted transition-colors hover:border-[#3a4052] hover:text-fg"
    >
      <Braces className="size-3.5" />
      <span className="tabular-nums">{defined}</span>
      {missing > 0 && <span className="size-1.5 rounded-full bg-warn" />}
    </button>
  )
}

export function TopBar() {
  const setCacheOpen = useUi((s) => s.setCacheOpen)
  const cache = useQuery({ queryKey: ['cache'], queryFn: api.cache })
  const openSettings = useUi((s) => s.setSettingsOpen)
  const explorerOpen = useUi((s) => s.explorerOpen)
  const toggleExplorer = useUi((s) => s.toggleExplorer)
  const status = useQuery({ queryKey: ['bq-status'], queryFn: api.bqStatus, staleTime: 5 * 60_000 })
  const s = status.data

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-panel px-4">
      <div className="flex items-center gap-2.5">
        <Button
          variant="ghost"
          size="icon"
          className={clsx('-ml-2 size-7', explorerOpen && 'text-fg')}
          onClick={toggleExplorer}
          title={explorerOpen ? 'Hide the BigQuery browser' : 'Show the BigQuery browser'}
        >
          <PanelLeft className="size-4" />
        </Button>
        <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-src/80 shadow-[0_0_20px_-4px_rgba(139,124,255,0.6)]">
          <Workflow className="size-4 text-white" strokeWidth={2.25} />
        </div>
        <span className="text-[14px] font-semibold tracking-tight">Local Data Inspector</span>
        <span className="hidden text-xs text-faint md:inline">BigQuery once · DuckDB forever</span>
      </div>
      <div className="flex items-center gap-1.5">
        <SavingsMeter />
        <ParamsButton />
        <button
          type="button"
          onClick={() => setCacheOpen(true)}
          title="Cache manager: disk usage, pin and clean up"
          className="flex h-7 items-center gap-1.5 rounded-full border border-line2 bg-panel2 px-3 text-xs text-muted transition-colors hover:border-[#3a4052] hover:text-fg"
        >
          <HardDrive className="size-3.5" />
          <span className="tabular-nums">{cache.data ? fmtBytes(cache.data.total_bytes) : '-'}</span>
        </button>
        <button
          type="button"
          onClick={() => openSettings(true)}
          title={
            s?.ok
              ? `BigQuery billing project${s.account ? `\nSigned in as ${s.account}` : ''}`
              : (s?.hint ?? s?.error ?? '')
          }
          className="flex h-7 items-center gap-2 rounded-full border border-line2 bg-panel2 px-3 text-xs transition-colors hover:border-[#3a4052]"
        >
          <span
            className={clsx(
              'size-1.5 rounded-full',
              status.isLoading ? 'animate-ldi-pulse bg-faint' : s?.ok ? 'bg-ok' : 'bg-err',
            )}
          />
          {status.isLoading ? (
            <span className="text-muted">Checking BigQuery...</span>
          ) : s?.ok ? (
            <>
              <span className="font-mono text-muted">{s.project ?? 'no project set'}</span>
              {s.account && <span className="hidden text-faint lg:inline">{s.account}</span>}
            </>
          ) : (
            <span className="text-err">BigQuery not authenticated</span>
          )}
        </button>
        <Button variant="ghost" size="icon" onClick={() => openSettings(true)} title="Settings">
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  )
}
