import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { EmptyState, Modal, StatusBadge } from '../components/ui'
import { Link } from '../Link'
import { STATUS_OPTIONS, statusLabel } from '../status'
import type { Application } from '../types'

export function ApplicationsPage() {
  const [rows, setRows] = useState<Application[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  const load = () => api.applications().then(setRows).catch((err: Error) => setError(err.message))

  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (status !== 'all' && row.status_normalized !== status && row.bucket !== status) return false
      if (!q) return true
      return `${row.company} ${row.role} ${row.sector} ${row.notes}`.toLowerCase().includes(q)
    })
  }, [rows, query, status])

  async function updateStatus(id: string, next: string) {
    setError('')
    try {
      const updated = await api.patchApplication(id, { status: next })
      setRows((current) => current.map((row) => (row.id === id ? updated : row)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Applications</h1>
          <p className="mt-1 text-[var(--muted)]">Status changes write back to job_search_tracker.csv.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          Add application
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          className="field max-w-sm"
          placeholder="Search company, role, notes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select className="field w-auto" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {error ? <p className="text-red-600">{error}</p> : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No applications yet"
          body="Track a job from Search, or add one you already sent."
          action={
            <div className="flex flex-wrap gap-2">
              <Link className="btn btn-primary" href="#/search">
                Search jobs
              </Link>
              <button className="btn btn-ghost" onClick={() => setOpen(true)}>
                Add by hand
              </button>
            </div>
          }
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Deadline</th>
                <th className="px-4 py-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-t border-[var(--line)]">
                  <td className="px-4 py-3">
                    <p className="font-medium">{row.company}</p>
                    <p className="text-xs text-[var(--muted)]">{row.date || '—'}</p>
                  </td>
                  <td className="px-4 py-3">
                    {row.role}
                    {row.sector ? <span className="block text-xs text-[var(--muted)]">{row.sector}</span> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-2">
                      <StatusBadge bucket={row.bucket} label={statusLabel(row.status_normalized)} />
                      <select
                        className="field py-1"
                        value={row.status_normalized || 'applied'}
                        onChange={(event) => void updateStatus(row.id, event.target.value)}
                      >
                        {STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-4 py-3">{row.deadline || '—'}</td>
                  <td className="px-4 py-3">
                    {row.source.startsWith('http') ? (
                      <a className="font-medium text-[var(--accent)]" href={row.source} target="_blank" rel="noreferrer">
                        Posting
                      </a>
                    ) : (
                      row.source || '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 ? <p className="p-4 text-[var(--muted)]">No rows match.</p> : null}
        </div>
      )}

      {open ? (
        <AddApplicationModal
          onClose={() => setOpen(false)}
          onCreated={async () => {
            setOpen(false)
            await load()
          }}
        />
      ) : null}
    </div>
  )
}

function AddApplicationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const body = Object.fromEntries(
      [...form.entries()].map(([key, value]) => [key, String(value)]),
    )
    setBusy(true)
    setError('')
    try {
      await api.createApplication(body)
      await onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add application" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
        <label className="text-sm font-medium">
          Company
          <input className="field mt-1" name="company" required />
        </label>
        <label className="text-sm font-medium">
          Role
          <input className="field mt-1" name="role" required />
        </label>
        <label className="text-sm font-medium">
          Status
          <select className="field mt-1" name="status" defaultValue="applied">
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Posting URL
          <input className="field mt-1" name="source" type="url" placeholder="https://" />
        </label>
        <label className="text-sm font-medium">
          Deadline
          <input className="field mt-1" name="deadline" type="date" />
        </label>
        {error ? <p className="text-red-600">{error}</p> : null}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
