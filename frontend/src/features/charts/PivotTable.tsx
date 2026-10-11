import type { ChartData } from '../../lib/api'
import { fmtNum } from '../../lib/palette'

type Pivot = Extract<ChartData, { type: 'pivot' }>

/** Rows x columns of aggregated values, shaded by magnitude. */
export function PivotTable({ data }: { data: Pivot }) {
  const max = Math.max(1e-9, ...data.cells.flat().map((v) => (v === null ? 0 : Math.abs(v))))
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-[12px]">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 border-b border-r border-line2 bg-panel2 px-3 py-2 text-left font-medium text-muted">
              {data.rows_label}
              {data.cols_label && <span className="text-faint"> / {data.cols_label}</span>}
            </th>
            {data.col_labels.map((c) => (
              <th
                key={c}
                className="sticky top-0 z-10 whitespace-nowrap border-b border-line2 bg-panel2 px-3 py-2 text-right font-mono font-medium text-fg"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.row_labels.map((r, i) => (
            <tr key={r}>
              <th className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-panel px-3 py-1.5 text-left font-mono font-medium text-fg">
                {r}
              </th>
              {data.cells[i].map((v, j) => (
                <td
                  key={data.col_labels[j]}
                  className="whitespace-nowrap border-b border-line px-3 py-1.5 text-right font-mono tabular-nums text-fg"
                  style={{
                    background:
                      v === null ? undefined : `rgb(139 124 255 / ${(0.04 + 0.4 * (Math.abs(v) / max)).toFixed(3)})`,
                  }}
                >
                  {v === null ? <span className="text-faint/60">-</span> : fmtNum(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
