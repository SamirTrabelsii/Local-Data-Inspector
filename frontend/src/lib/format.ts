import { useEffect, useState } from 'react'

const intFmt = new Intl.NumberFormat('en-US')
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const fmtInt = (n: number) => intFmt.format(n)
export const fmtCompact = (n: number) => (n < 10_000 ? intFmt.format(n) : compactFmt.format(n))

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function fmtUsd(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return '< $0.01'
  return `$${v.toFixed(2)}`
}

export function timeAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Re-renders every `intervalMs` so relative times stay current. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
