import { FileUp, Link2, LoaderCircle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { useUi, type PastePrefill } from '../ui-context'
import { applyCommand, extractUrl } from '../util'
import { Banner, CopyButton, Modal } from './ui'

export function CaptureBar() {
  const { openCapture } = useUi()
  const [value, setValue] = useState('')

  return (
    <form
      className="capture-bar"
      onSubmit={(event) => {
        event.preventDefault()
        const url = extractUrl(value)
        if (!url) return
        openCapture(url)
        setValue('')
      }}
    >
      <Link2 className="size-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
      <input
        className="capture-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste a job link…"
        aria-label="Job posting URL"
      />
      <button className="btn btn-primary px-3 py-1.5 text-sm" type="submit" disabled={!extractUrl(value)}>
        Add
      </button>
    </form>
  )
}

export function CaptureHero() {
  const { openCapture, toast } = useUi()
  const [value, setValue] = useState('')

  return (
    <div className="capture-hero">
      <div className="flex items-start gap-3">
        <div className="capture-icon">
          <FileUp className="size-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold">Drop a resume or paste a job link</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            PDFs go to Documents. A posting URL is fetched with the same portal tools as /scrape.
            If the board blocks it, paste the text.
          </p>
        </div>
      </div>
      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          const url = extractUrl(value)
          if (!url) {
            toast('That does not look like a link', 'err')
            return
          }
          openCapture(url)
          setValue('')
        }}
      >
        <input
          className="field flex-1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="https://linkedin.com/jobs/view/… or any job board URL"
          aria-label="Job posting URL"
        />
        <button className="btn btn-primary" type="submit">
          Fetch posting
        </button>
      </form>
    </div>
  )
}

export function CaptureModal({
  initialUrl,
  onClose,
}: {
  initialUrl: string
  onClose: () => void
}) {
  const { toast, bump, openPaste } = useUi()
  const [url, setUrl] = useState(initialUrl)
  const [track, setTrack] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run(nextUrl = url) {
    const found = extractUrl(nextUrl)
    if (!found) {
      setError('Need a web URL')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api.importFromUrl(found, track)
      if (!result.ok) {
        openPaste({ url: result.url || found, message: result.message })
        onClose()
        return
      }
      bump()
      const name = result.job ? `${result.job.company} · ${result.job.title}` : 'Job'
      toast(track ? `Tracking ${name}` : `Saved ${name}`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fetch that posting')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add from a job link" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <label className="text-sm font-medium">
          Posting URL
          <input
            className="field mt-1"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoFocus={!initialUrl}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={track} onChange={(event) => setTrack(event.target.checked)} />
          Also add to Applications as drafted
        </label>
        {error ? <Banner tone="err">{error}</Banner> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {busy ? 'Fetching…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PasteModal({
  prefill,
  onClose,
}: {
  prefill: PastePrefill
  onClose: () => void
}) {
  const { toast, bump } = useUi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [track, setTrack] = useState(true)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const result = await api.importFromText({
        company: String(form.get('company') || ''),
        role: String(form.get('role') || ''),
        text: String(form.get('text') || ''),
        url: String(form.get('url') || ''),
        track,
      })
      bump()
      const name = result.job ? `${result.job.company} · ${result.job.title}` : 'Posting'
      toast(`Saved ${name} to Documents`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const url = prefill.url || ''

  return (
    <Modal title="Paste the posting" onClose={onClose} wide>
      {prefill.message ? <Banner>{prefill.message}</Banner> : null}
      <p className="mb-3 text-sm text-[var(--muted)]">
        Many boards block automated reads. Paste the full posting. It lands in documents/postings,
        same as the drop folder /apply already uses.
      </p>
      <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Company
            <input className="field mt-1" name="company" required defaultValue={prefill.company} />
          </label>
          <label className="text-sm font-medium">
            Role
            <input className="field mt-1" name="role" required defaultValue={prefill.role} />
          </label>
        </div>
        <label className="text-sm font-medium">
          Posting URL
          <input className="field mt-1" name="url" defaultValue={url} placeholder="https://" />
        </label>
        <label className="text-sm font-medium">
          Full posting text
          <textarea
            className="field mt-1 min-h-44 font-normal"
            name="text"
            required
            placeholder="Paste the job ad here"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={track} onChange={(event) => setTrack(event.target.checked)} />
          Also add to Applications as drafted
        </label>
        {error ? <Banner tone="err">{error}</Banner> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {url ? <CopyButton text={applyCommand(url)} label="Copy /apply" /> : <span />}
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save posting'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
