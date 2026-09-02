import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import type { Toast } from '../ui-context'

const ICONS = {
  ok: CircleCheck,
  err: CircleAlert,
  info: Info,
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind]
        return (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <p>{toast.message}</p>
          </div>
        )
      })}
    </div>
  )
}
