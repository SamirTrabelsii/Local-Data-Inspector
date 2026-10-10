import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog } from '../../components/ui'
import { api, type Settings } from '../../lib/api'
import { catalogKeys } from '../../lib/catalog'
import { queryClient } from '../../lib/queryClient'
import { useUi } from '../../lib/store'

const GIB = 1024 ** 3

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-fg">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  )
}

const inputCls =
  'h-9 w-full rounded-lg border border-line2 bg-panel2 px-3 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/20'

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, enabled: open })
  const status = useQuery({ queryKey: ['bq-status'], queryFn: api.bqStatus, staleTime: 5 * 60_000 })
  const [form, setForm] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [pinned, setPinned] = useState('')

  useEffect(() => {
    if (open && settings.data) {
      setForm(settings.data)
      setPinned(settings.data.bq_pinned_projects.join(', '))
    }
  }, [open, settings.data])

  const save = async () => {
    if (!form) return
    setSaving(true)
    try {
      await api.putSettings({ ...form, bq_pinned_projects: pinned.split(/[\s,]+/).filter(Boolean) })
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all }) // reloads in the background
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        queryClient.invalidateQueries({ queryKey: ['bq-status'] }),
        queryClient.removeQueries({ queryKey: ['dryrun'] }),
      ])
      toast.success('Settings saved')
      setOpen(false)
    } catch (e) {
      toast.error('Could not save settings', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const gb = (k: 'max_bytes_billed' | 'confirm_above_bytes') => (
    <input
      type="number"
      min={0}
      step="any"
      className={inputCls}
      value={form ? +(form[k] / GIB).toFixed(3) : ''}
      onChange={(e) => set(k, Math.round(Number(e.target.value) * GIB))}
    />
  )

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Settings"
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!form || saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5 pb-1">
        <div className="rounded-xl border border-line2 bg-panel2 p-3 text-xs">
          {status.data?.ok ? (
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-ok" />
              <span className="text-fg">
                Authenticated with Application Default Credentials
                {status.data.account && <span className="text-muted"> as {status.data.account}</span>}
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-err" />
                <span className="text-fg">Not authenticated</span>
              </div>
              <div className="text-muted">Run this once in a terminal, then reopen Settings:</div>
              <code className="block rounded-md bg-black/40 px-2 py-1.5 font-mono text-[11px] text-fg">
                gcloud auth application-default login
              </code>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="BigQuery project"
            hint={`Billing project for jobs. Empty = ${status.data?.project ?? 'gcloud default'}`}
          >
            <input
              className={inputCls + ' font-mono'}
              placeholder="my-gcp-project"
              value={form?.bq_project ?? ''}
              onChange={(e) => set('bq_project', e.target.value.trim())}
            />
          </Field>
          <Field label="Location" hint="e.g. EU, US, europe-west1. Empty = auto">
            <input
              className={inputCls + ' font-mono'}
              placeholder="auto"
              value={form?.bq_location ?? ''}
              onChange={(e) => set('bq_location', e.target.value.trim())}
            />
          </Field>
          <div className="col-span-2">
            <Field
              label="Pinned projects"
              hint="Shown in the BigQuery browser next to the billing project. Comma separated."
            >
              <input
                className={inputCls + ' font-mono'}
                placeholder="bigquery-public-data, other-project"
                value={pinned}
                onChange={(e) => setPinned(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Hard cap per query (GiB)" hint="maximum_bytes_billed, enforced by BigQuery">
            {gb('max_bytes_billed')}
          </Field>
          <Field label="Ask before running above (GiB)" hint="Based on the dry-run estimate">
            {gb('confirm_above_bytes')}
          </Field>
          <Field label="Price per TiB (USD)" hint="For cost estimates only">
            <input
              type="number"
              min={0}
              step="0.01"
              className={inputCls}
              value={form?.price_per_tib_usd ?? ''}
              onChange={(e) => set('price_per_tib_usd', Number(e.target.value))}
            />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}
