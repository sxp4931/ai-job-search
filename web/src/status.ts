import type { StatusBucket, TrackerStatus } from './types'

export const STATUS_OPTIONS: Array<{ value: TrackerStatus; label: string }> = [
  { value: 'drafted', label: 'Drafted' },
  { value: 'applied', label: 'Applied' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'hired', label: 'Hired' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'no_response', label: 'No response' },
  { value: 'offer_declined', label: 'Offer declined' },
  { value: 'withdrawn', label: 'Withdrawn' },
]

export const BUCKET_COLORS: Record<StatusBucket, string> = {
  Drafted: '#64748b',
  Active: '#3b82f6',
  Interview: '#f59e0b',
  Offer: '#8b5cf6',
  Hired: '#22c55e',
  'Rejected/Closed': '#ef4444',
}

export function statusLabel(value: string): string {
  const match = STATUS_OPTIONS.find((option) => option.value === value)
  if (match) return match.label
  return value.replaceAll('_', ' ') || '—'
}
