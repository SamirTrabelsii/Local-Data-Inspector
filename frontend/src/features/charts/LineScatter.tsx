import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { ChartData } from '../../lib/api'
import { fmtNum, seriesColor } from '../../lib/palette'
import { useSize } from './useSize'

type XY = Extract<ChartData, { type: 'line' | 'scatter' }>

const AXIS = {
  stroke: '#8f97aa',
  grid: { stroke: '#20242f', width: 1 },
  ticks: { stroke: '#2c3140', width: 1 },
  font: '10px Inter Variable, sans-serif',
}

/** Line and scatter charts on uPlot. Categorical X values are drawn at their index and labelled. */
export function LineScatter({ data }: { data: XY }) {
  const [wrap, { width, height }] = useSize<HTMLDivElement>()
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el || width < 40 || height < 80) return
    const scatter = data.type === 'scatter'
    const labels = data.type === 'line' ? data.labels : null
    const temporal = data.xkind === 'temporal'
    const showLegend = data.series.length > 1 || scatter
    const xAxis: uPlot.Axis = labels
      ? {
          ...AXIS,
          values: (_u, ticks) => ticks.map((t) => (Number.isInteger(t) && labels[t] ? labels[t].slice(0, 14) : '')),
          splits: (_u, _axis, min, max) => {
            const step = Math.max(1, Math.ceil((max - min) / 8))
            return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => Math.ceil(min) + i * step)
          },
        }
      : temporal
        ? AXIS
        : { ...AXIS, values: (_u, ticks) => ticks.map(fmtNum) }

    const opts: uPlot.Options = {
      width,
      height: height - (showLegend ? 28 : 0),
      padding: [8, 12, 0, 0],
      scales: { x: { time: temporal } },
      cursor: { drag: { x: true, y: false }, points: { size: 7 } },
      legend: { show: showLegend, live: true },
      axes: [xAxis, { ...AXIS, size: 56, values: (_u, ticks) => ticks.map(fmtNum) }],
      series: [
        labels ? { value: (_u, v) => (v == null ? '-' : (labels[v] ?? String(v))) } : {},
        ...data.series.map(
          (s, i): uPlot.Series => ({
            label: s.name,
            stroke: seriesColor(i),
            width: 2,
            fill: !scatter && data.series.length === 1 ? `${seriesColor(i)}18` : undefined,
            spanGaps: true,
            points: scatter
              ? { show: true, size: 5, fill: `${seriesColor(i)}aa`, stroke: seriesColor(i) }
              : { show: data.x.length < 60, size: 5 },
            paths: scatter ? () => null : undefined,
            value: (_u, v) => (v == null ? '-' : fmtNum(v)),
          }),
        ),
      ],
    }
    const plot = new uPlot(opts, [data.x, ...data.series.map((s) => s.values)] as uPlot.AlignedData, el)
    return () => plot.destroy()
  }, [data, width, height])

  return (
    <div ref={wrap} className="ldi-uplot h-full min-h-[160px] w-full overflow-hidden">
      <div ref={host} />
    </div>
  )
}
