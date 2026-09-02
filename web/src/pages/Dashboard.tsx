import { useEffect, useState } from 'react'
import { Link } from '../Link'
import { api } from '../api'
import { EmptyState, StatCard } from '../components/ui'
import { BUCKET_COLORS } from '../status'
import type { Summary } from '../types'

export function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.summary().then(setSummary).catch((err: Error) => setError(err.message))
  }, [])

  if (error) return <p className="text-red-600">{error}</p>
  if (!summary) return <p className="text-[var(--muted)]">Loading your search…</p>

  const empty = summary.total_rows === 0
  const funnelMax = Math.max(summary.funnel.applied, 1)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
        <p className="mt-1 text-[var(--muted)]">
          Your applications, deadlines, and funnel — from the same tracker the rest of the workflow uses.
        </p>
      </div>

      {empty ? (
        <EmptyState
          title="Nothing tracked yet"
          body="Search for jobs, then tap Track. Or add an application by hand. CVs and cover letters still come from /apply in your coding assistant."
          action={
            <div className="flex flex-wrap gap-2">
              <Link className="btn btn-primary" href="#/search">
                Search jobs
              </Link>
              <Link className="btn btn-ghost" href="#/applications">
                Add an application
              </Link>
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
              <h2 className="mb-4 font-semibold">Funnel</h2>
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

            <section className="card p-5">
              <h2 className="mb-4 font-semibold">Deadlines</h2>
              {summary.deadlines.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No deadlines recorded yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {summary.deadlines.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{item.company}</p>
                        <p className="text-sm text-[var(--muted)]">{item.role}</p>
                      </div>
                      <span
                        className="text-sm font-semibold"
                        style={{ color: item.passed ? '#ef4444' : item.urgent ? '#d97706' : 'inherit' }}
                      >
                        {item.passed ? 'Passed ' : ''}
                        {item.deadline}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="card overflow-hidden">
            <div className="flex items-center justify-between gap-3 p-5 pb-3">
              <h2 className="font-semibold">Recent applications</h2>
              <Link className="text-sm font-semibold text-[var(--accent)]" href="#/applications">
                See all
              </Link>
            </div>
            <ul>
              {summary.recent.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-3">
                  <div>
                    <p className="font-medium">
                      {row.company} · {row.role}
                    </p>
                    <p className="text-sm text-[var(--muted)]">{row.date || 'No date'}</p>
                  </div>
                  <span className="text-sm">{row.bucket}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
