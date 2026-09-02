import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Banner, Chip, CopyButton, Drawer, EmptyState, Modal, StatusBadge } from '../components/ui'
import { Link } from '../Link'
import { STATUS_OPTIONS, statusLabel } from '../status'
import { useUi } from '../ui-context'
import { applyCommand, deadlineTone, relativeDate } from '../util'
import type { Application } from '../types'

export function ApplicationsPage({ addRequest = 0 }: { addRequest?: number }) {
  const { toast, refresh } = useUi()
  const [rows, setRows] = useState<Application[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [seenAdd, setSeenAdd] = useState(addRequest)
  const [selected, setSelected] = useState<Application | null>(null)

  if (addRequest !== seenAdd) {
    setSeenAdd(addRequest)
    if (addRequest > 0) setOpen(true)
  }

  const load = () => api.applications().then(setRows).catch((err: Error) => setError(err.message))

  useEffect(() => {
    void load()
  }, [refresh])

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
      setSelected((current) => (current?.id === id ? updated : current))
      toast(`Marked ${statusLabel(next)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update', 'err')
    }
  }

  const buckets = ['all', 'Drafted', 'Active', 'Interview', 'Offer', 'Hired', 'Rejected/Closed'] as const

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Tracker</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">Applications</h1>
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
      </div>
      <div className="flex flex-wrap gap-2">
        {buckets.map((value) => (
          <Chip key={value} active={status === value} onClick={() => setStatus(value)}>
            {value === 'all' ? 'All' : value}
          </Chip>
        ))}
      </div>

      {error ? <Banner tone="err">{error}</Banner> : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No applications yet"
          body="Track a job from Search, paste a posting, or add one you already sent."
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
        <>
          <div className="card hidden overflow-x-auto md:block">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="sticky top-0 bg-[var(--surface)] text-[var(--muted)]">
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
                  <tr
                    key={row.id}
                    className="row-click border-t border-[var(--line)]"
                    onClick={() => setSelected(row)}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium">{row.company}</p>
                      <p className="text-xs text-[var(--muted)]">{relativeDate(row.date) || '—'}</p>
                    </td>
                    <td className="px-4 py-3">
                      {row.role}
                      {row.sector ? <span className="block text-xs text-[var(--muted)]">{row.sector}</span> : null}
                    </td>
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
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
                    <td className="px-4 py-3">
                      {row.deadline ? (
                        <span className={`deadline deadline-${deadlineTone(row.deadline) || 'ok'}`}>
                          {relativeDate(row.deadline)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
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

          <ul className="flex flex-col gap-3 md:hidden">
            {filtered.map((row) => (
              <li key={row.id}>
                <button className="card w-full p-4 text-left" onClick={() => setSelected(row)}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{row.company}</p>
                      <p className="text-sm text-[var(--muted)]">{row.role}</p>
                    </div>
                    <StatusBadge bucket={row.bucket} label={statusLabel(row.status_normalized)} />
                  </div>
                  {row.deadline ? (
                    <p className={`mt-2 text-sm deadline-${deadlineTone(row.deadline)}`}>
                      Due {relativeDate(row.deadline)}
                    </p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </>
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

      {selected ? (
        <ApplicationDrawer
          key={selected.id}
          row={selected}
          onClose={() => setSelected(null)}
          onChange={async (patch) => {
            const updated = await api.patchApplication(selected.id, patch)
            setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
            setSelected(updated)
          }}
          onStatus={(next) => void updateStatus(selected.id, next)}
        />
      ) : null}
    </div>
  )
}

function ApplicationDrawer({
  row,
  onClose,
  onChange,
  onStatus,
}: {
  row: Application
  onClose: () => void
  onChange: (patch: Record<string, string>) => Promise<void>
  onStatus: (next: string) => void
}) {
  const { toast } = useUi()
  const [notes, setNotes] = useState(row.notes)
  const [deadline, setDeadline] = useState(row.deadline)

  return (
    <Drawer title={`${row.company}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm text-[var(--muted)]">{row.role}</p>
          <div className="mt-2">
            <StatusBadge bucket={row.bucket} label={statusLabel(row.status_normalized)} />
          </div>
        </div>
        <label className="text-sm font-medium">
          Status
          <select
            className="field mt-1"
            value={row.status_normalized || 'applied'}
            onChange={(event) => onStatus(event.target.value)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Deadline
          <input
            className="field mt-1"
            type="date"
            value={deadline.slice(0, 10)}
            onChange={(event) => setDeadline(event.target.value)}
            onBlur={() => {
              if (deadline !== row.deadline) void onChange({ deadline })
            }}
          />
        </label>
        <label className="text-sm font-medium">
          Notes
          <textarea
            className="field mt-1 min-h-28"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => {
              if (notes !== row.notes) {
                void onChange({ notes }).then(() => toast('Notes saved'))
              }
            }}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {row.source.startsWith('http') ? (
            <>
              <a className="btn btn-ghost" href={row.source} target="_blank" rel="noreferrer">
                Open posting
              </a>
              <CopyButton text={applyCommand(row.source)} label="Copy /apply" />
            </>
          ) : null}
        </div>
        {row.cv_file || row.cover_letter_file ? (
          <p className="text-xs text-[var(--muted)]">
            {row.cv_file ? `CV: ${row.cv_file}` : ''}
            {row.cv_file && row.cover_letter_file ? ' · ' : ''}
            {row.cover_letter_file ? `Letter: ${row.cover_letter_file}` : ''}
          </p>
        ) : (
          <p className="text-xs text-[var(--muted)]">
            Tailored CV and cover letter still come from /apply in your coding assistant.
          </p>
        )}
      </div>
    </Drawer>
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
  const { toast } = useUi()

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const body = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
    setBusy(true)
    setError('')
    try {
      await api.createApplication(body)
      toast(`Added ${body.company}`)
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
        {error ? <Banner tone="err">{error}</Banner> : null}
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
