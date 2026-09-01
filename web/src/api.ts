import type { Application, Job, Portal, Profile, SearchHit, Summary } from './types'

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
  portals: () => request<{ portals: Portal[] }>('/api/portals').then((d) => d.portals),
  search: (body: Record<string, string | number>) =>
    request<{ portal: string; count: number; results: SearchHit[] }>('/api/search', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}
