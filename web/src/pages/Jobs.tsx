import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { CaptureBar } from '../components/Capture'
import { Banner, Chip, CopyButton, EmptyState, StatusBadge } from '../components/ui'
import { Link } from '../Link'
import { statusLabel } from '../status'
import { useUi } from '../ui-context'
import { applyCommand, portalLabel, relativeDate } from '../util'
import type { Job } from '../types'

export function JobsPage() {
  const { toast, refresh, bump } = useUi()
  const [jobs, setJobs] = useState<Job[]>([])
  const [query, setQuery] = useState('')
  const [fit, setFit] = useState('all')
  const [status, setStatus] = useState('all')
  const [error, setError] = useState('')

  const load = () => api.jobs().then(setJobs).catch((err: Error) => setError(err.message))

  useEffect(() => {
    void load()
  }, [refresh])

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: jobs.length, new: 0, ranked: 0, tracked: 0, skipped: 0 }
    for (const job of jobs) {
      const key = job.status || 'new'
      map[key] = (map[key] || 0) + 1
    }
    return map
  }, [jobs])

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
    try {
      await api.trackJob(job.key)
      bump()
      toast(`Tracking ${job.company} · ${job.title}`)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not track job', 'err')
    }
  }

  async function hide(job: Job) {
    await api.patchJob(job.key, { status: 'skipped' })
    await load()
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Inbox</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">Saved jobs</h1>
          <p className="mt-1 text-[var(--muted)]">
            From searches, scrapes, and pasted links. Track one to add it to Applications.
          </p>
        </div>
        <div className="w-full max-w-md">
          <CaptureBar />
        </div>
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
      </div>

      <div className="flex flex-wrap gap-2">
        {(['all', 'new', 'ranked', 'tracked', 'skipped'] as const).map((value) => (
          <Chip key={value} active={status === value} onClick={() => setStatus(value)}>
            {value === 'all' ? 'All' : statusLabel(value)}
            {typeof counts[value] === 'number' ? ` ${counts[value]}` : ''}
          </Chip>
        ))}
      </div>

      {error ? <Banner tone="err">{error}</Banner> : null}

      {jobs.length === 0 ? (
        <EmptyState
          title="No saved jobs yet"
          body="Paste a posting URL above, run a search, or let /scrape land jobs here."
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
                <div className="min-w-0">
                  <p className="font-semibold">{job.title}</p>
                  <p className="text-sm text-[var(--muted)]">
                    {job.company || 'Unknown company'}
                    {job.location ? ` · ${job.location}` : ''}
                    {job.portal ? ` · ${portalLabel(job.portal)}` : ''}
                    {job.posted_date ? ` · ${relativeDate(job.posted_date)}` : ''}
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
                      Open
                    </a>
                  ) : null}
                  {job.url?.startsWith('http') ? (
                    <CopyButton text={applyCommand(job.url)} label="/apply" />
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
