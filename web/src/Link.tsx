import type { ReactNode } from 'react'

export function Link({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children: ReactNode
}) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  )
}
