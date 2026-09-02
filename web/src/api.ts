import type {
  Application,
  DocArchive,
  DocFile,
  ImportResult,
  Job,
  Portal,
  Profile,
  SearchHit,
  Summary,
} from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const data: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : response.statusText
    throw new Error(message)
  }
  return data as T
}

export const api = {
  profile: () => request<Profile>('/api/profile'),
  summary: () => request<Summary>('/api/summary'),
  applications: () =>
    request<{ applications: Application[] }>('/api/applications').then((d) => d.applications),
  createApplication: (body: Record<string, string>) =>
    request<Application>('/api/applications', { method: 'POST', body: JSON.stringify(body) }),
  patchApplication: (id: string, body: Record<string, string>) =>
    request<Application>(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  jobs: (q = '') =>
    request<{ jobs: Job[] }>(`/api/jobs${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(
      (d) => d.jobs,
    ),
  saveJob: (body: Record<string, string>) =>
    request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  patchJob: (key: string, body: Record<string, string>) =>
    request<Job>('/api/jobs', { method: 'PATCH', body: JSON.stringify({ key, ...body }) }),
  trackJob: (key: string) =>
    request<Application>('/api/jobs/track', { method: 'POST', body: JSON.stringify({ key }) }),
  importFromUrl: (url: string, track = false) =>
    request<ImportResult>('/api/jobs/from-url', {
      method: 'POST',
      body: JSON.stringify({ url, track }),
    }),
  importFromText: (body: Record<string, string | boolean>) =>
    request<ImportResult>('/api/jobs/from-text', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  documents: () => request<{ files: DocFile[]; archives: DocArchive[] }>('/api/documents'),
  uploadDocument: (folder: string, name: string, content_b64: string) =>
    request<DocFile>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ folder, name, content_b64 }),
    }),
  deleteDocument: (folder: string, name: string) =>
    request<{ ok: boolean }>(
      `/api/documents?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  documentHref: (folder: string, name: string) =>
    `/api/documents/file?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`,
  portals: () => request<{ portals: Portal[] }>('/api/portals').then((d) => d.portals),
  search: (body: Record<string, string | number>) =>
    request<{ portal: string; count: number; results: SearchHit[] }>('/api/search', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}
