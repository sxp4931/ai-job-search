import {
  Briefcase,
  Command,
  FileStack,
  LayoutDashboard,
  Moon,
  Search,
  Sun,
  Table2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { CaptureModal, PasteModal } from './components/Capture'
import { CommandPalette } from './components/CommandPalette'
import { DropOverlay } from './components/DropOverlay'
import { Toasts } from './components/Toasts'
import { ApplicationsPage } from './pages/Applications'
import { DashboardPage } from './pages/Dashboard'
import { DocumentsPage } from './pages/Documents'
import { JobsPage } from './pages/Jobs'
import { SearchPage } from './pages/Search'
import type { Page, Profile } from './types'
import { UiContext, type PastePrefill, type Toast, type ToastKind } from './ui-context'
import { extractUrl } from './util'

const NAV: Array<{ id: Page; href: string; label: string; icon: typeof Search }> = [
  { id: 'home', href: '#/', label: 'Home', icon: LayoutDashboard },
  { id: 'search', href: '#/search', label: 'Search', icon: Search },
  { id: 'jobs', href: '#/jobs', label: 'Jobs', icon: Briefcase },
  { id: 'applications', href: '#/applications', label: 'Applications', icon: Table2 },
  { id: 'documents', href: '#/documents', label: 'Documents', icon: FileStack },
]

function parsePage(): Page {
  const hash = window.location.hash.replace(/^#\/?/, '')
  if (hash.startsWith('search')) return 'search'
  if (hash.startsWith('jobs')) return 'jobs'
  if (hash.startsWith('applications')) return 'applications'
  if (hash.startsWith('documents')) return 'documents'
  return 'home'
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('job-ui-theme', theme)
}

export default function App() {
  const [page, setPage] = useState<Page>(parsePage)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('job-ui-theme')
    if (stored === 'dark' || stored === 'light') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [refresh, setRefresh] = useState(0)
  const [captureUrl, setCaptureUrl] = useState<string | null>(null)
  const [paste, setPaste] = useState<PastePrefill | null>(null)
  const [palette, setPalette] = useState(false)
  const [addRequest, setAddRequest] = useState(0)

  const toast = useCallback((message: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current.slice(-4), { id, message, kind }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id))
    }, 4200)
  }, [])

  const openCapture = useCallback((url = '') => {
    setCaptureUrl(url)
  }, [])

  const openPaste = useCallback((prefill: PastePrefill = {}) => {
    setPaste(prefill)
  }, [])

  const bump = useCallback(() => setRefresh((n) => n + 1), [])

  const ui = useMemo(
    () => ({ toast, openCapture, openPaste, refresh, bump }),
    [toast, openCapture, openPaste, refresh, bump],
  )

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    const onHash = () => setPage(parsePage())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    api.profile().then(setProfile).catch(() => setProfile(null))
  }, [])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      const text = event.clipboardData?.getData('text') ?? ''
      const url = extractUrl(text)
      if (!url) return
      event.preventDefault()
      openCapture(url)
    }
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette((open) => !open)
      }
      if (event.key === 'Escape') {
        setPalette(false)
        setCaptureUrl(null)
        setPaste(null)
      }
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKey)
    }
  }, [openCapture])

  return (
    <UiContext.Provider value={ui}>
      <div className="app-shell">
        <aside className="sidebar">
          <div>
            <p className="eyebrow">AI Job Search</p>
            <p className="mt-1 font-display text-lg font-bold">
              {profile?.ready ? profile.name : 'Your search'}
            </p>
            {profile?.headline ? (
              <p className="mt-1 text-sm text-[var(--muted)]">{profile.headline}</p>
            ) : null}
          </div>
          <nav className="sidebar-nav" aria-label="Main">
            {NAV.map((item) => {
              const Icon = item.icon
              return (
                <a
                  key={item.id}
                  href={item.href}
                  aria-current={page === item.id ? 'page' : undefined}
                  className="nav-link"
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {item.label}
                </a>
              )
            })}
          </nav>
          <div className="mt-auto hidden flex-col gap-2 md:flex">
            <button className="btn btn-ghost self-start" onClick={() => setPalette(true)}>
              <Command className="size-4" />
              Commands
              <kbd className="kbd">⌘K</kbd>
            </button>
            <button
              className="btn btn-ghost self-start"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </aside>

        <main className="main-pane">
          {profile && !profile.ready ? (
            <p className="banner banner-warn mb-5">
              Profile still has placeholders. Run /setup in your coding assistant so your name lands here.
            </p>
          ) : null}
          {page === 'home' ? <DashboardPage /> : null}
          {page === 'search' ? <SearchPage /> : null}
          {page === 'jobs' ? <JobsPage /> : null}
          {page === 'applications' ? <ApplicationsPage addRequest={addRequest} /> : null}
          {page === 'documents' ? <DocumentsPage /> : null}
          <p className="mt-10 text-xs text-[var(--muted)]">
            Local only on this computer. Drafting a CV still happens in your coding assistant with /apply.
          </p>
        </main>

        <nav className="mobile-nav" aria-label="Main">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <a
                key={item.id}
                href={item.href}
                aria-current={page === item.id ? 'page' : undefined}
                className="mobile-link"
              >
                <Icon className="size-5" aria-hidden="true" />
                {item.label}
              </a>
            )
          })}
        </nav>
      </div>

      <DropOverlay />
      <Toasts toasts={toasts} />
      {palette ? (
        <CommandPalette
          theme={theme}
          onClose={() => setPalette(false)}
          onCapture={() => openCapture()}
          onAddApplication={() => {
            window.location.hash = '#/applications'
            setAddRequest((n) => n + 1)
          }}
          onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      ) : null}
      {captureUrl !== null ? (
        <CaptureModal initialUrl={captureUrl} onClose={() => setCaptureUrl(null)} />
      ) : null}
      {paste ? <PasteModal prefill={paste} onClose={() => setPaste(null)} /> : null}
    </UiContext.Provider>
  )
}
