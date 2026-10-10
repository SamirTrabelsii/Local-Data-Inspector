import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../components/ui'
import { api, type Column } from '../../lib/api'
import { fmtInt } from '../../lib/format'

const PAGE = 200 // rows per request
const WINDOW = 50_000 // rows per scrollable window (keeps the scroll height well under browser limits)
const ROW_H = 30

const NUMERIC = /^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|FLOAT|DOUBLE|REAL|DECIMAL.*)$/i

function colWidth(c: Column): number {
  const t = c.type.toUpperCase()
  const base = NUMERIC.test(t) ? 120 : t.startsWith('TIMESTAMP') ? 210 : t === 'DATE' ? 120 : t === 'BOOLEAN' ? 96 : 190
  return Math.max(base, Math.min(340, Math.max(c.name.length, c.type.length) * 7.5 + 44))
}

function Cell({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-faint/70 italic">null</span>
  if (typeof v === 'boolean') return <span className={v ? 'text-ok' : 'text-err/80'}>{String(v)}</span>
  if (typeof v === 'object') return <span className="text-muted">{JSON.stringify(v)}</span>
  return <>{String(v)}</>
}

interface Props {
  nodeId: string
  version: string // finished_at of the run; a new run resets the table
  total: number
  columns: Column[]
}

export function ResultsTable({ nodeId, version, total, columns }: Props) {
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null)
  const [win, setWin] = useState(0)
  const key = `${nodeId}|${version}|${sort?.col ?? ''}|${sort?.desc ?? ''}`
  const keyRef = useRef(key)
  const pages = useRef(new Map<number, unknown[][]>())
  const inflight = useRef(new Set<number>())
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const scrollRef = useRef<HTMLDivElement>(null)

  if (keyRef.current !== key) {
    keyRef.current = key
    pages.current = new Map()
    inflight.current = new Set()
  }
  useEffect(() => {
    setWin(0)
  }, [key])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [key, win])

  const windows = Math.max(1, Math.ceil(total / WINDOW))
  const winStart = win * WINDOW
  const winCount = Math.max(0, Math.min(WINDOW, total - winStart))

  const widths = useMemo(() => columns.map(colWidth), [columns])
  const numeric = useMemo(() => columns.map((c) => NUMERIC.test(c.type)), [columns])
  const indexW = Math.max(56, String(total).length * 8 + 28)
  const totalW = indexW + widths.reduce((a, b) => a + b, 0)

  const virt = useVirtualizer({
    count: winCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 15,
  })
  const items = virt.getVirtualItems()
  const firstRow = items.length ? winStart + items[0].index : 0
  const lastRow = items.length ? winStart + items[items.length - 1].index : -1

  useEffect(() => {
    if (lastRow < 0) return
    const requestKey = keyRef.current
    for (let p = Math.floor(firstRow / PAGE); p <= Math.floor(lastRow / PAGE); p++) {
      if (pages.current.has(p) || inflight.current.has(p)) continue
      inflight.current.add(p)
      api
        .results(nodeId, { offset: p * PAGE, limit: PAGE, sort: sort?.col, desc: sort?.desc })
        .then((r) => {
          if (keyRef.current !== requestKey) return
          pages.current.set(p, r.rows)
          rerender()
        })
        .catch((e) => keyRef.current === requestKey && toast.error('Could not load rows', { description: e.message }))
        .finally(() => keyRef.current === requestKey && inflight.current.delete(p))
    }
  }, [firstRow, lastRow, key, nodeId, sort])

  const toggleSort = (col: string) =>
    setSort((s) => (s?.col !== col ? { col, desc: false } : !s.desc ? { col, desc: true } : null))

  const copy = (v: unknown) => {
    const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    navigator.clipboard.writeText(text).then(() => toast.success('Copied to clipboard'))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ width: totalW, minWidth: '100%' }}>
          {/* header */}
          <div className="sticky top-0 z-10 flex border-b border-line2 bg-panel2" style={{ height: 44 }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-panel2" style={{ width: indexW }} />
            {columns.map((c, i) => (
              <button
                key={c.name}
                type="button"
                onClick={() => toggleSort(c.name)}
                className={clsx(
                  'group flex shrink-0 flex-col justify-center border-r border-line px-3 text-left transition-colors hover:bg-panel3',
                  numeric[i] && 'items-end text-right',
                )}
                style={{ width: widths[i] }}
                title={`${c.name} · ${c.type}\nClick to sort`}
              >
                <span className="flex max-w-full items-center gap-1 text-xs font-medium text-fg">
                  <span className="truncate">{c.name}</span>
                  {sort?.col === c.name &&
                    (sort.desc ? (
                      <ArrowDown className="size-3 shrink-0 text-accent" />
                    ) : (
                      <ArrowUp className="size-3 shrink-0 text-accent" />
                    ))}
                </span>
                <span className="max-w-full truncate font-mono text-[10px] uppercase text-faint">{c.type}</span>
              </button>
            ))}
          </div>

          {/* body */}
          <div className="relative" style={{ height: virt.getTotalSize() }}>
            {items.map((item) => {
              const abs = winStart + item.index
              const row = pages.current.get(Math.floor(abs / PAGE))?.[abs % PAGE]
              return (
                <div
                  key={item.key}
                  className="absolute left-0 flex w-full border-b border-line/60 font-mono text-[12px] hover:bg-white/[0.03]"
                  style={{ height: ROW_H, transform: `translateY(${item.start}px)` }}
                >
                  <div
                    className="sticky left-0 flex shrink-0 items-center justify-end border-r border-line bg-panel px-2 text-[11px] tabular-nums text-faint"
                    style={{ width: indexW }}
                  >
                    {fmtInt(abs + 1)}
                  </div>
                  {columns.map((c, i) => (
                    <div
                      key={c.name}
                      className={clsx(
                        'flex shrink-0 items-center overflow-hidden border-r border-line/60 px-3',
                        numeric[i] && 'justify-end tabular-nums',
                      )}
                      style={{ width: widths[i] }}
                      onDoubleClick={row ? () => copy(row[i]) : undefined}
                    >
                      {row ? (
                        <span className="truncate">
                          <Cell v={row[i]} />
                        </span>
                      ) : (
                        <span className="h-2.5 w-2/3 rounded bg-white/[0.04]" />
                      )}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
        {total === 0 && <div className="p-8 text-center text-[13px] text-faint">The query returned no rows.</div>}
      </div>

      {windows > 1 && (
        <div className="flex h-9 shrink-0 items-center justify-between border-t border-line bg-panel2/60 px-3 text-xs text-muted">
          <span className="tabular-nums">
            Rows {fmtInt(winStart + 1)}–{fmtInt(winStart + winCount)} of {fmtInt(total)}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={win === 0} onClick={() => setWin(win - 1)}>
              <ChevronLeft className="size-3.5" /> Prev
            </Button>
            <span className="tabular-nums text-faint">
              {win + 1} / {windows}
            </span>
            <Button variant="ghost" size="sm" disabled={win >= windows - 1} onClick={() => setWin(win + 1)}>
              Next <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
