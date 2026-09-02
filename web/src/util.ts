import type { DocFolder } from './types'

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i

export function extractUrl(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  const match = raw.match(URL_RE)
  if (!match) return null
  return match[0].replace(/[.,);]+$/, '')
}

export function relativeDate(iso?: string | null): string {
  if (!iso) return ''
  const day = iso.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return iso
  const due = new Date(`${day}T12:00:00`)
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const diff = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff > 1 && diff < 14) return `In ${diff} days`
  if (diff < 0 && diff > -14) return `${Math.abs(diff)} days ago`
  return day
}

export function deadlineTone(iso?: string | null): 'ok' | 'soon' | 'late' | '' {
  if (!iso) return ''
  const day = iso.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const due = new Date(`${day}T12:00:00`)
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const diff = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  if (diff < 0) return 'late'
  if (diff <= 7) return 'soon'
  return 'ok'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function applyCommand(url: string): string {
  return `/apply ${url}`
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      resolve(comma >= 0 ? value.slice(comma + 1) : value)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

export function guessFolder(file: File): DocFolder {
  const name = file.name.toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (name.includes('linkedin') && ext === '.pdf') return 'linkedin'
  if (ext === '.txt' || ext === '.md') return 'postings'
  return 'cv'
}

export function isDroppableFile(file: File): boolean {
  const name = file.name.toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  return ['.pdf', '.tex', '.txt', '.md'].includes(ext)
}

export function portalLabel(id?: string): string {
  if (!id) return ''
  return id.replace(/-search$/, '')
}

export function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
