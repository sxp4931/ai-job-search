#!/usr/bin/env python3
"""Local web UI for the job-search tracker, scraped jobs, and portal search.

This is a presentation layer over the files the slash-command workflow already
uses. It does not draft CVs, score fit, or replace /apply, /rank, or /interview.

Binds to 127.0.0.1 only: the tracker and seen-jobs files are personal data.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable
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
SEARCH_TIMEOUT_SEC = 90
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

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
        tmp = path.with_suffix(".csv.tmp")
        with tmp.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=fieldnames,
                extrasaction="ignore",
                lineterminator="\n",
            )
            writer.writeheader()
            for row in materialised:
                writer.writerow({key: row.get(key, "") for key in fieldnames})
        tmp.replace(path)

    def create_application(self, payload: dict[str, Any]) -> dict[str, str]:
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
        rows = self.read_tracker()
        match = next((row for row in rows if row["id"] == app_id), None)
        if match is None:
            raise ApiError(404, "application not found")
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
        refreshed = self.read_tracker()
        return next(row for row in refreshed if row["id"] == app_id)

    def _outcome_reached_interview(self, company: str, role: str) -> bool:
        folder = archive_folder_name(company, role)
        if not folder:
            return False
        path = self.root / "documents" / "applications" / folder / "outcome.md"
        if not path.exists():
            return False
        text = path.read_text(encoding="utf-8")
        return bool(re.search(r"^- \[[xX]\]", text, re.M))

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
                if stage == "applied":
                    count += 1
                elif stage == "interview":
                    if bucket in {"Interview", "Offer", "Hired"}:
                        count += 1
                    elif self._outcome_reached_interview(row["company"], row["role"]):
                        count += 1
                elif stage == "offer":
                    if bucket in {"Offer", "Hired"} or status == "offer_declined":
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
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)

    def save_job(self, payload: dict[str, Any]) -> dict[str, Any]:
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
        created = self.create_application(
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
        jobage = payload.get("jobage")
        if jobage not in (None, "", 0, "0"):
            try:
                days = int(jobage)
            except (TypeError, ValueError):
                raise ApiError(400, "jobage must be a whole number of days")
            if days < 1:
                raise ApiError(400, "jobage must be >= 1")
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
        return {
            "portal": portal_id,
            "count": len(normalised),
            "results": normalised,
        }

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


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or "0")
    if length > MAX_BODY:
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
