import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { EmptyState } from '../components/ui'
import type { Portal, SearchHit } from '../types'

export function SearchPage() {
  const [portals, setPortals] = useState<Portal[]>([])
  const [portalId, setPortalId] = useState('')
  const [query, setQuery] = useState('')
  const [location, setLocation] = useState('')
  const [jobage, setJobage] = useState('14')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [notice, setNotice] = useState('')

  useEffect(() => {
    api
      .portals()
      .then((list) => {
        setPortals(list)
        const preferred = list.find((item) => item.enabled) ?? list[0]
        if (preferred) setPortalId(preferred.id)
      })
      .catch((err: Error) => setError(err.message))
  }, [])

  const portal = useMemo(
    () => portals.find((item) => item.id === portalId),
    [portals, portalId],
  )

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const payload: Record<string, string | number> = {
        portal: portalId,
        query,
        location,
        limit: 20,
      }
      if (jobage) payload.jobage = Number(jobage)
      const data = await api.search(payload)
      setResults(data.results)
      if (data.count === 0) setNotice('No results. Try a broader keyword or another portal.')
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
      setNotice(track ? `Tracked ${hit.company}` : `Saved ${hit.title}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Search jobs</h1>
        <p className="mt-1 text-[var(--muted)]">
          Uses the same portal tools as /scrape. Pick a board, type a role, and save what looks right.
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
                {item.title.replace(/ Search Skill$/i, '').replace(/ Search$/i, '')}
                {item.enabled ? '' : ' (off in scrape)'}
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
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Searching…' : 'Search'}
            </button>
          </div>

          {portal?.personal_use_warning ? (
            <p className="text-sm text-[var(--muted)]">
              LinkedIn search is personal-use only. Keep volume low.
            </p>
          ) : null}
        </form>
      )}

      {error ? <p className="text-red-600">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}

      {results.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {results.map((hit) => (
            <li key={`${hit.url}-${hit.id}`} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{hit.title || 'Untitled role'}</p>
                  <p className="text-sm text-[var(--muted)]">
                    {hit.company || 'Unknown company'}
                    {hit.location ? ` · ${hit.location}` : ''}
                    {hit.date ? ` · ${hit.date}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {hit.url ? (
                    <a className="btn btn-ghost" href={hit.url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  ) : null}
                  <button className="btn btn-ghost" onClick={() => void save(hit, false)}>
                    Save
                  </button>
                  <button className="btn btn-primary" onClick={() => void save(hit, true)}>
                    Track
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
