import { FileText, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { Banner, Chip, EmptyState } from '../components/ui'
import { useUi } from '../ui-context'
import { fileToBase64, formatBytes, guessFolder, isDroppableFile, relativeDate } from '../util'
import type { DocArchive, DocFile, DocFolder } from '../types'

const FOLDERS: Array<{ id: DocFolder | 'all'; label: string; hint: string }> = [
  { id: 'all', label: 'All', hint: '' },
  { id: 'cv', label: 'CVs', hint: 'PDF or TeX' },
  { id: 'linkedin', label: 'LinkedIn', hint: 'Profile PDF' },
  { id: 'diplomas', label: 'Diplomas', hint: 'PDF' },
  { id: 'references', label: 'References', hint: 'PDF, txt, md' },
  { id: 'postings', label: 'Postings', hint: 'Pasted job ads' },
]

export function DocumentsPage() {
  const { toast, refresh, bump } = useUi()
  const [files, setFiles] = useState<DocFile[]>([])
  const [archives, setArchives] = useState<DocArchive[]>([])
  const [folder, setFolder] = useState<DocFolder | 'all'>('all')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const load = () =>
    api
      .documents()
      .then((data) => {
        setFiles(data.files)
        setArchives(data.archives)
      })
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    void load()
  }, [refresh])

  const visible = useMemo(
    () => (folder === 'all' ? files : files.filter((file) => file.folder === folder)),
    [files, folder],
  )

  async function upload(list: File[]) {
    const usable = list.filter(isDroppableFile)
    if (usable.length === 0) {
      toast('Use PDF, TeX, or a text posting', 'err')
      return
    }
    try {
      for (const file of usable) {
        const chosen = folder !== 'all' ? folder : guessFolder(file)
        await api.uploadDocument(chosen, file.name, await fileToBase64(file))
      }
      bump()
      toast(usable.length === 1 ? `Saved ${usable[0].name}` : `Saved ${usable.length} files`)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save file', 'err')
    }
  }

  async function remove(file: DocFile) {
    if (!window.confirm(`Delete ${file.name} from documents/${file.folder}?`)) return
    try {
      await api.deleteDocument(file.folder, file.name)
      bump()
      toast(`Removed ${file.name}`)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete', 'err')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="eyebrow">Library</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Documents</h1>
        <p className="mt-1 text-[var(--muted)]">
          Drop a resume here for /setup. Pasted job ads go to postings, the same folder the assistant already reads.
        </p>
      </div>

      <div className="capture-hero">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">Drop files anywhere on this page</p>
            <p className="text-sm text-[var(--muted)]">
              {folder === 'all' ? 'PDFs become CVs unless the name says LinkedIn. Text files become postings.' : `Saving into documents/${folder}`}
            </p>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" />
            Choose files
          </button>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            multiple
            accept=".pdf,.tex,.txt,.md,application/pdf,text/plain"
            onChange={(event) => {
              void upload([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FOLDERS.map((item) => (
          <Chip key={item.id} active={folder === item.id} onClick={() => setFolder(item.id)}>
            {item.label}
          </Chip>
        ))}
      </div>

      {error ? <Banner tone="err">{error}</Banner> : null}

      {visible.length === 0 ? (
        <EmptyState
          title="This folder is empty"
          body="Drop your master CV here. /setup reads documents/cv the next time you run it."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((file) => (
            <li key={`${file.folder}/${file.name}`} className="card flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="size-5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
                <div className="min-w-0">
                  <a
                    className="font-medium hover:underline"
                    href={api.documentHref(file.folder, file.name)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {file.name}
                  </a>
                  <p className="text-xs text-[var(--muted)]">
                    documents/{file.folder} · {formatBytes(file.size)}
                    {file.modified ? ` · ${relativeDate(file.modified.slice(0, 10))}` : ''}
                  </p>
                </div>
              </div>
              <button className="btn btn-ghost" onClick={() => void remove(file)} aria-label={`Delete ${file.name}`}>
                <Trash2 className="size-4" />
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {archives.length > 0 ? (
        <section>
          <h2 className="mb-3 font-display font-semibold">Application archives</h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {archives.map((item) => (
              <li key={item.folder} className="card p-4">
                <p className="font-medium">{item.folder}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {item.files.length ? item.files.join(' · ') : 'Empty folder'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
