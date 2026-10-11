import clsx from 'clsx'
import {
  ArrowRight,
  Braces,
  CircleAlert,
  Cloud,
  FlaskConical,
  FileSpreadsheet,
  GitFork,
  History,
  LoaderCircle,
  MousePointerClick,
  ChartNoAxesColumn,
  Pin,
  PinOff,
  Play,
  Rows3,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { toast } from 'sonner'
import { Button, KindIcon, Kbd, StatusPill, sourceLabel } from '../../components/ui'
import { api, type WNode, type Workspace } from '../../lib/api'
import { refreshWorkspace, useWorkspace } from '../../lib/queryClient'
import { cancelNode, runDownstream, runFull, runNode } from '../../lib/run'
import { confirmDialog, editDraft, flushAllDrafts, useDrafts, useUi } from '../../lib/store'
import { EstimateWarnings, SourceEstimate } from '../editor/SourceEstimate'
import { SqlEditor } from '../editor/SqlEditor'
import { ChartPanel } from '../charts/ChartPanel'
import { HistoryView } from '../insight/HistoryView'
import { ProfileView } from '../insight/ProfileView'
import { ResultsTable } from '../results/ResultsTable'
import { StatsBar } from '../results/StatsBar'
import { SampleControl } from './SampleControl'
import { FileSourceEditor, TableSourceEditor } from './SourceEditors'

type ResultsTab = 'data' | 'profile' | 'history'

const isMac = navigator.platform.toUpperCase().includes('MAC')

export function NodePanel() {
  const { data } = useWorkspace()
  const selectedId = useUi((s) => s.selectedId)
  const node = data?.nodes.find((n) => n.id === selectedId)
  if (!data || !node) return <EmptyPanel />
  return <NodeDetail key={node.id} node={node} ws={data} />
}

function EmptyPanel() {
  return (
    <div className="grid h-full place-items-center bg-panel p-8">
      <div className="max-w-xs text-center">
        <MousePointerClick className="mx-auto mb-3 size-6 text-faint" />
        <div className="text-[14px] font-medium">Select a node</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          Its SQL and results open here. Drag from a node's right handle to a transform to wire it as an input.
        </p>
        <div className="mt-5 space-y-2 text-left text-[12px] text-muted">
          <div className="flex items-center gap-2">
            <Cloud className="size-3.5 text-src" /> <b className="font-medium text-fg">Source</b> runs BigQuery SQL once
            and caches the result
          </div>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="size-3.5 text-src" /> Drop CSV, Parquet or Excel files on the canvas
          </div>
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-trf" /> <b className="font-medium text-fg">Transform</b> runs DuckDB SQL
            on cached inputs, for free
          </div>
        </div>
      </div>
    </div>
  )
}

function descendantsOf(ws: Workspace, id: string): string[] {
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of ws.edges) if (e.source === cur && !out.has(e.target)) (out.add(e.target), stack.push(e.target))
  }
  return [...out]
}

