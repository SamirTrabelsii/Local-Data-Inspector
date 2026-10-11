import { useReactFlow, useStoreApi } from '@xyflow/react'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { api, type WNode } from '../../lib/api'
import { queryForTable } from '../../lib/catalog'
import { refreshWorkspace } from '../../lib/queryClient'
import { useUi } from '../../lib/store'

export const NODE_W = 264
export const NODE_H = 120

type Pos = { x: number; y: number }

/** A free spot for a new node: at `at` (flow coordinates) or the middle of the view, pushed down past overlaps. */
export function usePlaceNode() {
  const rf = useReactFlow()
  const store = useStoreApi()
  return useCallback(
    (at?: Pos): Pos => {
      const { width, height, transform } = store.getState()
      const [tx, ty, zoom] = transform
      let pos = at ?? { x: (width / 2 - tx) / zoom - NODE_W / 2, y: (height / 2 - ty) / zoom - NODE_H / 2 }
      const taken = rf.getNodes().map((n) => n.position)
      while (taken.some((t) => Math.abs(t.x - pos.x) < NODE_W + 20 && Math.abs(t.y - pos.y) < NODE_H + 20)) {
        pos = { ...pos, y: pos.y + NODE_H + 30 }
      }
      return pos
    },
    [rf, store],
  )
}

/** Create, refresh, select. Returns the node, or undefined after showing the error. */
async function create(make: () => Promise<WNode>, what: string): Promise<WNode | undefined> {
  try {
    const node = await make()
    await refreshWorkspace()
    useUi.getState().select(node.id)
    return node
  } catch (e) {
    toast.error(`Could not add ${what}`, { description: (e as Error).message })
  }
}

export function useAddSources() {
  const place = usePlaceNode()
  return {
    /** A direct table read (Storage API, no query job). */
    table: (id: string, at?: Pos) =>
      create(
        () =>
          api.createNode({
            kind: 'source',
            source_type: 'bq_table',
            name_hint: id.split('.').pop(),
            config: { table: id },
            ...place(at),
          }),
        'the table',
      ),
    /** A query source pre-filled with SELECT * FROM the table. */
    query: (id: string, at?: Pos) =>
      create(
        () => api.createNode({ kind: 'source', name_hint: id.split('.').pop(), sql: queryForTable(id), ...place(at) }),
        'the source',
      ),
    /** Upload local files as file sources and run them right away (it's free). */
    files: async (files: File[], at?: Pos) => {
      let pos = at
      for (const file of files) {
        const node = await create(() => api.uploadFile(file, place(pos)), file.name)
        if (!node) continue
        pos = pos && { x: pos.x, y: pos.y + NODE_H + 30 }
        await api.run(node.id).catch((e) => toast.error(`Could not read ${file.name}`, { description: e.message }))
      }
      await refreshWorkspace()
    },
  }
}
