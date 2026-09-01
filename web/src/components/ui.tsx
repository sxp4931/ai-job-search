import type { ReactNode } from 'react'
import { BUCKET_COLORS } from '../status'
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
      <p className="mt-1 text-3xl font-bold tracking-tight">{value}</p>
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
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-xl text-[var(--muted)]">{body}</p>
      {action}
    </div>
  )
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <button className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} />
      <div className="card relative z-10 w-full max-w-lg p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn btn-ghost px-2 py-1 text-sm" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
