import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { api } from './api'
import { patchCachedNode, refreshWorkspace } from './queryClient'

// ---- UI state -------------------------------------------------------------

interface UiState {
  selectedId: string | null
  select: (id: string | null) => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}))

// ---- SQL drafts: edits are local first, saved after a short pause --------

const SAVE_DELAY_MS = 600
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const useDrafts = create<{ drafts: Record<string, string> }>(() => ({ drafts: {} }))

export function editDraft(id: string, sql: string) {
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [id]: sql } }))
  clearTimeout(timers.get(id))
  timers.set(
    id,
    setTimeout(() => void flushDraft(id), SAVE_DELAY_MS),
  )
}

export async function flushDraft(id: string): Promise<void> {
  clearTimeout(timers.get(id))
  timers.delete(id)
  const sql = useDrafts.getState().drafts[id]
  if (sql === undefined) return
  try {
    await api.updateNode(id, { sql })
  } catch (e) {
    toast.error('Could not save SQL', { description: (e as Error).message })
    return
  }
  // Put the saved SQL in the cache before dropping the draft, so the editor never flickers back.
  patchCachedNode(id, { sql })
  useDrafts.setState((s) => {
    if (s.drafts[id] !== sql) return s
    const { [id]: _, ...rest } = s.drafts
    return { drafts: rest }
  })
  await refreshWorkspace()
}

// ---- Confirm dialog (promise based) --------------------------------------

export interface ConfirmOptions {
  title: string
  body: ReactNode
  confirmLabel: string
  tone?: 'default' | 'danger'
}

interface ConfirmState {
  request: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
}

export const useConfirm = create<ConfirmState>(() => ({ request: null }))

export const confirmDialog = (opts: ConfirmOptions) =>
  new Promise<boolean>((resolve) => useConfirm.setState({ request: { ...opts, resolve } }))
