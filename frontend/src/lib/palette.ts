/** Categorical series colors, tuned for the dark panels. */
export const SERIES_COLORS = ['#8b7cff', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#fb923c', '#a3e635', '#22d3ee']
export const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length]

/** 1-2-5 ticks from 0-based or signed ranges. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min]
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

export function fmtNum(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${+(v / 1e9).toPrecision(3)}B`
  if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)}M`
  if (a >= 1e4) return `${+(v / 1e3).toPrecision(3)}k`
  if (Number.isInteger(v)) return String(v)
  return String(+v.toPrecision(4))
}