function NodeDetail({ node, ws }: { node: WNode; ws: Workspace }) {
  const draft = useDrafts((s) => s.drafts[node.id])
  const sql = draft ?? node.sql
  const running = node.status === 'running'
  const select = useUi((s) => s.select)

  const downstream = useMemo(() => descendantsOf(ws, node.id), [ws, node.id])
  const staleDownstream = downstream.filter((id) => ws.nodes.find((n) => n.id === id)?.stale).length
  const inputNodes = useMemo(
    () => ws.edges.filter((e) => e.target === node.id).map((e) => ws.nodes.find((n) => n.id === e.source)!),
    [ws, node.id],
  )
  const schema = useMemo(
    () =>
      node.kind === 'transform'
        ? Object.fromEntries(inputNodes.map((n) => [n.name, n.result?.columns.map((c) => c.name) ?? []]))
        : undefined,
    [node.kind, inputNodes],
  )

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${node.name}?`,
      body: 'The node, its connections and its cached results will be removed. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteNode(node.id)
      select(null)
    } catch (e) {
      toast.error('Delete failed', { description: (e as Error).message })
    }
    await refreshWorkspace()
  }

  const togglePin = async () => {
    try {
      await api.pin(node.id, !node.pinned)
    } catch (e) {
      toast.error('Could not change the pin', { description: (e as Error).message })
    }
    await refreshWorkspace()
  }

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <KindIcon kind={node.kind} sourceType={node.source_type} />
        <div className="min-w-32 flex-1">
          <NameInput node={node} hasDownstream={downstream.length > 0} />
          <div className="mt-0.5 truncate text-[11px] text-faint">
            {node.kind === 'chart'
              ? `Chart · draws ${inputNodes[0]?.name ?? 'its input'} locally, free`
              : node.kind === 'transform'
                ? 'DuckDB transform · runs locally, free'
              : node.source_type === 'bq_query'
                ? 'BigQuery source · billed per run'
                : node.source_type === 'bq_table'
                  ? 'BigQuery table · Storage API read, no query job'
                  : `${sourceLabel('file', node.config.format)} · read locally by DuckDB, free`}
          </div>
        </div>
        <StatusPill status={node.status} />
        <div className="flex items-center gap-1.5">
          {node.kind !== 'chart' && downstream.length > 0 && (
            <Button
              onClick={() => runDownstream(node)}
              disabled={running}
              title="Re-run every transform downstream of this node, in order (never re-queries BigQuery)"
            >
              <GitFork className="size-3.5 rotate-90" />
              Run downstream
              {staleDownstream > 0 && (
                <span className="rounded-full bg-warn/15 px-1.5 text-[10px] font-semibold text-warn">
                  {staleDownstream}
                </span>
              )}
            </Button>
          )}
          {node.config.sample_percent && !running && (
            <Button
              onClick={() => runFull(node)}
              title="Turn sampling off and run this source on all of the data"
            >
              <FlaskConical className="size-3.5 text-warn" />
              Run full
            </Button>
          )}
          {node.kind === 'chart' ? null : running ? (
            <Button onClick={() => cancelNode(node)} title="Stop this run (BigQuery job cancel / DuckDB interrupt)">
              <Square className="size-3 fill-current text-err" />
              Cancel
            </Button>
          ) : (
            <Button variant="primary" onClick={() => runNode(node)}>
              <Play className="size-3.5 fill-current" />
              {node.kind === 'source' ? (node.result ? 'Refresh' : 'Run') : 'Run'}
              <Kbd>{isMac ? '⌘' : 'Ctrl'} ↵</Kbd>
            </Button>
          )}
          {node.result && (
            <Button
              variant="ghost"
              size="icon"
              onClick={togglePin}
              className={node.pinned ? 'text-accent' : undefined}
              title={
                node.pinned
                  ? 'Pinned: clean-up never deletes this cache. Click to unpin'
                  : 'Pin this cache so clean-up never deletes it'
              }
            >
              {node.pinned ? <Pin className="size-4 fill-current" /> : <PinOff className="size-4" />}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={remove} disabled={running} title="Delete node">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {node.kind === 'chart' ? (
        <div className="min-h-0 flex-1">
          <ChartPanel
            key={node.id}
            node={node}
            inputColumns={inputNodes[0]?.result?.columns ?? null}
            inputVersion={inputNodes[0]?.result?.finished_at ?? null}
          />
        </div>
      ) : (
      <Group orientation="vertical" className="min-h-0 flex-1">
        <Panel id="editor" defaultSize="40" minSize={110}>
          <div className="flex h-full flex-col">
            {node.kind === 'transform' && (
              <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-4 py-2 text-xs">
                <span className="text-faint">Inputs</span>
                {inputNodes.length === 0 ? (
                  <span className="text-muted">none yet: drag from another node's right handle onto this one</span>
                ) : (
                  inputNodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => select(n.id)}
                      className="inline-flex items-center gap-1 rounded-md bg-panel3 px-1.5 py-0.5 font-mono text-[11px] text-fg ring-1 ring-inset ring-line2 hover:ring-accent/50"
                      title={`Query it as: FROM ${n.name}`}
                    >
                      <span className={clsx('size-1.5 rounded-full', n.kind === 'source' ? 'bg-src' : 'bg-trf')} />
                      {n.name}
                    </button>
                  ))
                )}
                {inputNodes.length > 0 && (
                  <span className="ml-1 flex items-center gap-1 text-faint">
                    <ArrowRight className="size-3" /> usable as tables
                  </span>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {node.source_type === 'bq_table' ? (
                <TableSourceEditor node={node} />
              ) : node.source_type === 'file' ? (
                <FileSourceEditor node={node} />
              ) : (
                <SqlEditor
                  value={sql}
                  onChange={(v) => editDraft(node.id, v)}
                  onRun={() => !running && runNode(node)}
                  dialect={node.kind === 'source' ? 'bigquery' : 'duckdb'}
                  schema={schema}
                />
              )}
            </div>
            {node.source_type === 'bq_query' && (
              <EstimateWarnings sql={sql} samplePercent={node.config.sample_percent} nodeId={node.id} />
            )}
            <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-panel2/50 px-4 text-[11px]">
              <div className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
              {node.source_type === 'bq_query' ? (
                <SourceEstimate sql={sql} samplePercent={node.config.sample_percent} nodeId={node.id} />
              ) : node.source_type === 'bq_table' ? (
                <span className="text-faint">Read with the BigQuery Storage API · no query job, no analysis cost</span>
              ) : node.source_type === 'file' ? (
                <span className="text-faint">Local file · read by DuckDB</span>
              ) : (
                <span className="text-faint">DuckDB SQL · inputs are views over their cached Parquet</span>
              )}
              </div>
              {(node.source_type === 'bq_query' || node.source_type === 'bq_table') && (
                <SampleControl node={node} disabled={running} />
              )}
              <ParamChips node={node} />
              {draft !== undefined && <span className="text-faint">saving...</span>}
            </div>
          </div>
        </Panel>
        <Separator className="h-px" />
        <Panel id="results" minSize={120}>
          <ResultsSection node={node} />
        </Panel>
      </Group>
      )}
    </div>
  )
}

function ParamChips({ node }: { node: WNode }) {
  const setParamsOpen = useUi((s) => s.setParamsOpen)
  if (node.params_used.length === 0) return null
  return (
    <button
      type="button"
      onClick={() => setParamsOpen(true)}
      className={clsx(
        'flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset transition-colors',
        node.params_missing.length
          ? 'bg-warn/10 text-warn ring-warn/30'
          : 'bg-panel3 text-muted ring-line2 hover:text-fg',
      )}
      title={
        node.params_missing.length
          ? `Not defined yet: ${node.params_missing.join(', ')}. Click to define.`
          : 'Parameters used by this SQL. Click to edit their values.'
      }
    >
      <Braces className="size-3" />
      {node.params_used.join(' ')}
    </button>
  )
}

function ResultTabs({ tab, onChange }: { tab: ResultsTab; onChange: (t: ResultsTab) => void }) {
  const tabs: { id: ResultsTab; label: string; icon: typeof Rows3 }[] = [
    { id: 'data', label: 'Data', icon: Rows3 },
    { id: 'profile', label: 'Profile', icon: ChartNoAxesColumn },
    { id: 'history', label: 'History', icon: History },
  ]
  return (
    <div className="flex shrink-0 gap-1 border-b border-line bg-panel px-3 pt-1.5" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            '-mb-px flex h-7 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 text-xs font-medium transition-colors',
            tab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          <t.icon className="size-3.5" />
          {t.label}
        </button>
      ))}
    </div>
  )
}

function ResultsSection({ node }: { node: WNode }) {
  const r = node.result
  const [tab, setTab] = useState<ResultsTab>('data')
  return (
    <div className="flex h-full flex-col">
      {node.status === 'error' && node.error && (
        <div className="flex shrink-0 gap-2 border-b border-err/20 bg-err/[0.07] px-4 py-2.5 text-xs text-err">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <pre className="max-h-28 min-w-0 flex-1 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">
            {node.error}
          </pre>
        </div>
      )}
      {node.status === 'running' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-run/20 bg-run/[0.07] px-4 py-2 text-xs text-run">
          <LoaderCircle className="size-3.5 animate-spin" />
          {node.source_type === 'bq_query'
            ? 'Running on BigQuery and caching locally...'
            : node.source_type === 'bq_table'
              ? 'Reading the table from BigQuery...'
              : 'Running on DuckDB...'}
          {r && <span className="text-run/70">showing the previous result meanwhile</span>}
        </div>
      )}
      {r ? (
        <>
          <StatsBar node={node} />
          <ResultTabs tab={tab} onChange={setTab} />
          <div className="min-h-0 flex-1">
            {tab === 'data' && (
              <ResultsTable nodeId={node.id} version={r.finished_at} total={r.row_count} columns={r.columns} />
            )}
            {tab === 'profile' && <ProfileView nodeId={node.id} version={r.finished_at} />}
            {tab === 'history' && <HistoryView node={node} />}
          </div>
        </>
      ) : (
        node.status !== 'running' && (
          <div className="grid flex-1 place-items-center text-center text-[13px] text-faint">
            <div>
              <Play className="mx-auto mb-2 size-5" />
              Run this node to see its results
            </div>
          </div>
        )
      )}
    </div>
  )
}

function NameInput({ node, hasDownstream }: { node: WNode; hasDownstream: boolean }) {
  const [value, setValue] = useState(node.name)
  /** Renaming rewrites references in direct downstream transforms; confirm when there are any. */
  const commit = async () => {
    const name = value.trim()
    if (name === node.name) return
    try {
      await flushAllDrafts()
      const affected = hasDownstream ? (await api.renamePreview(node.id, name)).affected : []
      if (affected.length) {
        const ok = await confirmDialog({
          title: `Rename ${node.name} to ${name}?`,
          body: (
            <div className="space-y-3">
              <p>These transforms read it by name. Their SQL will be updated:</p>
              <ul className="space-y-1">
                {affected.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span className="font-mono text-fg">{a.name}</span>
                    <span className="text-faint">
                      {a.references} {a.references === 1 ? 'reference' : 'references'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-faint">Strings, comments and column names are left alone. Results stay fresh.</p>
            </div>
          ),
          confirmLabel: 'Rename and update',
        })
        if (!ok) {
          setValue(node.name)
          return
        }
      }
      await api.updateNode(node.id, { name })
      await refreshWorkspace()
      if (affected.length)
        toast.success(`Renamed to ${name}`, { description: `Updated ${affected.map((a) => a.name).join(', ')}` })
    } catch (e) {
      toast.error('Could not rename', { description: (e as Error).message })
      setValue(node.name)
    }
  }
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setValue(node.name)
          requestAnimationFrame(() => e.currentTarget?.blur())
        }
      }}
      spellCheck={false}
      className="-ml-1 w-full rounded-md bg-transparent px-1 font-mono text-[14px] font-semibold text-fg outline-none transition-colors hover:bg-panel3 focus:bg-panel3 focus:ring-1 focus:ring-accent/60"
    />
  )
}
