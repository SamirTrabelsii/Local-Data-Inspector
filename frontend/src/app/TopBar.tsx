import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Settings, Workflow } from 'lucide-react'
import { Button } from '../components/ui'
import { api } from '../lib/api'
import { useUi } from '../lib/store'

export function TopBar() {
  const openSettings = useUi((s) => s.setSettingsOpen)
  const status = useQuery({ queryKey: ['bq-status'], queryFn: api.bqStatus, staleTime: 5 * 60_000 })
  const s = status.data

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-panel px-4">
      <div className="flex items-center gap-2.5">
        <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-src/80 shadow-[0_0_20px_-4px_rgba(139,124,255,0.6)]">
          <Workflow className="size-4 text-white" strokeWidth={2.25} />
        </div>
        <span className="text-[14px] font-semibold tracking-tight">Local Data Inspector</span>
        <span className="hidden text-xs text-faint md:inline">BigQuery once · DuckDB forever</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => openSettings(true)}
          title={s?.ok ? 'BigQuery billing project' : (s?.hint ?? s?.error ?? '')}
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
            <span className="font-mono text-muted">{s.project ?? 'no project set'}</span>
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
