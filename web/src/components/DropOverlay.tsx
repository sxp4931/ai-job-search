import { FileUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useUi } from '../ui-context'
import { extractUrl, fileToBase64, guessFolder, isDroppableFile } from '../util'

export function DropOverlay() {
  const { toast, bump, openCapture } = useUi()
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Boolean(event.dataTransfer?.types.includes('Files') || event.dataTransfer?.types.includes('text/uri-list'))

    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current += 1
      setOver(true)
    }
    const overMove = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const drop = (event: DragEvent) => {
      event.preventDefault()
      depth.current = 0
      setOver(false)
      const uri = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || ''
      const url = extractUrl(uri)
      if (url && (!event.dataTransfer?.files || event.dataTransfer.files.length === 0)) {
        openCapture(url)
        return
      }
      const files = [...(event.dataTransfer?.files ?? [])].filter(isDroppableFile)
      if (files.length === 0) return
      void (async () => {
        try {
          for (const file of files) {
            await api.uploadDocument(guessFolder(file), file.name, await fileToBase64(file))
          }
          bump()
          toast(files.length === 1 ? `Saved ${files[0].name}` : `Saved ${files.length} files`)
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Could not save file', 'err')
        }
      })()
    }

    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', overMove)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', overMove)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [bump, openCapture, toast])

  if (!over) return null
  return (
    <div className="drop-veil" aria-hidden="true">
      <div className="drop-card">
        <FileUp className="size-8" />
        <p className="font-display text-xl font-semibold">Drop to add</p>
        <p className="text-sm text-[var(--muted)]">Resumes go to Documents. A job URL is fetched next.</p>
      </div>
    </div>
  )
}
