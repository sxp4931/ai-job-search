import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Banner, CopyButton, EmptyState, StatusBadge } from '../components/ui'
import { applyCommand, portalLabel, relativeDate, shortHost } from '../util'
import { useUi } from '../ui-context'
import type { Job, Portal, SearchHit } from '../types'

const LAST_KEY = 'job-ui-last-search'

export function SearchPage() {
  const { toast, bump } = useUi()
  const [portals, setPortals] = useState<Portal[]>([])
  const [savedUrls, setSavedUrls] = useState<Set<string>>(new Set())
  const [portalId, setPortalId] = useState('')
  const [query, setQuery] = useState('')
  const [location, setLocation] = useState('')
  const [jobage, setJobage] = useState('14')
  const [remote, setRemote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])

  useEffect(() => {
    api
      .portals()
      .then((list) => {
        setPortals(list)
        const stored = localStorage.getItem(LAST_KEY)
        let remembered: { portal?: string; query?: string; location?: string } = {}
        try {
          remembered = stored ? (JSON.parse(stored) as typeof remembered) : {}
        } catch {
          remembered = {}
        }
        const preferred =
          list.find((item) => item.id === remembered.portal) ??
          list.find((item) => item.enabled) ??
          list[0]
        if (preferred) setPortalId(preferred.id)
        if (remembered.query) setQuery(remembered.query)
        if (remembered.location) setLocation(remembered.location)
      })
      .catch((err: Error) => setError(err.message))
    api
      .jobs()
      .then((jobs: Job[]) => setSavedUrls(new Set(jobs.map((job) => job.url).filter(Boolean))))
      .catch(() => undefined)
  }, [])

  const portal = useMemo(() => portals.find((item) => item.id === portalId), [portals, portalId])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    localStorage.setItem(LAST_KEY, JSON.stringify({ portal: portalId, query, location }))
    try {
      const payload: Record<string, string | number> = {
        portal: portalId,
        query,
        location,
        limit: 20,
      }
      if (jobage) payload.jobage = Number(jobage)
      if (remote) payload.remote = remote
      const data = await api.search(payload)
      setResults(data.results)
      if (data.count === 0) toast('No results. Try a broader keyword or another portal.', 'info')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setResults([])
    } finally {
      setBusy(false)
    }
  }

  async function save(hit: SearchHit, track: boolean) {
    setError('')
    try {
      const saved = await api.saveJob({
        title: hit.title,
        company: hit.company,
        url: hit.url,
        location: hit.location,
        date: hit.date,
        deadline: hit.deadline,
        portal: hit.portal,
        status: 'new',
        source: 'cli',
      })
      if (track) await api.trackJob(saved.key)
      setSavedUrls((current) => new Set([...current, hit.url]))
      bump()
      toast(track ? `Tracking ${hit.company}` : `Saved ${hit.title}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'err')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="eyebrow">Boards</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Search jobs</h1>
        <p className="mt-1 text-[var(--muted)]">
          Same portal tools as /scrape. Save what looks right, or copy /apply for your assistant.
        </p>
      </div>

      {portals.length === 0 ? (
        <EmptyState
          title="No job boards installed"
          body="Portal CLIs live under .agents/skills. After /add-portal they show up here automatically."
        />
      ) : (
        <form className="card flex flex-col gap-4 p-5" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex flex-wrap gap-2">
            {portals.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`btn ${portalId === item.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setPortalId(item.id)}
              >
                {portalLabel(item.id) || item.title}
                {item.enabled ? '' : ' · off'}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Keywords
              <input
                className="field font-normal"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="e.g. software engineer"
                required={portalId !== 'freehire-search'}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Location {portal?.requires_location ? '(needed for LinkedIn)' : '(optional)'}
              <input
                className="field font-normal"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder={portal?.requires_location ? 'Berlin, Germany or Remote' : 'City or region'}
                required={Boolean(portal?.requires_location)}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Posted within
              <select className="field w-auto font-normal" value={jobage} onChange={(event) => setJobage(event.target.value)}>
                <option value="">Any time</option>
                <option value="1">Last day</option>
                <option value="7">Last 7 days</option>
                <option value="14">Last 14 days</option>
                <option value="30">Last 30 days</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Work mode
              <select className="field w-auto font-normal" value={remote} onChange={(event) => setRemote(event.target.value)}>
                <option value="">Any</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Searching…' : 'Search'}
            </button>
          </div>

          {portal?.personal_use_warning ? (
            <p className="text-sm text-[var(--muted)]">LinkedIn search is personal-use only. Keep volume low.</p>
          ) : null}
        </form>
      )}

      {error ? <Banner tone="err">{error}</Banner> : null}

      {results.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--muted)]">
            {results.length} result{results.length === 1 ? '' : 's'}
          </p>
          <ul className="flex flex-col gap-3">
            {results.map((hit) => {
              const saved = hit.url ? savedUrls.has(hit.url) : false
              return (
                <li key={`${hit.url}-${hit.id}`} className="card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{hit.title || 'Untitled role'}</p>
                      <p className="text-sm text-[var(--muted)]">
                        {hit.company || 'Unknown company'}
                        {hit.location ? ` · ${hit.location}` : ''}
                        {hit.date ? ` · ${relativeDate(hit.date) || hit.date}` : ''}
                        {hit.url ? ` · ${shortHost(hit.url)}` : ''}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <StatusBadge bucket="Drafted" label={portalLabel(hit.portal)} />
                        {saved ? <StatusBadge bucket="Active" label="Saved" /> : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {hit.url ? (
                        <a className="btn btn-ghost" href={hit.url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : null}
                      {hit.url ? <CopyButton text={applyCommand(hit.url)} label="/apply" /> : null}
                      <button className="btn btn-ghost" onClick={() => void save(hit, false)}>
                        Save
                      </button>
                      <button className="btn btn-primary" onClick={() => void save(hit, true)}>
                        Track
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
