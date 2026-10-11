import clsx from 'clsx'
import { FlaskConical } from 'lucide-react'
import type { WNode } from '../../lib/api'
import { saveConfig } from '../../lib/store'

const PRESETS = [1, 5, 10, 25]

/** Sample-first mode: develop against a TABLESAMPLE of the data, then promote to a full run. */
export function SampleControl({ node, disabled }: { node: WNode; disabled: boolean }) {
  const current = node.config.sample_percent
  const set = (percent: number | undefined) => saveConfig(node.id, { sample_percent: percent })
  return (
    <div
      className="flex shrink-0 items-center gap-1 text-[11px]"
      title="Read only a random sample of the table(s) while you build. Run the node in full when you're happy."
    >
      <FlaskConical className={clsx('size-3.5', current ? 'text-warn' : 'text-faint')} />
      <span className="text-faint">Sample</span>
      {[undefined, ...PRESETS].map((p) => (
        <button
          key={p ?? 'full'}
          type="button"
          disabled={disabled}
          onClick={() => set(p)}
          className={clsx(
            'rounded px-1.5 py-px font-medium tabular-nums transition-colors disabled:opacity-50',
            current === p || (current === undefined && p === undefined)
              ? 'bg-accent/20 text-fg ring-1 ring-inset ring-accent/40'
              : 'text-muted hover:bg-panel3 hover:text-fg',
          )}
        >
          {p === undefined ? 'Full' : `${p}%`}
        </button>
      ))}
    </div>
  )
}
