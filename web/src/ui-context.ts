import { createContext, useContext } from 'react'

export type ToastKind = 'ok' | 'err' | 'info'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
}

export interface PastePrefill {
  url?: string
  message?: string
  company?: string
  role?: string
}

export interface UiContextValue {
  toast: (message: string, kind?: ToastKind) => void
  openCapture: (url?: string) => void
  openPaste: (prefill?: PastePrefill) => void
  refresh: number
  bump: () => void
}

export const UiContext = createContext<UiContextValue | null>(null)

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext)
  if (!ctx) throw new Error('useUi must be used inside the app shell')
  return ctx
}
