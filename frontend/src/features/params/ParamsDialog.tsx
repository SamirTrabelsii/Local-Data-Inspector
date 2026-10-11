import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog } from '../../components/ui'
import { api, type Param, type ParamType } from '../../lib/api'
import { queryClient, refreshWorkspace } from '../../lib/queryClient'
import { useUi } from '../../lib/store'

const TYPES: ParamType[] = ['string', 'number', 'date', 'bool']
const input =
  'h-8 min-w-0 rounded-lg border border-line2 bg-panel3 px-2 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent/60'

async function save(name: string, type: ParamType, value: string): Promise<boolean> {
  try {
    await api.putParam(name, type, value)
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['params'] }), refreshWorkspace()])
    return true
  } catch (e) {
    toast.error(`Could not save {{${name}}}`, { description: (e as Error).message })
    return false
  }
}

function ValueInput({
  type,
  value,
  onChange,
  onCommit,
}: {
  type: ParamType
  value: string
  onChange: (v: string) => void
  onCommit: (v: string) => void
}) {
  if (type === 'bool')
    return (
      <select
        value={value || 'true'}
        onChange={(e) => {
          onChange(e.target.value)
          onCommit(e.target.value)
        }}
        className={input}
      >
        <option>true</option>
        <option>false</option>
      </select>
    )
  return (
    <input
      type={type === 'date' ? 'date' : 'text'}
      inputMode={type === 'number' ? 'decimal' : undefined}
      value={value}
      placeholder={type === 'number' ? '0' : type === 'date' ? 'YYYY-MM-DD' : 'value'}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={input}
      spellCheck={false}
    />
  )
}

function ParamRow({ p }: { p: Param }) {
  const [type, setType] = useState<ParamType>(p.type ?? 'string')
  const [value, setValue] = useState(p.value ?? '')
  const defined = p.type !== null
  const commit = async (t: ParamType, v: string) => {
    if (defined && t === p.type && v === p.value) return
    if (!(await save(p.name, t, v))) {
      setType(p.type ?? 'string')
      setValue(p.value ?? '')
    }
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_92px_minmax(0,1.2fr)_32px] items-center gap-2 border-b border-line py-2">
      <div className="min-w-0">
        <div className="truncate font-mono text-[12.5px] text-fg">{`{{${p.name}}}`}</div>
        <div className="truncate text-[11px] text-faint">
          {p.used_by.length ? `used by ${p.used_by.join(', ')}` : 'not used yet'}
        </div>
      </div>
      <select
        value={type}
        onChange={(e) => {
          const t = e.target.value as ParamType
          setType(t)
          if (defined) void commit(t, value)
        }}
        className={input}
        aria-label={`Type of ${p.name}`}
      >
        {TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <ValueInput type={type} value={value} onChange={setValue} onCommit={(v) => commit(type, v)} />
      {defined ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          title="Delete this parameter"
          onClick={async () => {
            await api.deleteParam(p.name)
            await Promise.all([queryClient.invalidateQueries({ queryKey: ['params'] }), refreshWorkspace()])
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      ) : (
        <span className="text-center text-[10px] font-medium text-warn" title="Used in SQL but not defined: runs will fail">
          undefined
        </span>
      )}
    </div>
  )
}

function AddRow() {
  const [name, setName] = useState('')
  const [type, setType] = useState<ParamType>('string')
  const [value, setValue] = useState('')
  const add = async () => {
    if (!name.trim()) return
    if (await save(name.trim(), type, value)) {
      setName('')
      setValue('')
    }
  }
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)_92px_minmax(0,1.2fr)_32px] items-center gap-2 pt-3"
      onSubmit={(e) => {
        e.preventDefault()
        void add()
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new_name" className={input} spellCheck={false} aria-label="New parameter name" />
      <select value={type} onChange={(e) => setType(e.target.value as ParamType)} className={input} aria-label="New parameter type">
        {TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <ValueInput type={type} value={value} onChange={setValue} onCommit={() => {}} />
      <Button type="submit" variant="primary" size="icon" className="size-8" title="Add parameter" disabled={!name.trim()}>
        <Plus className="size-4" />
      </Button>
    </form>
  )
}

export function ParamsDialog() {
  const open = useUi((s) => s.paramsOpen)
  const setOpen = useUi((s) => s.setParamsOpen)
  const params = useQuery({ queryKey: ['params'], queryFn: api.params, enabled: open })
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Parameters" width={620}>
      <p className="mb-2">
        Write <code className="rounded bg-panel3 px-1 font-mono text-fg">{'{{name}}'}</code> in Source or Transform SQL.
        Changing a value marks only the nodes that use it as stale.
      </p>
      <p className="mb-3 text-[12px] text-faint">
        BigQuery sources bind values as typed query parameters, so write <code className="font-mono">d &gt;= {'{{start}}'}</code>{' '}
        without quotes.
      </p>
      <div className="max-h-[50vh] overflow-auto">
        {params.data?.length === 0 && <div className="py-4 text-center text-faint">No parameters yet</div>}
        {params.data?.map((p) => (
          <ParamRow key={`${p.name}:${p.type}:${p.value}`} p={p} />
        ))}
      </div>
      <AddRow />
    </Dialog>
  )
}
