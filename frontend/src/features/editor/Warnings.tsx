import { TriangleAlert } from 'lucide-react'
import type { CostWarning } from '../../lib/api'

/** Cost warnings from the dry run: informative only, they never block a run. */
export function WarningList({ warnings }: { warnings: CostWarning[] }) {
  if (!warnings.length) return null
  return (
    <ul className="space-y-1.5">
      {warnings.map((w) => (
        <li key={`${w.code}:${w.table ?? ''}`} className="flex items-start gap-2 text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 text-[12px] leading-snug">{w.message}</span>
        </li>
      ))}
    </ul>
  )
}
