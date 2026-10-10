import { QueryClient, useQuery } from '@tanstack/react-query'
import { api, type WNode, type Workspace } from './api'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

export const wsKey = ['workspace'] as const

/** The workspace polls quickly while anything is running and stays idle otherwise. */
export function useWorkspace() {
  return useQuery({
    queryKey: wsKey,
    queryFn: api.workspace,
    refetchInterval: (q) => (q.state.data?.nodes.some((n) => n.status === 'running') ? 700 : false),
  })
}

export const refreshWorkspace = () => queryClient.invalidateQueries({ queryKey: wsKey })

export function patchCachedNode(id: string, patch: Partial<WNode>) {
  queryClient.setQueryData<Workspace>(wsKey, (ws) =>
    ws ? { ...ws, nodes: ws.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) } : ws,
  )
}

export const cachedNode = (id: string) =>
  queryClient.getQueryData<Workspace>(wsKey)?.nodes.find((n) => n.id === id)
