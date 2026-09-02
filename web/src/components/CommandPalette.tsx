import { Briefcase, FileStack, LayoutDashboard, Link2, Moon, Plus, Search, Sun, Table2 } from 'lucide-react'
import { useMemo, useState } from 'react'

interface Action {
  id: string
  label: string
  hint: string
  icon: typeof Search
  run: () => void
}

export function CommandPalette({
  theme,
  onClose,
  onCapture,
  onAddApplication,
  onTheme,
}: {
  theme: 'light' | 'dark'
  onClose: () => void
  onCapture: () => void
  onAddApplication: () => void
  onTheme: () => void
}) {
  const [query, setQuery] = useState('')

  const actions = useMemo<Action[]>(
    () => [
      { id: 'home', label: 'Go to Home', hint: 'Overview', icon: LayoutDashboard, run: () => { window.location.hash = '#/' } },
      { id: 'search', label: 'Search jobs', hint: 'Portal search', icon: Search, run: () => { window.location.hash = '#/search' } },
      { id: 'jobs', label: 'Saved jobs', hint: 'Inbox', icon: Briefcase, run: () => { window.location.hash = '#/jobs' } },
      { id: 'apps', label: 'Applications', hint: 'Tracker', icon: Table2, run: () => { window.location.hash = '#/applications' } },
      { id: 'docs', label: 'Documents', hint: 'CVs and postings', icon: FileStack, run: () => { window.location.hash = '#/documents' } },
      { id: 'link', label: 'Paste a job link', hint: 'Fetch a posting', icon: Link2, run: onCapture },
      { id: 'add', label: 'Add an application', hint: 'By hand', icon: Plus, run: onAddApplication },
      {
        id: 'theme',
        label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        hint: 'Appearance',
        icon: theme === 'dark' ? Sun : Moon,
        run: onTheme,
      },
    ],
    [onAddApplication, onCapture, onTheme, theme],
  )

  const filtered = actions.filter((action) => {
    const hay = `${action.label} ${action.hint}`.toLowerCase()
    return hay.includes(query.trim().toLowerCase())
  })

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-[12vh]">
      <button className="absolute inset-0 cursor-default" aria-label="Close command palette" onClick={onClose} />
      <div className="palette relative z-10 w-full max-w-lg overflow-hidden">
        <input
          autoFocus
          className="palette-input"
          placeholder="Jump, paste a link, or add…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter' && filtered[0]) {
              filtered[0].run()
              onClose()
            }
          }}
        />
        <ul className="max-h-80 overflow-y-auto p-1">
          {filtered.map((action) => {
            const Icon = action.icon
            return (
              <li key={action.id}>
                <button
                  className="palette-item"
                  onClick={() => {
                    action.run()
                    onClose()
                  }}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  <span className="flex-1 text-left">{action.label}</span>
                  <span className="text-xs text-[var(--muted)]">{action.hint}</span>
                </button>
              </li>
            )
          })}
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-sm text-[var(--muted)]">Nothing matches.</li>
          ) : null}
        </ul>
        <p className="border-t border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)]">
          <kbd className="kbd">⌘</kbd>
          <kbd className="kbd">K</kbd> anytime · paste a job URL on a blank page
        </p>
      </div>
    </div>
  )
}
