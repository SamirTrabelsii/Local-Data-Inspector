import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { api, type WNode } from './api'
import { cachedNode, patchCachedNode, refreshWorkspace } from './queryClient'

// ---- UI state -------------------------------------------------------------

interface UiState {
  selectedId: string | null
  select: (id: string | null) => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  explorerOpen: boolean
  toggleExplorer: () => void
  /** BigQuery table id shown in the preview dialog. */
  previewTable: string | null
  setPreviewTable: (id: string | null) => void
}

const EXPLORER_KEY = 'ldi.explorerOpen'
const readExplorerOpen = () => {
  try {
    return localStorage.getItem(EXPLORER_KEY) !== '0'
  } catch {
    return true
  }
}

export const useUi = create<UiState>((set, get) => ({
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  explorerOpen: readExplorerOpen(),
  toggleExplorer: () => {
    const explorerOpen = !get().explorerOpen
    try {
      localStorage.setItem(EXPLORER_KEY, explorerOpen ? '1' : '0')
    } catch {
      /* private mode: keep it in memory only */
    }
    set({ explorerOpen })
  },
  previewTable: null,
  setPreviewTable: (previewTable) => set({ previewTable }),
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
  await pendingConfig.get(id)
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

export async function flushAllDrafts(): Promise<void> {
  await Promise.all([...Object.keys(useDrafts.getState().drafts), ...pendingConfig.keys()].map(flushDraft))
}

// ---- Source configs (table / file sources): saved right away, awaited before a run ----

const pendingConfig = new Map<string, Promise<void>>()
const localConfig = new Map<string, WNode['config']>()

/**
 * Merge `patch` into the node's config and save it. Saves for one node run in order, and the workspace is only
 * refetched after the last one, so a slow early save can't bring back an older config.
 */
export function saveConfig(
  id: string,
  patch: Partial<WNode['config']> | ((current: WNode['config']) => Partial<WNode['config']>),
): Promise<void> {
  const current = localConfig.get(id) ?? cachedNode(id)?.config ?? {}
  const config = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
  localConfig.set(id, config)
  patchCachedNode(id, { config })
  const save = (pendingConfig.get(id) ?? Promise.resolve()).then(async () => {
    try {
      await api.updateNode(id, { config })
    } catch (e) {
      toast.error('Could not save', { description: (e as Error).message })
    }
  })
  pendingConfig.set(id, save)
  return save.then(async () => {
    if (pendingConfig.get(id) !== save) return
    pendingConfig.delete(id)
    localConfig.delete(id)
    await refreshWorkspace()
  })
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
