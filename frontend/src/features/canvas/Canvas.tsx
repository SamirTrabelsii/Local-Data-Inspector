import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  type OnBeforeDelete,
  Panel,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react'
import { ChartColumn, Cloud, FileSpreadsheet, Plus, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../components/ui'
import { api, type NodeKind, type Workspace } from '../../lib/api'
import { patchCachedNode, refreshWorkspace, useWorkspace } from '../../lib/queryClient'
import { confirmDialog, useUi } from '../../lib/store'
import { TABLE_DRAG_TYPE } from '../../lib/catalog'
import { defaultChartConfig } from '../charts/ChartPanel'
import { type LdiNode, NodeCard } from './NodeCard'
import { NODE_W, useAddSources, usePlaceNode } from './placement'

const nodeTypes = { ldi: NodeCard }
const FILE_ACCEPT = '.csv,.tsv,.txt,.parquet,.xlsx,.json,.jsonl,.ndjson'

const DEFAULT_SOURCE_SQL = 'SELECT\n  *\nFROM `project.dataset.table`\nLIMIT 1000\n'

const edgeId = (s: string, t: string) => `${s}->${t}`

export function Canvas() {
  const { data } = useWorkspace()
  const selectedId = useUi((s) => s.selectedId)
  const select = useUi((s) => s.select)
  const rf = useReactFlow<LdiNode, Edge>()
  const wrapper = useRef<HTMLDivElement>(null)
  const [nodes, setNodes] = useState<LdiNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const fitted = useRef(false)
  const place = usePlaceNode()
  const addSources = useAddSources()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)

  // Merge server state into React Flow state, keeping local positions and measurements.
  useEffect(() => {
    if (!data) return
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]))
      return data.nodes.map((n) => {
        const p = byId.get(n.id)
        const selected = n.id === selectedId
        return p
          ? { ...p, data: { node: n }, selected }
          : { id: n.id, type: 'ldi' as const, position: { x: n.x, y: n.y }, data: { node: n }, selected }
      })
    })
    const byId = new Map(data.nodes.map((n) => [n.id, n]))
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id))
      return data.edges.map((e) => {
        const target = byId.get(e.target)
        const id = edgeId(e.source, e.target)
        return {
          id,
          source: e.source,
          target: e.target,
          selected: sel.has(id),
          animated: target?.status === 'running',
          className: target?.status === 'running' ? 'edge-running' : target?.stale ? 'edge-stale' : undefined,
        }
      })
    })
  }, [data, selectedId])

  const initialized = useNodesInitialized()
  useEffect(() => {
    if (!fitted.current && initialized) {
      fitted.current = true
      rf.fitView({ padding: 0.35, maxZoom: 1 })
    }
  }, [initialized, rf])

  const onNodesChange = useCallback((changes: NodeChange<LdiNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es))
  }, [])

  const onSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: LdiNode[] }) => {
      if (sel.length === 1) select(sel[0].id)
      else if (sel.length === 0) select(null)
    },
    [select],
  )

  const onNodeDragStop = useCallback((_: unknown, __: LdiNode, dragged: LdiNode[]) => {
    for (const n of dragged) {
      const { x, y } = n.position
      patchCachedNode(n.id, { x, y })
      api.updateNode(n.id, { x, y }).catch((e) => toast.error('Could not save position', { description: e.message }))
    }
  }, [])

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (c.source === c.target) return false
      const nodes = data?.nodes ?? []
      const target = nodes.find((n) => n.id === c.target)
      if (nodes.find((n) => n.id === c.source)?.kind === 'chart') return false
      return target?.kind === 'transform' || (target?.kind === 'chart' && target.input_ids.length === 0)
    },
    [data],
  )

  const onConnect = useCallback(async (c: Connection) => {
    try {
      await api.createEdge(c.source, c.target)
    } catch (e) {
      toast.error('Could not connect', { description: (e as Error).message })
    }
    await refreshWorkspace()
  }, [])

  const onBeforeDelete: OnBeforeDelete<LdiNode, Edge> = useCallback(async ({ nodes: ns, edges: es }) => {
    if (!ns.length) return { nodes: ns, edges: es }
    const ok = await confirmDialog({
      title: ns.length === 1 ? `Delete ${ns[0].data.node.name}?` : `Delete ${ns.length} nodes?`,
      body: 'The node, its connections and its cached results will be removed. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    return ok ? { nodes: ns, edges: es } : false
  }, [])

  const onDelete = useCallback(
    async ({ nodes: ns, edges: es }: { nodes: LdiNode[]; edges: Edge[] }) => {
      const gone = new Set(ns.map((n) => n.id))
      const results = await Promise.allSettled([
        ...ns.map((n) => api.deleteNode(n.id)),
        ...es.filter((e) => !gone.has(e.source) && !gone.has(e.target)).map((e) => api.deleteEdge(e.source, e.target)),
      ])
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) toast.error('Delete failed', { description: failed.reason?.message })
      if (selectedId && gone.has(selectedId)) select(null)
      await refreshWorkspace()
    },
    [select, selectedId],
  )

  const addNode = useCallback(
    async (kind: NodeKind) => {
      const ws = data as Workspace
      const picked = ws.nodes.find((n) => n.id === selectedId)
      const parent = kind !== 'source' && picked?.kind !== 'chart' ? picked : undefined
      const p = parent && (rf.getNode(parent.id)?.position ?? { x: parent.x, y: parent.y })
      const pos = place(p ? { x: p.x + NODE_W + 90, y: p.y } : undefined)
      const sql =
        kind === 'source'
          ? DEFAULT_SOURCE_SQL
          : parent
            ? `SELECT\n  *\nFROM ${parent.name}\nLIMIT 100\n`
            : '-- Connect an input node, then query it by name\nSELECT 42 AS answer\n'
      try {
        const node = await api.createNode({
          kind,
          ...(kind === 'chart' ? { config: defaultChartConfig(parent?.result?.columns ?? []) } : { sql }),
          ...pos,
          inputs: parent ? [parent.id] : [],
        })
        await refreshWorkspace()
        select(node.id)
      } catch (e) {
        toast.error('Could not create node', { description: (e as Error).message })
      }
    },
    [data, rf, select, selectedId, place],
  )

  // Drop local files (file sources) or tables dragged from the BigQuery browser (table sources).
  const accepts = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(TABLE_DRAG_TYPE)
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }, [])
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!wrapper.current?.contains(e.relatedTarget as Node | null)) setDropping(false)
  }, [])
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!accepts(e)) return
      e.preventDefault()
      setDropping(false)
      const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const table = e.dataTransfer.getData(TABLE_DRAG_TYPE)
      if (table) void addSources.table(table, at)
      else void addSources.files([...e.dataTransfer.files], at)
    },
    [rf, addSources],
  )

  const selectedNode = data?.nodes.find((n) => n.id === selectedId)

  return (
    <div
      ref={wrapper}
      className="relative h-full w-full"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ReactFlow<LdiNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onBeforeDelete={onBeforeDelete}
        onDelete={onDelete}
        deleteKeyCode={['Delete', 'Backspace']}
        colorMode="dark"
        minZoom={0.2}
        maxZoom={1.75}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        attributionPosition="top-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#262a36" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(n) => ((n as LdiNode).data.node.kind === 'source' ? '#38bdf8' : (n as LdiNode).data.node.kind === 'chart' ? '#34d399' : '#a78bfa')}
          nodeBorderRadius={6}
          style={{ width: 168, height: 110 }}
          maskColor="rgba(9,10,14,0.65)"
        />
        <Panel position="top-left" className="!m-3">
          <div className="flex items-center gap-1 rounded-xl border border-line2 bg-panel/90 p-1 shadow-xl backdrop-blur">
            <Button variant="ghost" size="sm" onClick={() => addNode('source')} title="Add a BigQuery source">
              <Plus className="size-3.5" />
              <Cloud className="size-3.5 text-src" />
              Source
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInput.current?.click()}
              title="Add a local CSV, Parquet, Excel or JSON file (or drop files on the canvas)"
            >
              <Plus className="size-3.5" />
              <FileSpreadsheet className="size-3.5 text-src" />
              File
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                void addSources.files([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addNode('chart')}
              disabled={!selectedNode || selectedNode.kind === 'chart'}
              title={
                selectedNode && selectedNode.kind !== 'chart'
                  ? `Add a chart of ${selectedNode.name}`
                  : 'Select a source or transform to chart its result'
              }
            >
              <Plus className="size-3.5" />
              <ChartColumn className="size-3.5 text-ok" />
              Chart
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addNode('transform')}
              title={
                selectedNode
                  ? `Add a DuckDB transform fed by ${selectedNode.name}`
                  : 'Add a DuckDB transform (select a node first to wire it automatically)'
              }
            >
              <Plus className="size-3.5" />
              <Sparkles className="size-3.5 text-trf" />
              Transform
              {selectedNode && <span className="font-mono text-[11px] text-faint">from {selectedNode.name}</span>}
            </Button>
          </div>
        </Panel>
      </ReactFlow>

      {data && data.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-line2 bg-panel/90 p-6 text-center shadow-2xl backdrop-blur">
            <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-src/10 text-src ring-1 ring-inset ring-src/25">
              <Cloud className="size-5" />
            </div>
            <h3 className="text-[15px] font-semibold tracking-tight">Start with a BigQuery source</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Query BigQuery once, then cache the result locally. Every transform you chain after it runs on DuckDB for
              free. You can also drag a table from the browser on the left, or drop CSV, Parquet and Excel files here.
            </p>
            <Button variant="primary" className="mt-4" onClick={() => addNode('source')}>
              <Plus className="size-4" />
              New source
            </Button>
          </div>
        </div>
      )}

      {dropping && (
        <div className="pointer-events-none absolute inset-3 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-accent/60 bg-accent/[0.06]">
          <div className="rounded-xl bg-panel/90 px-4 py-2.5 text-[13px] text-fg shadow-xl">
            Drop to add as a source
          </div>
        </div>
      )}
    </div>
  )
}
