import { Check, Copy, X } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { BUCKET_COLORS } from '../status'
import { copyText } from '../util'
import type { StatusBucket } from '../types'

export function StatusBadge({ bucket, label }: { bucket: StatusBucket | string; label?: string }) {
  const color = BUCKET_COLORS[bucket as StatusBucket] ?? '#64748b'
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ background: `${color}22`, color }}
    >
      {label ?? bucket}
    </span>
  )
}

export function StatCard({
  label,
  value,
  color,
  hint,
}: {
  label: string
  value: number | string
  color: string
  hint?: string
}) {
  return (
    <div className="card p-4" style={{ borderLeft: `4px solid ${color}` }}>
      <p className="text-sm text-[var(--muted)]">{label}</p>
      <p className="mt-1 font-display text-3xl font-bold tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
    </div>
  )
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="card flex flex-col items-start gap-3 p-8">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <p className="max-w-xl text-[var(--muted)]">{body}</p>
      {action}
    </div>
  )
}

export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const headingId = useId()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <button className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={`card relative z-10 w-full p-5 ${wide ? 'max-w-2xl' : 'max-w-lg'}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={headingId} className="font-display text-lg font-semibold">
            {title}
          </h2>
          <button className="btn btn-ghost px-2 py-1 text-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Drawer({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  const headingId = useId()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/35">
      <button className="absolute inset-0 cursor-default" aria-label="Close panel" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="drawer relative z-10 flex h-full w-full max-w-md flex-col"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <h2 id={headingId} className="font-display text-lg font-semibold">
            {title}
          </h2>
          <button className="btn btn-ghost px-2 py-1 text-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  )
}

export function CopyButton({
  text,
  label = 'Copy',
  done = 'Copied',
}: {
  text: string
  label?: string
  done?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        })
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? done : label}
    </button>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

export function Chip({
  active,
  children,
  onClick,
}: {
  active?: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button type="button" className={`chip ${active ? 'chip-on' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}

export function Banner({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'err' }) {
  return <div className={`banner banner-${tone}`}>{children}</div>
}
