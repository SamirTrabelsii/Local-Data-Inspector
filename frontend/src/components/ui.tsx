import clsx from 'clsx'
import { Cloud, FileSpreadsheet, type LucideIcon, Sparkles, Table2, X } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { NodeKind, NodeStatus, SourceType } from '../lib/api'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-white hover:bg-[#9b8eff] shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.4)]',
  secondary: 'bg-panel3 text-fg border border-line2 hover:bg-[#232837] hover:border-[#3a4052]',
  ghost: 'text-muted hover:text-fg hover:bg-panel3',
  danger: 'text-err hover:bg-err/10',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>
  variant?: Variant
  size?: 'sm' | 'md' | 'icon'
}) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-45',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'icon' && 'size-8',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}

export const Kbd = ({ children, className }: { children: ReactNode; className?: string }) => (
  <kbd
    className={clsx(
      'rounded border border-white/15 bg-white/10 px-1 font-sans text-[10px] font-medium leading-4 opacity-80',
      className,
    )}
  >
    {children}
  </kbd>
)

const sourceIcons: Record<SourceType, LucideIcon> = { bq_query: Cloud, bq_table: Table2, file: FileSpreadsheet }

export const sourceLabel = (t: SourceType | null, format?: string) =>
  t === 'bq_table'
    ? 'BigQuery table'
    : t === 'file'
      ? `${format === 'excel' ? 'Excel' : (format ?? '').toUpperCase()} file`
      : 'BigQuery source'

export function KindIcon({
  kind,
  sourceType,
  size = 'md',
}: {
  kind: NodeKind
  sourceType?: SourceType | null
  size?: 'sm' | 'md'
}) {
  const Icon = kind === 'source' ? sourceIcons[sourceType ?? 'bq_query'] : Sparkles
  return (
    <div
      className={clsx(
        'grid shrink-0 place-items-center rounded-lg ring-1 ring-inset',
        size === 'md' ? 'size-8' : 'size-6',
        kind === 'source' ? 'bg-src/10 text-src ring-src/25' : 'bg-trf/10 text-trf ring-trf/25',
      )}
    >
      <Icon className={size === 'md' ? 'size-4' : 'size-3.5'} strokeWidth={2} />
    </div>
  )
}

const statusStyle: Record<NodeStatus, { label: string; cls: string; dot: string }> = {
  fresh: { label: 'Fresh', cls: 'text-ok bg-ok/10 ring-ok/20', dot: 'bg-ok' },
  stale: { label: 'Stale', cls: 'text-warn bg-warn/10 ring-warn/20', dot: 'bg-warn' },
  running: { label: 'Running', cls: 'text-run bg-run/10 ring-run/25', dot: 'bg-run animate-ldi-pulse' },
  error: { label: 'Error', cls: 'text-err bg-err/10 ring-err/20', dot: 'bg-err' },
  never_run: { label: 'Not run', cls: 'text-muted bg-white/5 ring-white/10', dot: 'bg-faint' },
}

export function StatusPill({ status }: { status: NodeStatus }) {
  const s = statusStyle[status]
  return (
    <span
      className={clsx(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium ring-1 ring-inset',
        s.cls,
      )}
    >
      <span className={clsx('size-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 460,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-[3px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full overflow-hidden rounded-2xl border border-line2 bg-panel shadow-[0_24px_80px_-12px_rgba(0,0,0,0.9)]"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-1">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <Button variant="ghost" size="icon" className="-mr-2 size-7" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="px-5 py-3 text-[13px] leading-relaxed text-muted">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line bg-panel2/60 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export type MenuItem =
  { label: ReactNode; icon?: LucideIcon; hint?: string; onSelect: () => void; disabled?: boolean } | 'separator'

/** A small dropdown, portalled so scrolling containers don't clip it. */
export function Menu({ trigger, items, title }: { trigger: ReactNode; items: MenuItem[]; title?: string }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <Button ref={btn} variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} title={title} aria-expanded={open}>
        {trigger}
      </Button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            role="menu"
            className="fixed z-50 min-w-56 rounded-xl border border-line2 bg-panel2 p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.8)]"
            style={pos}
          >
            {items.map((item, i) =>
              item === 'separator' ? (
                <div key={i} className="my-1 h-px bg-line" />
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg transition-colors hover:bg-panel3 disabled:pointer-events-none disabled:opacity-45"
                >
                  {item.icon && <item.icon className="size-3.5 shrink-0 text-muted" />}
                  <span className="flex-1">{item.label}</span>
                  {item.hint && <span className="text-[11px] text-faint">{item.hint}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
