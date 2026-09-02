import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { EmptyState, StatusBadge } from '../components/ui'
import { Link } from '../Link'
import { statusLabel } from '../status'
import type { Job } from '../types'

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [query, setQuery] = useState('')
  const [fit, setFit] = useState('all')
  const [status, setStatus] = useState('all')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = () => api.jobs().then(setJobs).catch((err: Error) => setError(err.message))

  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return jobs.filter((job) => {
      if (fit !== 'all' && (job.fit || '').toLowerCase() !== fit) return false
      if (status !== 'all' && (job.status || 'new') !== status) return false
      if (!q) return true
      const hay = `${job.title} ${job.company} ${job.location ?? ''} ${job.portal ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [jobs, query, fit, status])

  async function track(job: Job) {
    setNotice('')
    try {
      await api.trackJob(job.key)
      setNotice(`Tracked ${job.company} — ${job.title}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not track job')
    }
  }

  async function hide(job: Job) {
    await api.patchJob(job.key, { status: 'skipped' })
    await load()
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Saved jobs</h1>
        <p className="mt-1 text-[var(--muted)]">
          Jobs from past searches and scrapes. Track one to add it to your applications list.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          className="field max-w-sm"
          placeholder="Filter by company, title, portal…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select className="field w-auto" value={fit} onChange={(event) => setFit(event.target.value)}>
          <option value="all">Any fit</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select className="field w-auto" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">Any status</option>
          <option value="new">New</option>
          <option value="ranked">Ranked</option>
          <option value="tracked">Tracked</option>
          <option value="skipped">Skipped</option>
          <option value="expired">Expired</option>
        </select>
      </div>

      {error ? <p className="text-red-600">{error}</p> : null}
      {notice ? <p className="text-[var(--accent-ink)]">{notice}</p> : null}

      {jobs.length === 0 ? (
        <EmptyState
          title="No saved jobs yet"
          body="Run a search and save the ones worth a look. /scrape from your assistant also lands here."
          action={
            <Link className="btn btn-primary" href="#/search">
              Search now
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="text-[var(--muted)]">No jobs match those filters.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((job) => (
            <li key={job.key} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{job.title}</p>
                  <p className="text-sm text-[var(--muted)]">
                    {job.company || 'Unknown company'}
                    {job.location ? ` · ${job.location}` : ''}
                    {job.portal ? ` · ${job.portal.replace(/-search$/, '')}` : ''}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {job.fit ? <StatusBadge bucket="Active" label={`${job.fit} fit`} /> : null}
                    <StatusBadge bucket="Drafted" label={statusLabel(job.status || 'new')} />
                    {typeof job.rank_score === 'number' ? (
                      <StatusBadge bucket="Interview" label={`Score ${job.rank_score}`} />
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {job.url ? (
                    <a className="btn btn-ghost" href={job.url} target="_blank" rel="noreferrer">
                      Open posting
                    </a>
                  ) : null}
                  <button className="btn btn-primary" onClick={() => void track(job)}>
                    Track
                  </button>
                  <button className="btn btn-ghost" onClick={() => void hide(job)}>
                    Hide
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
