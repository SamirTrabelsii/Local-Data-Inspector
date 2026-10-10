import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CircleAlert, Coins, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { fmtBytes, fmtUsd } from '../../lib/format'
import { dryRunKey } from '../../lib/run'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Live, free BigQuery dry run: validates the SQL and estimates bytes and cost while you type. */
export function SourceEstimate({ sql }: { sql: string }) {
  const debounced = useDebounced(sql.trim(), 900)
  const q = useQuery({
    queryKey: dryRunKey(debounced),
    queryFn: ({ signal }) => api.dryRun(debounced, signal),
    enabled: debounced.length > 0,
    retry: false,
    staleTime: 60_000,
  })

  if (!debounced) return <span className="text-faint">Write a query to see its cost estimate</span>
  if (q.isFetching || debounced !== sql.trim())
    return (
      <span className="flex items-center gap-1.5 text-faint">
        <LoaderCircle className="size-3.5 animate-spin" /> Estimating with a dry run...
      </span>
    )
  if (q.error)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-err" title={q.error.message}>
        <CircleAlert className="size-3.5 shrink-0" />
        <span className="truncate">{q.error.message}</span>
      </span>
    )
  if (!q.data) return null
  const d = q.data
  return (
    <span
      className={clsx(
        'flex items-center gap-1.5',
        d.exceeds_cap ? 'text-err' : d.needs_confirm ? 'text-warn' : 'text-muted',
      )}
    >
      {d.exceeds_cap ? <CircleAlert className="size-3.5" /> : <Coins className="size-3.5" />}
      Will process <b className="font-medium">{fmtBytes(d.bytes_processed)}</b>
      <span className="text-faint">(about {fmtUsd(d.estimated_cost_usd)})</span>
      {d.exceeds_cap ? (
        <span>· above your {fmtBytes(d.max_bytes_billed)} cap</span>
      ) : (
        <span className="flex items-center gap-1 text-faint" title="maximum_bytes_billed is enforced on every run">
          <ShieldCheck className="size-3.5" /> cap {fmtBytes(d.max_bytes_billed)}
        </span>
      )}
    </span>
  )
}
