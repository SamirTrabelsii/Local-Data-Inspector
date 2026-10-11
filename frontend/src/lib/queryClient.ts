import { QueryClient, useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api, type WNode, type Workspace } from './api'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

export const wsKey = ['workspace'] as const

/** The workspace polls quickly while anything is running and stays idle otherwise. */
export function useWorkspace() {
  const q = useQuery({
    queryKey: wsKey,
    queryFn: api.workspace,
    refetchInterval: (q) => (q.state.data?.nodes.some((n) => n.status === 'running') ? 700 : false),
  })
  // A run just finished: the savings meter and cache sizes changed with it.
  const running = q.data?.nodes.some((n) => n.status === 'running') ?? false
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: ['savings'] })
      void queryClient.invalidateQueries({ queryKey: ['cache'] })
    }
    wasRunning.current = running
  }, [running])
  return q
}

/** Lifetime BigQuery spend and the scans avoided by free local runs. */
export function useSavings() {
  return useQuery({ queryKey: ['savings'], queryFn: api.savings, staleTime: 30_000 })
}

/** Anything that changes a run or a cache also changes the savings meter and the cache manager. */
export const refreshWorkspace = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: wsKey }),
    queryClient.invalidateQueries({ queryKey: ['savings'] }),
    queryClient.invalidateQueries({ queryKey: ['cache'] }),
  ])

export function patchCachedNode(id: string, patch: Partial<WNode>) {
  queryClient.setQueryData<Workspace>(wsKey, (ws) =>
    ws ? { ...ws, nodes: ws.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) } : ws,
  )
}

export const cachedNode = (id: string) =>
  queryClient.getQueryData<Workspace>(wsKey)?.nodes.find((n) => n.id === id)
