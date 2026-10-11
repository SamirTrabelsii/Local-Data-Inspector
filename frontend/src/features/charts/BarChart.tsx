import { useState } from 'react'
import type { ChartData } from '../../lib/api'
import { fmtNum, niceTicks, seriesColor } from '../../lib/palette'
import { useSize } from './useSize'

type Bar = Extract<ChartData, { type: 'bar' }>

const M = { top: 12, right: 16, left: 52 }

/** Vertical, grouped bars drawn as SVG: categories on X, one bar per series. */
export function BarChart({ data }: { data: Bar }) {
  const [ref, { width, height }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const all = data.series.flatMap((s) => s.values).filter((v): v is number => v !== null)
  const lo = Math.min(0, ...all)
  const hi = Math.max(0, ...all)
  const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi)
  const yMin = Math.min(lo, ticks[0])
  const yMax = Math.max(hi, ticks[ticks.length - 1])

  const slot = (width - M.left - M.right) / Math.max(1, data.labels.length)
  const rotate = slot < 64
  const longest = Math.max(0, ...data.labels.map((l) => Math.min(l.length, 16)))
  const bottom = (rotate ? Math.min(110, 18 + longest * 5.2) : 28) + (data.series.length > 1 ? 22 : 0)
  const plotH = Math.max(10, height - M.top - bottom)
  const y = (v: number) => M.top + plotH * (1 - (v - yMin) / (yMax - yMin || 1))
  const group = Math.min(slot * 0.78, 56 * data.series.length)
  const barW = group / data.series.length

  return (
    <div ref={ref} className="relative h-full min-h-[160px] w-full">
      {width > 0 && height > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label="Bar chart">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="#20242f" />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-faint text-[10px]">
                {fmtNum(t)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke="#2c3140" />
          {data.labels.map((label, i) => {
            const cx = M.left + slot * (i + 0.5)
            const short = label.length > 16 ? `${label.slice(0, 15)}…` : label
            return (
              <g key={label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect
                  x={M.left + slot * i}
                  y={M.top}
                  width={slot}
                  height={plotH}
                  fill={hover === i ? '#ffffff08' : 'transparent'}
                />
                {data.series.map((s, k) => {
                  const v = s.values[i]
                  if (v === null || v === undefined) return null
                  const x = cx - group / 2 + k * barW
                  return (
                    <rect
                      key={s.name}
                      x={x + 1}
                      width={Math.max(1, barW - 2)}
                      y={Math.min(y(v), y(0))}
                      height={Math.max(1, Math.abs(y(v) - y(0)))}
                      rx={2}
                      fill={label === 'Other' ? '#5d6477' : seriesColor(k)}
                      opacity={hover === null || hover === i ? 1 : 0.55}
                    />
                  )
                })}
                <text
                  x={cx}
                  y={height - bottom + 14}
                  textAnchor={rotate ? 'end' : 'middle'}
                  transform={rotate ? `rotate(-40 ${cx} ${height - bottom + 14})` : undefined}
                  className="fill-muted text-[10px]"
                >
                  {short}
                </text>
              </g>
            )
          })}
        </svg>
      )}
      {data.series.length > 1 && (
        <div className="absolute bottom-0 left-1/2 flex -translate-x-1/2 gap-3 text-[11px] text-muted">
          {data.series.map((s, k) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ background: seriesColor(k) }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-2 right-3 rounded-lg border border-line2 bg-panel2/95 px-2.5 py-1.5 text-[11px] shadow-xl"
          role="tooltip"
        >
          <div className="mb-1 font-mono font-medium text-fg">{data.labels[hover]}</div>
          {data.series.map((s, k) => (
            <div key={s.name} className="flex items-center gap-2 text-muted">
              <span className="size-2 rounded-sm" style={{ background: seriesColor(k) }} />
              {s.name}
              <b className="ml-auto pl-3 font-medium tabular-nums text-fg">
                {s.values[hover] === null ? '-' : fmtNum(s.values[hover] as number)}
              </b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
