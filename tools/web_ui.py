#!/usr/bin/env python3
"""Local web UI for the job-search tracker, scraped jobs, and portal search.

This is a presentation layer over the files the slash-command workflow already
uses. It does not draft CVs, score fit, or replace /apply, /rank, or /interview.
Paste-a-link uses each portal CLI's ``detail`` command; dropped resumes land in
``documents/``.

Binds to 127.0.0.1 only: the tracker and seen-jobs files are personal data.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable, TextIO
from urllib.parse import parse_qs, unquote, urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent

# Canonical tracker header — identical to /apply and /outcome Step 1.1.
# tests/test_web_ui.py pins this string to those specs so a column addition fails here.
TRACKER_HEADER = (
    "date,company,sector,role,role_type,channel,status,contact_person,"
    "fit_rating,notes,cv_file,cover_letter_file,source,deadline"
)
TRACKER_FIELDS = TRACKER_HEADER.split(",")

CANONICAL_STATUSES = (
    "drafted",
    "applied",
    "interview",
    "offer",
    "hired",
    "rejected",
    "no_response",
    "offer_declined",
    "withdrawn",
)
FINAL_STATUSES = frozenset(
    {"hired", "rejected", "no_response", "offer_declined", "withdrawn"}
)
STATUS_BUCKETS = (
    "Drafted",
    "Active",
    "Interview",
    "Offer",
    "Hired",
    "Rejected/Closed",
)

# add-portal default is --query. Named portals that differ are listed here.
QUERY_FLAG_BY_PORTAL = {
    "jobnet-search": "--search-string",
    "jobbank-search": "--key",
    "jobdanmark-search": "--text",
}
LOCATION_FLAG_BY_PORTAL = {
    "linkedin-search": "--location",
    "jobdanmark-search": "--municipality",
}
JOBAGE_FLAG_BY_PORTAL = {
    "linkedin-search": "--jobage",
    "freehire-search": "--jobage",
    "jobindex-search": "--jobage",
    "jobbank-search": "--since",
}
REQUIRES_LOCATION = frozenset({"linkedin-search"})

PORTAL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
MAX_BODY = 1_000_000
MAX_UPLOAD = 12_000_000
MAX_POSTING_CHARS = 400_000
SEARCH_TIMEOUT_SEC = 90
DETAIL_TIMEOUT_SEC = 90
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

# Host suffix → portal id. Only used when that portal skill is installed.
PORTAL_HOST_SUFFIXES = (
    ("linkedin.com", "linkedin-search"),
    ("jobindex.dk", "jobindex-search"),
    ("jobbank.dk", "jobbank-search"),
    ("jobnet.dk", "jobnet-search"),
    ("jobdanmark.dk", "jobdanmark-search"),
    ("freehire.me", "freehire-search"),
)

DOC_FOLDERS: dict[str, frozenset[str]] = {
    "cv": frozenset({".pdf", ".tex"}),
    "linkedin": frozenset({".pdf"}),
    "diplomas": frozenset({".pdf"}),
    "references": frozenset({".pdf", ".txt", ".md"}),
    "postings": frozenset({".txt", ".md"}),
}

URL_IN_TEXT = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
FILE_TYPES = {
    ".pdf": "application/pdf",
    ".tex": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}

Runner = Callable[..., subprocess.CompletedProcess]


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def utc_today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def normalize_status(raw: str | None) -> str:
    value = (raw or "").strip().lower().replace(" ", "_")
    return value


def status_bucket(raw: str | None) -> str:
    value = normalize_status(raw)
    return {
        "drafted": "Drafted",
        "applied": "Active",
        "interview": "Interview",
        "offer": "Offer",
        "hired": "Hired",
        "rejected": "Rejected/Closed",
        "no_response": "Rejected/Closed",
        "offer_declined": "Rejected/Closed",
        "withdrawn": "Rejected/Closed",
    }.get(value, "Rejected/Closed")


def archive_folder_name(company: str, role: str) -> str:
    """documents/README.md Subfolder naming rule.

    Lowercase, spaces become underscores, every other non-alphanumeric character
    is dropped, underscore runs collapse, then trim.
    """
    raw = f"{company}_{role}".lower().replace(" ", "_")
    cleaned = "".join(ch for ch in raw if ch.isalnum() or ch == "_")
    return re.sub(r"_+", "_", cleaned).strip("_")


def row_id(row: dict[str, str], index: int) -> str:
    basis = "|".join(
        (
            (row.get("source") or "").strip(),
            (row.get("company") or "").strip().lower(),
            (row.get("role") or "").strip().lower(),
            (row.get("date") or "").strip(),
            str(index),
        )
    )
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


_STAGE_HEADING = re.compile(r"^## Interview stages reached\s*$", re.M)
_CHECKED_ITEM = re.compile(r"^- \[[xX]\]\s*(.+?)\s*$", re.M)
_INTERVIEW_STAGE_LABELS = (
    "phone screen",
    "technical interview",
    "case interview",
    "final round",
)
_OFFER_STAGE_LABEL = "offer received"


def parse_outcome_stages(text: str) -> tuple[bool, bool]:
    """Return (reached_interview, reached_offer) from an outcome.md file.

    Only checkboxes under ``## Interview stages reached`` count, matching
    /html-report Step 2: history, not just the current tracker status.
    """
    heading = _STAGE_HEADING.search(text)
    if heading is None:
        section = text
    else:
        rest = text[heading.end() :]
        nxt = re.search(r"^## ", rest, re.M)
        section = rest[: nxt.start()] if nxt else rest
    interview = False
    offer = False
    for match in _CHECKED_ITEM.finditer(section):
        label = match.group(1).strip().lower()
        if label.startswith(_OFFER_STAGE_LABEL):
            offer = True
            interview = True
        elif any(label.startswith(name) for name in _INTERVIEW_STAGE_LABELS):
            interview = True
    return interview, offer


def parse_jobage_days(payload: dict[str, Any]) -> int | None:
    jobage = payload.get("jobage")
    if jobage in (None, "", 0, "0"):
        return None
    try:
        days = int(jobage)
    except (TypeError, ValueError) as exc:
        raise ApiError(400, "jobage must be a whole number of days") from exc
    if days < 1:
        raise ApiError(400, "jobage must be >= 1")
    return days


def within_jobage(raw_date: Any, days: int, *, today: date | None = None) -> bool:
    """Keep results whose posted date is within ``days``, or whose date is unknown.

    Matches /scrape Step 1b: drop only dates that parse and are older than the
    window. A missing date is not inferred as stale.
    """
    if raw_date in (None, ""):
        return True
    text = str(raw_date).strip()[:10]
    try:
        posted = date.fromisoformat(text)
    except ValueError:
        return True
    cutoff = (today or datetime.now(timezone.utc).date()) - timedelta(days=days)
    return posted >= cutoff


def first_url(text: str) -> str:
    """Pull the first http(s) URL out of pasted text (or the whole string)."""
    raw = (text or "").strip()
    if not raw:
        raise ApiError(400, "url is required")
    if re.match(r"^https?://", raw, re.I):
        candidate = raw.split()[0]
    else:
        match = URL_IN_TEXT.search(raw)
        if match is None:
            raise ApiError(400, "no URL found in that text")
        candidate = match.group(0)
    return candidate.rstrip(".,);]")


def portal_for_host(url: str) -> str | None:
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    for suffix, portal_id in PORTAL_HOST_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            return portal_id
    return None


def detail_argument(portal_id: str, url: str) -> str:
    """Map a browser URL to the argument each portal's detail command expects."""
    path = urlparse(url).path.rstrip("/")
    if portal_id == "jobbank-search":
        match = re.search(r"/job/(\d+)", path)
        return match.group(1) if match else url
    if portal_id == "jobnet-search":
        match = re.search(r"/find-job/([^/]+)", path) or re.search(r"/job/([^/]+)", path)
        return match.group(1) if match else url
    if portal_id == "jobdanmark-search":
        match = re.search(r"/job/([^/]+)", path)
        return match.group(1) if match else url
    return url


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _plain_text(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def normalize_detail(portal_id: str, data: dict[str, Any], fallback_url: str) -> dict[str, str]:
    employer = data.get("employer") if isinstance(data.get("employer"), dict) else {}
    hiring = data.get("hiringOrganization") if isinstance(data.get("hiringOrganization"), dict) else {}
    application = data.get("application") if isinstance(data.get("application"), dict) else {}
    job = data.get("job") if isinstance(data.get("job"), dict) else {}
    address = job.get("address") if isinstance(job.get("address"), dict) else {}
    loc = data.get("jobLocation") if isinstance(data.get("jobLocation"), dict) else {}
    loc_addr = loc.get("address") if isinstance(loc.get("address"), dict) else loc

    def loc_field(key: str) -> str:
        if isinstance(loc_addr, dict):
            return _as_str(loc_addr.get(key))
        return ""

    title = _as_str(data.get("title"))
    company = (
        _as_str(data.get("company"))
        or _as_str(employer.get("name"))
        or _as_str(hiring.get("name"))
    )
    location = (
        _as_str(data.get("location"))
        or _as_str(address.get("city"))
        or loc_field("addressLocality")
        or _as_str(loc.get("streetAddress") if isinstance(loc, dict) else "")
    )
    url = _as_str(data.get("url")) or fallback_url
    deadline = (
        _as_str(data.get("deadline"))
        or _as_str(data.get("validThrough"))
        or _as_str(application.get("deadlineDate"))
    )[:10]
    posted = (
        _as_str(data.get("date"))
        or _as_str(data.get("datePosted"))
        or _as_str(data.get("publicationDateTime"))
        or _as_str(data.get("posted_date"))
    )[:10]
    description = _plain_text(_as_str(data.get("description")) or _as_str(data.get("body")))
    job_id = _as_str(data.get("id")) or _as_str(data.get("slug"))
    if not title:
        raise ApiError(502, "portal detail did not include a job title")
    return {
        "id": job_id,
        "title": title,
        "company": company,
        "location": location,
        "url": url,
        "deadline": deadline,
        "date": posted,
        "description": description,
        "portal": portal_id,
    }


def safe_filename(name: str) -> str:
    raw = name or ""
    if "/" in raw.replace("\\", "/"):
        raise ApiError(400, "filename cannot include a path")
    base = Path(raw).name
    cleaned = "".join(ch for ch in base if ch.isalnum() or ch in "._- ()[]").strip(" .")
    if not cleaned or cleaned in {".", ".."}:
        raise ApiError(400, "invalid filename")
    if len(cleaned) > 180:
        stem = Path(cleaned).stem[:160]
        suffix = Path(cleaned).suffix[:20]
        cleaned = f"{stem}{suffix}".strip(" .")
        if not cleaned:
            raise ApiError(400, "invalid filename")
    return cleaned


def decode_b64(raw: str) -> bytes:
    text = (raw or "").strip()
    if not text:
        raise ApiError(400, "file content is required")
    if "," in text and text.lower().startswith("data:"):
        text = text.split(",", 1)[1]
    try:
        data = base64.b64decode(text, validate=False)
    except Exception as exc:
        raise ApiError(400, "invalid file encoding") from exc
    if not data:
        raise ApiError(400, "file is empty")
    if len(data) > MAX_UPLOAD:
        raise ApiError(413, "file is too large (12 MB max)")
    return data


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        tmp_path.replace(path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _atomic_write_text(path: Path, write: Callable[[TextIO], None]) -> None:
    """Write via a unique temp file in the same directory, then replace.

    Unique names stop overlapping handlers from sharing one ``.tmp`` path.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            write(handle)
        tmp_path.replace(path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def parse_frontmatter(text: str) -> dict[str, Any]:
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    data: dict[str, Any] = {}
    for line in parts[1].splitlines():
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        key = key.strip()
        if not key or key.startswith("#"):
            continue
        value = raw.split("#", 1)[0].strip().strip('"').strip("'")
        if value.lower() in {"true", "false"}:
            data[key] = value.lower() == "true"
        else:
            data[key] = value
    return data


def _json_load(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise ApiError(500, f"{path.name} is not valid JSON")


class Store:
    def __init__(self, root: Path, runner: Runner | None = None):
        self.root = root
        self.runner = runner or subprocess.run
        self._lock = threading.RLock()

    def tracker_path(self) -> Path:
        return self.root / "job_search_tracker.csv"

    def seen_jobs_path(self, *, create_parent: bool = False) -> Path:
        skill_path = (
            self.root
            / ".claude"
            / "skills"
            / "job-scraper"
            / "job_scraper"
            / "seen_jobs.json"
        )
        root_path = self.root / "job_scraper" / "seen_jobs.json"
        if skill_path.exists():
            return skill_path
        if root_path.exists():
            return root_path
        if create_parent:
            skill_path.parent.mkdir(parents=True, exist_ok=True)
        return skill_path

    def read_tracker(self) -> list[dict[str, str]]:
        path = self.tracker_path()
        if not path.exists():
            return []
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            rows: list[dict[str, str]] = []
            for index, raw in enumerate(reader):
                row = {field: (raw.get(field) or "").strip() for field in TRACKER_FIELDS}
                # Preserve unknown extra columns so a future header addition is not wiped.
                for key, value in raw.items():
                    if key and key not in row:
                        row[key] = (value or "").strip()
                row["id"] = row_id(row, index)
                row["status_normalized"] = normalize_status(row.get("status"))
                row["bucket"] = status_bucket(row.get("status"))
                rows.append(row)
            return rows

    def write_tracker(self, rows: Iterable[dict[str, str]]) -> None:
        path = self.tracker_path()
        fieldnames = list(TRACKER_FIELDS)
        materialised = list(rows)
        extra: list[str] = []
        for row in materialised:
            for key in row:
                if (
                    key not in fieldnames
                    and key not in extra
                    and key not in {"id", "status_normalized", "bucket"}
                ):
                    extra.append(key)
        fieldnames.extend(extra)

        def _write(handle: TextIO) -> None:
            writer = csv.DictWriter(
                handle,
                fieldnames=fieldnames,
                extrasaction="ignore",
                lineterminator="\n",
            )
            writer.writeheader()
            for row in materialised:
                writer.writerow({key: row.get(key, "") for key in fieldnames})

        _atomic_write_text(path, _write)

    def create_application(self, payload: dict[str, Any]) -> dict[str, str]:
        with self._lock:
            return self._create_application_unlocked(payload)

    def _create_application_unlocked(self, payload: dict[str, Any]) -> dict[str, str]:
        company = str(payload.get("company") or "").strip()
        role = str(payload.get("role") or "").strip()
        if not company or not role:
            raise ApiError(400, "company and role are required")
        status = normalize_status(str(payload.get("status") or "drafted"))
        if status not in CANONICAL_STATUSES:
            raise ApiError(400, f"unknown status {status!r}")
        rows = self.read_tracker()
        row = {field: "" for field in TRACKER_FIELDS}
        row.update(
            {
                "date": str(payload.get("date") or utc_today()),
                "company": company,
                "sector": str(payload.get("sector") or "").strip(),
                "role": role,
                "role_type": str(payload.get("role_type") or "").strip(),
                "channel": str(payload.get("channel") or "").strip(),
                "status": status,
                "contact_person": str(payload.get("contact_person") or "").strip(),
                "fit_rating": str(payload.get("fit_rating") or "").strip(),
                "notes": str(payload.get("notes") or "").strip(),
                "cv_file": str(payload.get("cv_file") or "").strip(),
                "cover_letter_file": str(payload.get("cover_letter_file") or "").strip(),
                "source": str(payload.get("source") or "").strip(),
                "deadline": str(payload.get("deadline") or "").strip(),
            }
        )
        rows.append(row)
        self.write_tracker(rows)
        created = self.read_tracker()[-1]
        return created

    def patch_application(self, app_id: str, payload: dict[str, Any]) -> dict[str, str]:
        with self._lock:
            rows = self.read_tracker()
            index = next((i for i, row in enumerate(rows) if row["id"] == app_id), None)
            if index is None:
                raise ApiError(404, "application not found")
            match = rows[index]
            writable = {
                "date",
                "company",
                "sector",
                "role",
                "role_type",
                "channel",
                "status",
                "contact_person",
                "fit_rating",
                "notes",
                "cv_file",
                "cover_letter_file",
                "source",
                "deadline",
            }
            for key, value in payload.items():
                if key not in writable:
                    continue
                text = str(value).strip() if value is not None else ""
                if key == "status":
                    text = normalize_status(text)
                    if text not in CANONICAL_STATUSES:
                        raise ApiError(400, f"unknown status {text!r}")
                match[key] = text
            self.write_tracker(rows)
            # Identity fields feed row_id(); look up by stable index so a
            # company/role/date/source edit does not 500 after a successful write.
            return self.read_tracker()[index]

    def _outcome_stages(self, company: str, role: str) -> tuple[bool, bool]:
        folder = archive_folder_name(company, role)
        if not folder:
            return False, False
        path = self.root / "documents" / "applications" / folder / "outcome.md"
        if not path.exists():
            return False, False
        return parse_outcome_stages(path.read_text(encoding="utf-8"))

    def summary(self) -> dict[str, Any]:
        rows = self.read_tracker()
        by_bucket = {name: 0 for name in STATUS_BUCKETS}
        by_sector: dict[str, int] = {}
        by_channel: dict[str, int] = {}
        unrecognized: list[str] = []
        for row in rows:
            raw = (row.get("status") or "").strip()
            if raw and normalize_status(raw) not in CANONICAL_STATUSES and normalize_status(
                raw
            ) not in {"no response", "offer declined"}:
                if raw not in unrecognized:
                    unrecognized.append(raw)
            bucket = row["bucket"]
            by_bucket[bucket] = by_bucket.get(bucket, 0) + 1
        submitted = [row for row in rows if row["bucket"] != "Drafted"]
        for row in submitted:
            sector = row.get("sector") or "Unspecified"
            channel = row.get("channel") or "Unspecified"
            by_sector[sector] = by_sector.get(sector, 0) + 1
            by_channel[channel] = by_channel.get(channel, 0) + 1

        def reached(stage: str) -> int:
            count = 0
            for row in submitted:
                bucket = row["bucket"]
                status = row["status_normalized"]
                interview_hist, offer_hist = self._outcome_stages(row["company"], row["role"])
                if stage == "applied":
                    count += 1
                elif stage == "interview":
                    if (
                        bucket in {"Interview", "Offer", "Hired"}
                        or status == "offer_declined"
                        or interview_hist
                        or offer_hist
                    ):
                        count += 1
                elif stage == "offer":
                    if bucket in {"Offer", "Hired"} or status == "offer_declined" or offer_hist:
                        count += 1
                elif stage == "hired":
                    if bucket == "Hired":
                        count += 1
            return count

        funnel = {
            "applied": reached("applied"),
            "interview": reached("interview"),
            "offer": reached("offer"),
            "hired": reached("hired"),
        }
        finals = [
            row
            for row in submitted
            if row["status_normalized"] in FINAL_STATUSES
        ]
        true_rejections = [
            row
            for row in finals
            if row["status_normalized"] in {"rejected", "no_response"}
        ]
        rejection_rate = (
            round(100 * len(true_rejections) / len(finals), 1) if finals else None
        )
        progressed = funnel["applied"]
        past_screen = (
            round(100 * funnel["interview"] / progressed, 1) if progressed else None
        )
        today = datetime.now(timezone.utc).date()
        deadlines = []
        for row in rows:
            raw = (row.get("deadline") or "").strip()
            if not raw:
                continue
            try:
                due = date.fromisoformat(raw[:10])
            except ValueError:
                continue
            delta = (due - today).days
            deadlines.append(
                {
                    "id": row["id"],
                    "company": row["company"],
                    "role": row["role"],
                    "deadline": raw[:10],
                    "days": delta,
                    "urgent": delta <= 7,
                    "passed": delta < 0,
                    "status": row["status_normalized"],
                }
            )
        deadlines.sort(key=lambda item: item["deadline"])
        jobs = self.read_jobs()
        hidden = {"tracked", "skipped", "expired"}
        untracked = [
            {
                "key": job.get("key"),
                "title": job.get("title") or "",
                "company": job.get("company") or "",
                "url": job.get("url") or "",
                "fit": job.get("fit") or "",
                "status": job.get("status") or "new",
            }
            for job in jobs
            if (job.get("status") or "new") not in hidden
        ]
        return {
            "total_rows": len(rows),
            "sent": len(submitted),
            "drafted": by_bucket["Drafted"],
            "by_bucket": by_bucket,
            "by_sector": dict(sorted(by_sector.items(), key=lambda kv: (-kv[1], kv[0]))),
            "by_channel": dict(sorted(by_channel.items(), key=lambda kv: (-kv[1], kv[0]))),
            "funnel": funnel,
            "rejection_rate": rejection_rate,
            "past_resume_screen": past_screen,
            "unrecognized_status": unrecognized,
            "deadlines": deadlines[:12],
            "recent": sorted(
                rows,
                key=lambda row: (row.get("date") or "", row.get("company") or ""),
                reverse=True,
            )[:8],
            "jobs_count": len(jobs),
            "untracked_count": len(untracked),
            "untracked_jobs": untracked[:6],
        }

    def read_jobs(self) -> list[dict[str, Any]]:
        data = _json_load(self.seen_jobs_path(), {"seen": {}})
        seen = data.get("seen") if isinstance(data, dict) else None
        if not isinstance(seen, dict):
            return []
        jobs: list[dict[str, Any]] = []
        for key, entry in seen.items():
            if not isinstance(entry, dict):
                continue
            job = dict(entry)
            job["key"] = key
            jobs.append(job)
        jobs.sort(
            key=lambda job: (
                str(job.get("first_seen") or ""),
                str(job.get("company") or ""),
            ),
            reverse=True,
        )
        return jobs

    def write_jobs(self, jobs: list[dict[str, Any]]) -> None:
        path = self.seen_jobs_path(create_parent=True)
        seen: dict[str, Any] = {}
        for job in jobs:
            entry = dict(job)
            key = str(entry.pop("key"))
            seen[key] = entry
        payload = {"seen": seen}
        existing = _json_load(path, {"seen": {}}) if path.exists() else {"seen": {}}
        if isinstance(existing, dict):
            for extra_key, extra_val in existing.items():
                if extra_key != "seen":
                    payload[extra_key] = extra_val
        payload_text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
        _atomic_write_text(path, lambda handle: handle.write(payload_text))

    def save_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            title = str(payload.get("title") or "").strip()
            company = str(payload.get("company") or "").strip()
            url = str(payload.get("url") or "").strip()
            if not title or not url:
                raise ApiError(400, "title and url are required")
            key = url or f"{company}_{title}".lower()
            jobs = self.read_jobs()
            existing = next((job for job in jobs if job["key"] == key or job.get("url") == url), None)
            entry = existing or {"key": key}
            entry.update(
                {
                    "title": title,
                    "company": company,
                    "url": url,
                    "first_seen": entry.get("first_seen") or utc_today(),
                    "deadline": payload.get("deadline") if "deadline" in payload else entry.get("deadline"),
                    "posted_date": payload.get("posted_date")
                    if "posted_date" in payload
                    else payload.get("date")
                    if "date" in payload
                    else entry.get("posted_date"),
                    "fit": payload.get("fit") or entry.get("fit") or "",
                    "status": payload.get("status") or entry.get("status") or "new",
                    "portal": payload.get("portal") or entry.get("portal") or "",
                    "source": payload.get("source") or entry.get("source") or "cli",
                    "location": payload.get("location") or entry.get("location") or "",
                }
            )
            if existing is None:
                jobs.append(entry)
            self.write_jobs(jobs)
            return entry

    def patch_job(self, key: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            jobs = self.read_jobs()
            match = next((job for job in jobs if job["key"] == key), None)
            if match is None:
                raise ApiError(404, "job not found")
            for field in ("status", "fit", "deadline", "notes"):
                if field in payload and payload[field] is not None:
                    match[field] = payload[field]
            self.write_jobs(jobs)
            return match

    def track_job(self, key: str) -> dict[str, str]:
        with self._lock:
            jobs = self.read_jobs()
            job = next((item for item in jobs if item["key"] == key), None)
            if job is None:
                raise ApiError(404, "job not found")
            company = str(job.get("company") or "").strip() or "Unknown company"
            role = str(job.get("title") or "").strip() or "Unknown role"
            source = str(job.get("url") or "")
            existing = next(
                (
                    row
                    for row in self.read_tracker()
                    if row["company"].lower() == company.lower()
                    and row["role"].lower() == role.lower()
                ),
                None,
            )
            if existing:
                return existing
            created = self._create_application_unlocked(
                {
                    "company": company,
                    "role": role,
                    "source": source,
                    "channel": str(job.get("portal") or "web-ui"),
                    "deadline": job.get("deadline") or "",
                    "status": "drafted",
                    "notes": "Tracked from web UI",
                }
            )
            job["status"] = "tracked"
            self.write_jobs(jobs)
            return created

    def list_portals(self) -> list[dict[str, Any]]:
        skills_root = self.root / ".agents" / "skills"
        if not skills_root.exists():
            return []
        portals: list[dict[str, Any]] = []
        for skill_md in sorted(skills_root.glob("*/SKILL.md")):
            cli = skill_md.parent / "cli" / "src" / "cli.ts"
            if not cli.exists():
                continue
            text = skill_md.read_text(encoding="utf-8")
            meta = parse_frontmatter(text)
            name = str(meta.get("name") or skill_md.parent.name)
            enabled = meta.get("enabled")
            if enabled is None:
                enabled = True
            heading = re.search(r"^#\s+(.+)$", text, re.M)
            portals.append(
                {
                    "id": skill_md.parent.name,
                    "name": name,
                    "title": heading.group(1).strip() if heading else name,
                    "enabled": bool(enabled),
                    "requires_location": skill_md.parent.name in REQUIRES_LOCATION,
                    "query_flag": QUERY_FLAG_BY_PORTAL.get(skill_md.parent.name, "--query"),
                    "location_flag": LOCATION_FLAG_BY_PORTAL.get(skill_md.parent.name),
                    "personal_use_warning": "Personal use only" in text,
                }
            )
        return portals

    def build_search_argv(
        self, portal_id: str, payload: dict[str, Any]
    ) -> list[str]:
        if not PORTAL_NAME_RE.match(portal_id):
            raise ApiError(400, "invalid portal id")
        portal_dir = self.root / ".agents" / "skills" / portal_id
        cli = portal_dir / "cli" / "src" / "cli.ts"
        if not cli.exists():
            raise ApiError(404, f"portal {portal_id} is not installed")
        bun = shutil.which("bun") or "bun"
        query = str(payload.get("query") or "").strip()
        location = str(payload.get("location") or "").strip()
        if portal_id in REQUIRES_LOCATION and not location:
            raise ApiError(400, "LinkedIn search needs a location (city, country, or Remote)")
        argv = [bun, "run", str(cli), "search", "--format", "json"]
        query_flag = QUERY_FLAG_BY_PORTAL.get(portal_id, "--query")
        loc_flag = LOCATION_FLAG_BY_PORTAL.get(portal_id)
        search_query = query
        if location and not loc_flag:
            search_query = f"{query} {location}".strip()
        if search_query:
            argv.extend([query_flag, search_query])
        elif portal_id != "freehire-search":
            # Most portals return noise without a query; freehire allows an empty q.
            raise ApiError(400, "query is required")
        if location and loc_flag:
            argv.extend([loc_flag, location])
        days = parse_jobage_days(payload)
        if days is not None:
            flag = JOBAGE_FLAG_BY_PORTAL.get(portal_id)
            if flag == "--since":
                since = (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()
                argv.extend([flag, since])
            elif flag:
                argv.extend([flag, str(days)])
        limit = payload.get("limit", 20)
        try:
            limit_n = int(limit)
        except (TypeError, ValueError):
            raise ApiError(400, "limit must be a whole number")
        if limit_n < 1 or limit_n > 50:
            raise ApiError(400, "limit must be between 1 and 50")
        argv.extend(["--limit", str(limit_n)])
        remote = str(payload.get("remote") or "").strip()
        if remote:
            if portal_id == "jobbank-search":
                mapped = {"remote": "helt", "hybrid": "delvist"}.get(remote, remote)
                argv.extend(["--remote", mapped])
            elif portal_id in {"linkedin-search", "freehire-search"}:
                argv.extend(["--remote", remote])
        return argv

    def search(self, portal_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self.runner is subprocess.run and shutil.which("bun") is None:
            raise ApiError(503, "bun is not installed — the portal CLIs need bun")
        argv = self.build_search_argv(portal_id, payload)
        try:
            completed = self.runner(
                argv,
                capture_output=True,
                text=True,
                timeout=SEARCH_TIMEOUT_SEC,
                cwd=str(self.root),
            )
        except FileNotFoundError as exc:
            raise ApiError(503, f"could not run portal CLI: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise ApiError(504, "portal search timed out") from exc
        if completed.returncode != 0:
            err = (completed.stderr or completed.stdout or "").strip()
            raise ApiError(502, err or f"{portal_id} search failed")
        stdout = completed.stdout or ""
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ApiError(502, "portal CLI did not return JSON") from exc
        results = parsed.get("results") if isinstance(parsed, dict) else parsed
        if not isinstance(results, list):
            results = []
        normalised = []
        for item in results:
            if not isinstance(item, dict):
                continue
            normalised.append(
                {
                    "id": item.get("id") or item.get("slug") or item.get("jobAdId") or "",
                    "title": item.get("title") or "",
                    "company": item.get("company") or "",
                    "location": item.get("location") or "",
                    "date": item.get("date") or item.get("posted_date") or "",
                    "url": item.get("url") or "",
                    "deadline": item.get("deadline") or "",
                    "portal": portal_id,
                    "raw": item,
                }
            )
        days = parse_jobage_days(payload)
        if days is not None and portal_id not in JOBAGE_FLAG_BY_PORTAL:
            normalised = [
                row for row in normalised if within_jobage(row.get("date"), days)
            ]
        return {
            "portal": portal_id,
            "count": len(normalised),
            "results": normalised,
        }

    def build_detail_argv(self, portal_id: str, url: str) -> list[str]:
        if not PORTAL_NAME_RE.match(portal_id):
            raise ApiError(400, "invalid portal id")
        cli = self.root / ".agents" / "skills" / portal_id / "cli" / "src" / "cli.ts"
        if not cli.exists():
            raise ApiError(404, f"portal {portal_id} is not installed")
        bun = shutil.which("bun") or "bun"
        arg = detail_argument(portal_id, url)
        if not arg:
            raise ApiError(400, "could not read a job id from that URL")
        return [bun, "run", str(cli), "detail", arg, "--format", "json"]

    def import_from_url(self, raw: str, *, track: bool = False) -> dict[str, Any]:
        url = first_url(raw)
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ApiError(400, "that does not look like a web URL")
        portal_id = portal_for_host(url)
        if portal_id is None:
            return {
                "ok": False,
                "reason": "unsupported_host",
                "url": url,
                "message": (
                    "This site is not a built-in job board. Paste the posting text "
                    "and we will save it under documents/postings."
                ),
            }
        installed = {item["id"] for item in self.list_portals()}
        if portal_id not in installed:
            return {
                "ok": False,
                "reason": "portal_missing",
                "url": url,
                "portal": portal_id,
                "message": f"{portal_id} is not installed in this checkout.",
            }
        if self.runner is subprocess.run and shutil.which("bun") is None:
            raise ApiError(503, "bun is not installed — the portal CLIs need bun")
        argv = self.build_detail_argv(portal_id, url)
        try:
            completed = self.runner(
                argv,
                capture_output=True,
                text=True,
                timeout=DETAIL_TIMEOUT_SEC,
                cwd=str(self.root),
            )
        except FileNotFoundError as exc:
            raise ApiError(503, f"could not run portal CLI: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise ApiError(504, "looking up that posting timed out") from exc
        if completed.returncode != 0:
            err = (completed.stderr or completed.stdout or "").strip()
            message = err or f"{portal_id} could not open that posting"
            try:
                parsed_err = json.loads(err)
                if isinstance(parsed_err, dict) and parsed_err.get("error"):
                    message = str(parsed_err["error"])
            except json.JSONDecodeError:
                pass
            return {
                "ok": False,
                "reason": "fetch_failed",
                "url": url,
                "portal": portal_id,
                "message": (
                    f"{message} Paste the posting text instead — many boards block automated reads."
                ),
            }
        try:
            payload = json.loads(completed.stdout or "")
        except json.JSONDecodeError:
            return {
                "ok": False,
                "reason": "fetch_failed",
                "url": url,
                "portal": portal_id,
                "message": "The board replied, but not as JSON. Paste the posting text instead.",
            }
        if not isinstance(payload, dict):
            return {
                "ok": False,
                "reason": "fetch_failed",
                "url": url,
                "portal": portal_id,
                "message": "Unexpected detail response. Paste the posting text instead.",
            }
        detail = normalize_detail(portal_id, payload, url)
        warning = next(
            (
                item.get("personal_use_warning")
                for item in self.list_portals()
                if item["id"] == portal_id
            ),
            False,
        )
        job = self.save_job(
            {
                "title": detail["title"],
                "company": detail["company"],
                "url": detail["url"] or url,
                "location": detail["location"],
                "date": detail["date"],
                "deadline": detail["deadline"],
                "portal": portal_id,
                "status": "new",
                "source": "url",
            }
        )
        posting_path = ""
        if detail["description"]:
            posting_path = self.save_posting_text(
                detail["company"] or "Unknown",
                detail["title"],
                detail["description"],
                url=detail["url"] or url,
            )
        application = None
        if track:
            application = self.track_job(str(job["key"]))
        return {
            "ok": True,
            "reason": "saved",
            "url": detail["url"] or url,
            "portal": portal_id,
            "job": job,
            "application": application,
            "posting_file": posting_path,
            "personal_use_warning": bool(warning),
            "excerpt": detail["description"][:600],
        }

    def save_posting_text(
        self, company: str, role: str, text: str, url: str = ""
    ) -> str:
        body = (text or "").strip()
        if not body:
            raise ApiError(400, "posting text is required")
        if len(body) > MAX_POSTING_CHARS:
            raise ApiError(413, "posting text is too long")
        company = (company or "").strip() or "Unknown"
        role = (role or "").strip() or "Role"
        name = safe_filename(f"{company} - {role}.txt")
        if not name.lower().endswith(".txt"):
            name = f"{name}.txt"
        folder = self.root / "documents" / "postings"
        path = folder / name
        header = f"Source: {url.strip()}\n\n" if url.strip() else ""
        payload = header + body + ("" if body.endswith("\n") else "\n")
        _atomic_write_bytes(path, payload.encode("utf-8"))
        return f"documents/postings/{name}"

    def import_from_text(self, payload: dict[str, Any]) -> dict[str, Any]:
        company = str(payload.get("company") or "").strip()
        role = str(payload.get("role") or "").strip()
        text = str(payload.get("text") or "").strip()
        url = str(payload.get("url") or payload.get("source") or "").strip()
        if url and not urlparse(url).scheme:
            url = ""
        if not company or not role:
            raise ApiError(400, "company and role are required")
        if not text:
            raise ApiError(400, "posting text is required")
        posting_file = self.save_posting_text(company, role, text, url=url)
        job_url = url or f"file:{posting_file}"
        job = self.save_job(
            {
                "title": role,
                "company": company,
                "url": job_url,
                "deadline": str(payload.get("deadline") or "").strip(),
                "portal": str(payload.get("portal") or "").strip(),
                "status": "new",
                "source": "paste",
                "location": str(payload.get("location") or "").strip(),
            }
        )
        application = None
        if payload.get("track"):
            application = self.track_job(str(job["key"]))
        return {
            "ok": True,
            "reason": "saved",
            "job": job,
            "application": application,
            "posting_file": posting_file,
        }

    def _doc_dir(self, folder: str) -> Path:
        if folder not in DOC_FOLDERS:
            raise ApiError(400, f"unknown documents folder {folder!r}")
        path = (self.root / "documents" / folder).resolve()
        try:
            path.relative_to((self.root / "documents").resolve())
        except ValueError as exc:
            raise ApiError(400, "invalid folder") from exc
        return path

    def _doc_path(self, folder: str, name: str) -> Path:
        if folder not in DOC_FOLDERS:
            raise ApiError(400, f"unknown documents folder {folder!r}")
        filename = safe_filename(name)
        suffix = Path(filename).suffix.lower()
        allowed = DOC_FOLDERS[folder]
        if suffix not in allowed:
            pretty = ", ".join(sorted(allowed))
            raise ApiError(400, f"{folder} only accepts {pretty}")
        folder_path = self._doc_dir(folder)
        path = (folder_path / filename).resolve()
        try:
            path.relative_to(folder_path)
        except ValueError as exc:
            raise ApiError(400, "invalid filename") from exc
        return path

    def list_documents(self) -> dict[str, Any]:
        files: list[dict[str, Any]] = []
        for folder in DOC_FOLDERS:
            directory = self.root / "documents" / folder
            if not directory.is_dir():
                continue
            for path in sorted(directory.iterdir(), key=lambda p: p.name.lower()):
                if not path.is_file() or path.name.startswith("."):
                    continue
                suffix = path.suffix.lower()
                if suffix not in DOC_FOLDERS[folder]:
                    continue
                stat = path.stat()
                files.append(
                    {
                        "folder": folder,
                        "name": path.name,
                        "size": stat.st_size,
                        "modified": datetime.fromtimestamp(
                            stat.st_mtime, tz=timezone.utc
                        ).isoformat(),
                    }
                )
        archives: list[dict[str, Any]] = []
        apps_root = self.root / "documents" / "applications"
        if apps_root.is_dir():
            for folder in sorted(apps_root.iterdir(), key=lambda p: p.name.lower()):
                if not folder.is_dir() or folder.name.startswith("."):
                    continue
                archives.append(
                    {
                        "folder": folder.name,
                        "files": sorted(
                            p.name for p in folder.iterdir() if p.is_file() and not p.name.startswith(".")
                        ),
                    }
                )
        return {"files": files, "archives": archives}

    def save_document(self, folder: str, name: str, data: bytes) -> dict[str, Any]:
        path = self._doc_path(folder, name)
        _atomic_write_bytes(path, data)
        stat = path.stat()
        return {
            "folder": folder,
            "name": path.name,
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        }

    def delete_document(self, folder: str, name: str) -> None:
        path = self._doc_path(folder, name)
        if not path.is_file():
            raise ApiError(404, "file not found")
        path.unlink()

    def read_document(self, folder: str, name: str) -> tuple[bytes, str, str]:
        path = self._doc_path(folder, name)
        if not path.is_file():
            raise ApiError(404, "file not found")
        ctype = FILE_TYPES.get(path.suffix.lower(), "application/octet-stream")
        return path.read_bytes(), ctype, path.name

    def profile(self) -> dict[str, Any]:
        path = self.root / "CLAUDE.md"
        if not path.exists():
            return {"ready": False}
        text = path.read_text(encoding="utf-8")

        def field(label: str) -> str:
            match = re.search(rf"\*\*{re.escape(label)}:\*\*\s*(.+)$", text, re.M)
            return match.group(1).strip().strip('"') if match else ""

        name = field("Name")
        location = field("Location")
        headline = field("LinkedIn headline")
        status = field("Status")
        placeholder = name.startswith("[") or name in {"", "[YOUR_NAME]"}
        return {
            "ready": not placeholder,
            "name": "" if placeholder else name,
            "location": "" if location.startswith("[") else location,
            "headline": "" if headline.startswith("[") else headline,
            "status": "" if status.startswith("[") else status,
        }


def _send(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _read_json(handler: BaseHTTPRequestHandler, max_bytes: int = MAX_BODY) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or "0")
    if length > max_bytes:
        raise ApiError(413, "request too large")
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ApiError(400, "invalid JSON") from exc
    if not isinstance(data, dict):
        raise ApiError(400, "JSON body must be an object")
    return data


STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".map": "application/json",
}

FALLBACK_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Job Search UI</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1.5rem; color: #1c1917; }
    code { background: #f5f5f4; padding: 0.15rem 0.35rem; border-radius: 0.3rem; }
    a { color: #0f766e; }
  </style>
</head>
<body>
  <h1>API is running</h1>
  <p>The React UI has not been built yet. From the repo root:</p>
  <pre><code>cd web && npm install && npm run build</code></pre>
  <p>Then restart <code>python3 tools/web_ui.py</code> and open
  <a href="/">http://127.0.0.1:8765</a>.</p>
  <p>For live reload, keep this server running and use <code>cd web && npm run dev</code>.</p>
</body>
</html>
"""


def make_handler(store: Store, dist: Path) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_PATCH(self) -> None:  # noqa: N802
            self._dispatch("PATCH")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def _dispatch(self, method: str) -> None:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            try:
                if path.startswith("/api/"):
                    self._api(method, path, query)
                    return
                if method != "GET":
                    raise ApiError(405, "method not allowed")
                self._static(path)
            except ApiError as exc:
                _send(self, exc.status, {"error": exc.message})
            except Exception as exc:  # pragma: no cover - last-resort
                _send(self, 500, {"error": str(exc)})

        def _api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
            if path == "/api/health" and method == "GET":
                _send(
                    self,
                    200,
                    {
                        "ok": True,
                        "host": DEFAULT_HOST,
                        "ui": (dist / "index.html").exists(),
                    },
                )
                return
            if path == "/api/profile" and method == "GET":
                _send(self, 200, store.profile())
                return
            if path == "/api/summary" and method == "GET":
                _send(self, 200, store.summary())
                return
            if path == "/api/applications" and method == "GET":
                _send(self, 200, {"applications": store.read_tracker()})
                return
            if path == "/api/applications" and method == "POST":
                created = store.create_application(_read_json(self))
                _send(self, 201, created)
                return
            patch_app = re.fullmatch(r"/api/applications/([0-9a-f]{16})", path)
            if patch_app and method == "PATCH":
                updated = store.patch_application(patch_app.group(1), _read_json(self))
                _send(self, 200, updated)
                return
            if path == "/api/jobs" and method == "GET":
                jobs = store.read_jobs()
                q = (query.get("q") or [""])[0].strip().lower()
                if q:
                    jobs = [
                        job
                        for job in jobs
                        if q in " ".join(
                            str(job.get(field) or "")
                            for field in ("title", "company", "location", "portal")
                        ).lower()
                    ]
                _send(self, 200, {"jobs": jobs})
                return
            if path == "/api/jobs" and method == "POST":
                saved = store.save_job(_read_json(self))
                _send(self, 201, saved)
                return
            if path == "/api/jobs" and method == "PATCH":
                payload = _read_json(self)
                key = str(payload.get("key") or "").strip()
                if not key:
                    raise ApiError(400, "key is required")
                updated = store.patch_job(key, payload)
                _send(self, 200, updated)
                return
            if path == "/api/jobs/track" and method == "POST":
                payload = _read_json(self)
                key = str(payload.get("key") or "").strip()
                if not key:
                    raise ApiError(400, "key is required")
                created = store.track_job(key)
                _send(self, 201, created)
                return
            if path == "/api/portals" and method == "GET":
                _send(self, 200, {"portals": store.list_portals()})
                return
            if path == "/api/search" and method == "POST":
                payload = _read_json(self)
                portal_id = str(payload.get("portal") or "").strip()
                if not portal_id:
                    raise ApiError(400, "portal is required")
                _send(self, 200, store.search(portal_id, payload))
                return
            if path == "/api/jobs/from-url" and method == "POST":
                payload = _read_json(self)
                raw = str(payload.get("url") or payload.get("text") or "")
                track = bool(payload.get("track"))
                result = store.import_from_url(raw, track=track)
                _send(self, 200, result)
                return
            if path == "/api/jobs/from-text" and method == "POST":
                created = store.import_from_text(_read_json(self))
                _send(self, 201, created)
                return
            if path == "/api/documents" and method == "GET":
                _send(self, 200, store.list_documents())
                return
            if path == "/api/documents" and method == "POST":
                payload = _read_json(self, max_bytes=MAX_UPLOAD * 2)
                folder = str(payload.get("folder") or "").strip()
                name = str(payload.get("name") or "").strip()
                saved = store.save_document(folder, name, decode_b64(str(payload.get("content_b64") or "")))
                _send(self, 201, saved)
                return
            if path == "/api/documents" and method == "DELETE":
                folder = (query.get("folder") or [""])[0].strip()
                name = (query.get("name") or [""])[0].strip()
                if not folder or not name:
                    raise ApiError(400, "folder and name are required")
                store.delete_document(folder, name)
                _send(self, 200, {"ok": True})
                return
            if path == "/api/documents/file" and method == "GET":
                folder = (query.get("folder") or [""])[0].strip()
                name = (query.get("name") or [""])[0].strip()
                if not folder or not name:
                    raise ApiError(400, "folder and name are required")
                data, ctype, filename = store.read_document(folder, name)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header(
                    "Content-Disposition",
                    f'inline; filename="{filename}"',
                )
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
            raise ApiError(404, "not found")

        def _static(self, path: str) -> None:
            if path == "/":
                path = "/index.html"
            relative = path.lstrip("/")
            target = (dist / relative).resolve()
            try:
                target.relative_to(dist.resolve())
            except ValueError:
                raise ApiError(400, "invalid path")
            if target.is_file():
                data = target.read_bytes()
                ctype = STATIC_TYPES.get(target.suffix, "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            index = dist / "index.html"
            if index.is_file() and "." not in Path(relative).name:
                data = index.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if not index.is_file() and path in {"/", "/index.html"}:
                data = FALLBACK_HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            raise ApiError(404, "not found")

    return Handler


def serve(host: str, port: int, store: Store, dist: Path) -> None:
    handler = make_handler(store, dist)
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"Job search UI: http://{host}:{port}", file=sys.stderr)
    print("Local only — tracker and job files stay on this machine.", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local job-search web UI (localhost only)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEB_UI_PORT", DEFAULT_PORT)))
    parser.add_argument(
        "--root",
        default=os.environ.get("WEB_UI_ROOT", str(REPO_ROOT)),
        help="Repository root (defaults to this checkout)",
    )
    args = parser.parse_args(argv)
    if args.port < 1 or args.port > 65535:
        print("port must be 1-65535", file=sys.stderr)
        return 2
    root = Path(args.root).resolve()
    dist = root / "web" / "dist"
    store = Store(root)
    serve(DEFAULT_HOST, args.port, store, dist)
    return 0


if __name__ == "__main__":
    sys.exit(main())
