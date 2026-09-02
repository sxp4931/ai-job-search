# Local web UI

A small React dashboard for this repo. It reads and writes the same files the slash-command workflow already uses (`job_search_tracker.csv`, `seen_jobs.json`) and can run the portal CLIs.

It does **not** draft CVs or cover letters. That still happens with `/apply` in your coding assistant.

## Run it

From the repo root, in two terminals:

```bash
python3 tools/web_ui.py
```

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the Python process on port 8765.

To serve the UI from Python alone (no second process):

```bash
cd web && npm install && npm run build
python3 tools/web_ui.py
```

Then open http://127.0.0.1:8765.

The server binds to localhost only. Your tracker stays on this machine.

## What each page does

- **Home** — paste a job link or drop a resume, then counts, funnel, and what is due next
- **Search** — query an installed portal CLI; copy `/apply <url>` for your assistant
- **Jobs** — saved/scraped/pasted postings; Track adds a drafted application
- **Applications** — edit status and notes on the tracker CSV
- **Documents** — `documents/cv`, LinkedIn export, diplomas, references, pasted postings

## Everyday shortcuts

- Paste a job URL on a blank part of the page (not inside a field) to fetch it
- Drop a PDF/TeX/text file anywhere — resumes go to `documents/cv`, text to `documents/postings`
- `⌘K` / `Ctrl+K` opens a jump menu
- Boards that block automated reads fall back to “paste the posting text”
