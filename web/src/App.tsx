import { Briefcase, LayoutDashboard, Moon, Search, Sun, Table2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from './api'
import { ApplicationsPage } from './pages/Applications'
import { DashboardPage } from './pages/Dashboard'
import { JobsPage } from './pages/Jobs'
import { SearchPage } from './pages/Search'
import type { Page, Profile } from './types'

const NAV: Array<{ id: Page; href: string; label: string; icon: typeof Search }> = [
  { id: 'home', href: '#/', label: 'Home', icon: LayoutDashboard },
  { id: 'search', href: '#/search', label: 'Search', icon: Search },
  { id: 'jobs', href: '#/jobs', label: 'Jobs', icon: Briefcase },
  { id: 'applications', href: '#/applications', label: 'Applications', icon: Table2 },
]

function parsePage(): Page {
  const hash = window.location.hash.replace(/^#\/?/, '')
  if (hash.startsWith('search')) return 'search'
  if (hash.startsWith('jobs')) return 'jobs'
  if (hash.startsWith('applications')) return 'applications'
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

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col md:flex-row">
      <aside className="flex flex-col gap-6 border-b border-[var(--line)] p-4 md:w-56 md:border-b-0 md:border-r md:p-6">
        <div>
          <p className="text-xs font-semibold tracking-[0.2em] text-[var(--muted)] uppercase">AI Job Search</p>
          <p className="mt-1 text-lg font-bold">{profile?.ready ? profile.name : 'Your search'}</p>
          {profile?.headline ? (
            <p className="mt-1 text-sm text-[var(--muted)]">{profile.headline}</p>
          ) : null}
        </div>
        <nav className="flex flex-row gap-1 md:flex-col" aria-label="Main">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <a
                key={item.id}
                href={item.href}
                aria-current={page === item.id ? 'page' : undefined}
                className="nav-link flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium"
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </a>
            )
          })}
        </nav>
        <button
          className="btn btn-ghost mt-auto self-start"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </aside>

      <main className="flex-1 p-4 md:p-8">
        {page === 'home' ? <DashboardPage /> : null}
        {page === 'search' ? <SearchPage /> : null}
        {page === 'jobs' ? <JobsPage /> : null}
        {page === 'applications' ? <ApplicationsPage /> : null}
        <p className="mt-10 text-xs text-[var(--muted)]">
          Local only on this computer. Drafting a CV still happens in your coding assistant with /apply.
        </p>
      </main>
    </div>
  )
}
