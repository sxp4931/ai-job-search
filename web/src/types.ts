export type TrackerStatus =
  | 'drafted'
  | 'applied'
  | 'interview'
  | 'offer'
  | 'hired'
  | 'rejected'
  | 'no_response'
  | 'offer_declined'
  | 'withdrawn'

export type StatusBucket =
  | 'Drafted'
  | 'Active'
  | 'Interview'
  | 'Offer'
  | 'Hired'
  | 'Rejected/Closed'

export interface Application {
  id: string
  date: string
  company: string
  sector: string
  role: string
  role_type: string
  channel: string
  status: string
  status_normalized: string
  bucket: StatusBucket
  contact_person: string
  fit_rating: string
  notes: string
  cv_file: string
  cover_letter_file: string
  source: string
  deadline: string
}

export interface UntrackedJob {
  key: string
  title: string
  company: string
  url: string
  fit: string
  status: string
}

export interface Summary {
  total_rows: number
  sent: number
  drafted: number
  by_bucket: Record<StatusBucket, number>
  by_sector: Record<string, number>
  by_channel: Record<string, number>
  funnel: { applied: number; interview: number; offer: number; hired: number }
  rejection_rate: number | null
  past_resume_screen: number | null
  unrecognized_status: string[]
  deadlines: Array<{
    id: string
    company: string
    role: string
    deadline: string
    days: number
    urgent: boolean
    passed: boolean
    status: string
  }>
  recent: Application[]
  jobs_count: number
  untracked_count: number
  untracked_jobs: UntrackedJob[]
}

export interface Job {
  key: string
  title: string
  company: string
  url: string
  first_seen?: string
  deadline?: string | null
  posted_date?: string | null
  fit?: string
  status?: string
  portal?: string
  source?: string
  location?: string
  rank_score?: number
  rank_verdict?: string
}

export interface Portal {
  id: string
  name: string
  title: string
  enabled: boolean
  requires_location: boolean
  query_flag: string
  location_flag: string | null
  personal_use_warning: boolean
}

export interface SearchHit {
  id: string
  title: string
  company: string
  location: string
  date: string
  url: string
  deadline: string
  portal: string
}

export interface Profile {
  ready: boolean
  name: string
  location: string
  headline: string
  status: string
}

export type DocFolder = 'cv' | 'linkedin' | 'diplomas' | 'references' | 'postings'

export interface DocFile {
  folder: DocFolder
  name: string
  size: number
  modified: string
}

export interface DocArchive {
  folder: string
  files: string[]
}

export interface ImportResult {
  ok: boolean
  reason: string
  url?: string
  portal?: string
  message?: string
  job?: Job
  application?: Application
  posting_file?: string
  personal_use_warning?: boolean
  excerpt?: string
}

export type Page = 'home' | 'jobs' | 'search' | 'applications' | 'documents'
