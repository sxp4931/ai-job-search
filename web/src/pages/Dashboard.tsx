import { useEffect, useState } from 'react'
import { api } from '../api'
import { CaptureHero } from '../components/Capture'
import { Banner, EmptyState, Skeleton, StatCard, StatusBadge } from '../components/ui'
import { Link } from '../Link'
import { BUCKET_COLORS } from '../status'
import { useUi } from '../ui-context'
import { deadlineTone, relativeDate } from '../util'
import type { Summary } from '../types'

export function DashboardPage() {
  const { refresh, openCapture } = useUi()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .summary()
      .then(setSummary)
      .catch((err: Error) => setError(err.message))
  }, [refresh])

  if (error) return <Banner tone="err">{error}</Banner>
  if (!summary) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    )
  }

  const empty = summary.total_rows === 0 && summary.jobs_count === 0
  const funnelMax = Math.max(summary.funnel.applied, 1)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="eyebrow">Today</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Your search</h1>
        <p className="mt-1 text-[var(--muted)]">
          Paste a link, drop a resume, then track what you want to apply to.
        </p>
      </div>

      <CaptureHero />

      {empty ? (
        <EmptyState
          title="Nothing tracked yet"
          body="Search a job board, or paste a posting you already have open. CVs and cover letters still come from /apply in your coding assistant."
          action={
            <div className="flex flex-wrap gap-2">
              <Link className="btn btn-primary" href="#/search">
                Search jobs
              </Link>
              <button className="btn btn-ghost" onClick={() => openCapture()}>
                Paste a job link
              </button>
            </div>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard label="Sent" value={summary.sent} color="#0f766e" hint="Drafts are not counted" />
            <StatCard label="Drafted" value={summary.drafted} color={BUCKET_COLORS.Drafted} />
            <StatCard label="Active" value={summary.by_bucket.Active} color={BUCKET_COLORS.Active} />
            <StatCard label="Interview" value={summary.by_bucket.Interview} color={BUCKET_COLORS.Interview} />
            <StatCard label="Offer" value={summary.by_bucket.Offer} color={BUCKET_COLORS.Offer} />
            <StatCard
              label="Rejected / closed"
              value={summary.by_bucket['Rejected/Closed']}
              color={BUCKET_COLORS['Rejected/Closed']}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-display font-semibold">Next up</h2>
                <Link className="text-sm font-semibold text-[var(--accent)]" href="#/jobs">
                  {summary.untracked_count} saved
                </Link>
              </div>
              {summary.deadlines.length === 0 && summary.untracked_jobs.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No deadlines or untracked jobs right now.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {summary.deadlines.slice(0, 4).map((item) => {
                    const tone = deadlineTone(item.deadline)
                    return (
                      <li key={item.id} className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium">{item.company}</p>
                          <p className="text-sm text-[var(--muted)]">{item.role}</p>
                        </div>
                        <span className={`deadline deadline-${tone || 'ok'}`}>
                          {relativeDate(item.deadline)}
                        </span>
                      </li>
                    )
                  })}
                  {summary.untracked_jobs.map((job) => (
                    <li key={job.key} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{job.title || 'Untitled role'}</p>
                        <p className="text-sm text-[var(--muted)]">{job.company || 'Unknown company'}</p>
                      </div>
                      <StatusBadge bucket="Drafted" label="Not tracked" />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card p-5">
              <h2 className="mb-4 font-display font-semibold">Funnel</h2>
              {(
                [
                  ['Applied', summary.funnel.applied],
                  ['Interview', summary.funnel.interview],
                  ['Offer', summary.funnel.offer],
                  ['Hired', summary.funnel.hired],
                ] as const
              ).map(([label, count]) => (
                <div key={label} className="mb-3">
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{label}</span>
                    <span className="text-[var(--muted)]">{count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-[var(--line)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${Math.round((count / funnelMax) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="mt-3 text-sm text-[var(--muted)]">
                {summary.past_resume_screen == null
                  ? 'Send a few applications to see screen-pass rate.'
                  : `${summary.past_resume_screen}% moved past resume screen.`}
                {summary.rejection_rate != null ? ` Rejection rate ${summary.rejection_rate}%.` : ''}
              </p>
            </section>
          </div>

          <section className="card overflow-hidden">
            <div className="flex items-center justify-between gap-3 p-5 pb-3">
              <h2 className="font-display font-semibold">Recent applications</h2>
              <Link className="text-sm font-semibold text-[var(--accent)]" href="#/applications">
                See all
              </Link>
            </div>
            {summary.recent.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-[var(--muted)]">No applications yet.</p>
            ) : (
              <ul>
                {summary.recent.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-3"
                  >
                    <div>
                      <p className="font-medium">
                        {row.company} · {row.role}
                      </p>
                      <p className="text-sm text-[var(--muted)]">{relativeDate(row.date) || 'No date'}</p>
                    </div>
                    <StatusBadge bucket={row.bucket} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
