import clsx from 'clsx'
import { ArrowRight, Cloud, CircleAlert, GitFork, LoaderCircle, MousePointerClick, Play, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { toast } from 'sonner'
import { Button, KindIcon, Kbd, StatusPill } from '../../components/ui'
import { api, type WNode, type Workspace } from '../../lib/api'
import { refreshWorkspace, useWorkspace } from '../../lib/queryClient'
import { runDownstream, runNode } from '../../lib/run'
import { confirmDialog, editDraft, useDrafts, useUi } from '../../lib/store'
import { SourceEstimate } from '../editor/SourceEstimate'
import { SqlEditor } from '../editor/SqlEditor'
import { ResultsTable } from '../results/ResultsTable'
import { StatsBar } from '../results/StatsBar'

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
            <Sparkles className="size-3.5 text-trf" /> <b className="font-medium text-fg">Transform</b> runs DuckDB SQL on
            cached inputs, for free
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
    for (const e of ws.edges) if (e.source === cur && !out.has(e.target)) out.add(e.target), stack.push(e.target)
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

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <KindIcon kind={node.kind} />
        <div className="min-w-0 flex-1">
          <NameInput node={node} hasDownstream={downstream.length > 0} />
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
            {node.kind === 'source' ? 'BigQuery source · billed per run' : 'DuckDB transform · runs locally, free'}
          </div>
        </div>
        <StatusPill status={node.status} />
        <div className="flex items-center gap-1.5">
          {downstream.length > 0 && (
            <Button
              onClick={() => runDownstream(node)}
              disabled={running}
              title="Re-run every transform downstream of this node, in order (never re-queries BigQuery)"
            >
              <GitFork className="size-3.5 rotate-90" />
              Run downstream
              {staleDownstream > 0 && (
                <span className="rounded-full bg-warn/15 px-1.5 text-[10px] font-semibold text-warn">{staleDownstream}</span>
              )}
            </Button>
          )}
          <Button variant="primary" onClick={() => runNode(node)} disabled={running}>
            {running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />}
            {node.kind === 'source' ? (node.result ? 'Refresh' : 'Run') : 'Run'}
            <Kbd>{isMac ? '⌘' : 'Ctrl'} ↵</Kbd>
          </Button>
          <Button variant="ghost" size="icon" onClick={remove} disabled={running} title="Delete node">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <Group orientation="vertical" className="min-h-0 flex-1">
        <Panel defaultSize="40" minSize={110}>
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
              <SqlEditor
                value={sql}
                onChange={(v) => editDraft(node.id, v)}
                onRun={() => !running && runNode(node)}
                dialect={node.kind === 'source' ? 'bigquery' : 'duckdb'}
                schema={schema}
              />
            </div>
            <div className="flex h-8 shrink-0 items-center border-t border-line bg-panel2/50 px-4 text-[11px]">
              {node.kind === 'source' ? (
                <SourceEstimate sql={sql} />
              ) : (
                <span className="text-faint">DuckDB SQL · inputs are views over their cached Parquet</span>
              )}
              {draft !== undefined && <span className="ml-auto pl-3 text-faint">saving...</span>}
            </div>
          </div>
        </Panel>
        <Separator className="h-px" />
        <Panel minSize={120}>
          <ResultsSection node={node} />
        </Panel>
      </Group>
    </div>
  )
}

function ResultsSection({ node }: { node: WNode }) {
  const r = node.result
  return (
    <div className="flex h-full flex-col">
      {node.status === 'error' && node.error && (
        <div className="flex shrink-0 gap-2 border-b border-err/20 bg-err/[0.07] px-4 py-2.5 text-xs text-err">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <pre className="max-h-28 min-w-0 flex-1 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">{node.error}</pre>
        </div>
      )}
      {node.status === 'running' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-run/20 bg-run/[0.07] px-4 py-2 text-xs text-run">
          <LoaderCircle className="size-3.5 animate-spin" />
          {node.kind === 'source' ? 'Running on BigQuery and caching locally...' : 'Running on DuckDB...'}
          {r && <span className="text-run/70">showing the previous result meanwhile</span>}
        </div>
      )}
      {r ? (
        <>
          <StatsBar node={node} />
          <div className="min-h-0 flex-1">
            <ResultsTable nodeId={node.id} version={r.finished_at} total={r.row_count} columns={r.columns} />
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
  const commit = async () => {
    const name = value.trim()
    if (name === node.name) return
    try {
      await api.updateNode(node.id, { name })
      await refreshWorkspace()
      if (hasDownstream)
        toast.warning(`Renamed to ${name}`, {
          description: `Downstream SQL that reads FROM ${node.name} needs to be updated.`,
        })
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
