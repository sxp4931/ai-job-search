"""Tests for the local React web UI's Python API (tools/web_ui.py).

The UI is a presentation layer over job_search_tracker.csv and seen_jobs.json.
These tests use a temp repo root so they never touch the real personal files.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import MagicMock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import web_ui  # noqa: E402

APPLY = REPO / ".claude" / "commands" / "apply.md"
OUTCOME = REPO / ".claude" / "commands" / "outcome.md"
DOCS_README = REPO / "documents" / "README.md"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class HeaderContractTests(unittest.TestCase):
    def test_tracker_header_matches_apply_and_outcome(self):
        self.assertIn(web_ui.TRACKER_HEADER, APPLY.read_text(encoding="utf-8"))
        self.assertIn(web_ui.TRACKER_HEADER, OUTCOME.read_text(encoding="utf-8"))


class ArchiveNameTests(unittest.TestCase):
    def test_matches_documents_readme_examples(self):
        self.assertEqual(web_ui.archive_folder_name("Acme", "ML Engineer"), "acme_ml_engineer")
        self.assertEqual(
            web_ui.archive_folder_name("Novo Nordisk A/S", "Scientist"),
            "novo_nordisk_as_scientist",
        )

    def test_readme_documents_the_same_rule(self):
        text = DOCS_README.read_text(encoding="utf-8")
        self.assertIn("lowercase, underscores for spaces", text)
        self.assertIn("Novo Nordisk A/S", text)


class StoreFixture(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.store = web_ui.Store(self.root)

    def _tracker_row(self, **overrides):
        payload = {
            "company": "Acme",
            "role": "Engineer",
            "status": "applied",
            "sector": "Tech",
            "channel": "online",
            "date": "2026-08-01",
        }
        payload.update(overrides)
        return self.store.create_application(payload)


class TrackerTests(StoreFixture):
    def test_missing_tracker_reads_as_empty(self):
        self.assertEqual(self.store.read_tracker(), [])

    def test_create_and_patch_round_trip(self):
        created = self._tracker_row(notes="hello, world")
        self.assertEqual(created["company"], "Acme")
        self.assertEqual(created["status"], "applied")
        self.assertTrue(created["id"])
        updated = self.store.patch_application(created["id"], {"status": "interview"})
        self.assertEqual(updated["status"], "interview")
        self.assertEqual(updated["notes"], "hello, world")

    def test_legacy_space_status_buckets_as_final(self):
        self._tracker_row(status="no response", company="OldCo")
        rows = self.store.read_tracker()
        self.assertEqual(rows[0]["bucket"], "Rejected/Closed")
        self.assertEqual(rows[0]["status_normalized"], "no_response")

    def test_unknown_status_rejected(self):
        with self.assertRaises(web_ui.ApiError) as ctx:
            self._tracker_row(status="ghosted")
        self.assertEqual(ctx.exception.status, 400)

    def test_requires_company_and_role(self):
        with self.assertRaises(web_ui.ApiError):
            self.store.create_application({"company": "Acme"})

    def test_patch_missing_id_is_404(self):
        with self.assertRaises(web_ui.ApiError) as ctx:
            self.store.patch_application("deadbeefdeadbeef", {"status": "applied"})
        self.assertEqual(ctx.exception.status, 404)

    def test_patch_identity_fields_returns_the_rewritten_row(self):
        created = self._tracker_row(company="Acme", role="Engineer", source="https://ex.com/a")
        updated = self.store.patch_application(created["id"], {"company": "Renamed"})
        self.assertEqual(updated["company"], "Renamed")
        self.assertEqual(updated["role"], "Engineer")
        follow = self.store.patch_application(updated["id"], {"status": "interview"})
        self.assertEqual(follow["status"], "interview")
        self.assertEqual(follow["company"], "Renamed")

    def test_concurrent_creates_keep_every_row(self):
        errors: list[BaseException] = []

        def worker(n: int) -> None:
            try:
                self.store.create_application(
                    {"company": f"Co{n}", "role": "Engineer", "status": "applied"}
                )
            except BaseException as exc:  # noqa: BLE001 - collect any race failure
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.store.read_tracker()), 8)


class SummaryTests(StoreFixture):
    def test_drafted_excluded_from_sent_and_funnel_base(self):
        self._tracker_row(status="drafted", company="DraftCo")
        self._tracker_row(status="applied", company="LiveCo")
        self._tracker_row(status="interview", company="TalkCo")
        self._tracker_row(status="rejected", company="NoCo")
        summary = self.store.summary()
        self.assertEqual(summary["drafted"], 1)
        self.assertEqual(summary["sent"], 3)
        self.assertEqual(summary["by_bucket"]["Drafted"], 1)
        self.assertEqual(summary["by_bucket"]["Active"], 1)
        self.assertEqual(summary["funnel"]["applied"], 3)
        self.assertEqual(summary["funnel"]["interview"], 1)

    def test_outcome_checkbox_counts_toward_interview_funnel(self):
        self._tracker_row(status="rejected", company="Acme", role="Engineer")
        folder = web_ui.archive_folder_name("Acme", "Engineer")
        _write(
            self.root / "documents" / "applications" / folder / "outcome.md",
            "# Outcome\n\n## Interview stages reached\n- [x] Phone screen\n",
        )
        summary = self.store.summary()
        self.assertEqual(summary["funnel"]["interview"], 1)
        self.assertEqual(summary["funnel"]["offer"], 0)

    def test_outcome_offer_checkbox_counts_toward_offer_funnel(self):
        self._tracker_row(status="withdrawn", company="Acme", role="Engineer")
        folder = web_ui.archive_folder_name("Acme", "Engineer")
        _write(
            self.root / "documents" / "applications" / folder / "outcome.md",
            "# Outcome\n\n## Interview stages reached\n"
            "- [x] Phone screen\n- [x] Offer received\n\n## Notes\n- [x] ignored\n",
        )
        summary = self.store.summary()
        self.assertEqual(summary["funnel"]["interview"], 1)
        self.assertEqual(summary["funnel"]["offer"], 1)
        self.assertEqual(summary["funnel"]["hired"], 0)

    def test_rejection_rate_ignores_withdrawn_and_open_rows(self):
        self._tracker_row(status="rejected", company="A")
        self._tracker_row(status="no_response", company="B")
        self._tracker_row(status="withdrawn", company="C")
        self._tracker_row(status="offer_declined", company="D")
        self._tracker_row(status="interview", company="E")
        summary = self.store.summary()
        # true rejections (2) / finals that are resolved including withdrawn+declined (4)
        self.assertEqual(summary["rejection_rate"], 50.0)


class JobsTests(StoreFixture):
    def test_save_and_track_job(self):
        saved = self.store.save_job(
            {
                "title": "Data Engineer",
                "company": "Globex",
                "url": "https://example.com/jobs/1",
                "portal": "linkedin-search",
                "date": "2026-08-20",
            }
        )
        self.assertEqual(saved["posted_date"], "2026-08-20")
        tracked = self.store.track_job(saved["key"])
        self.assertEqual(tracked["company"], "Globex")
        self.assertEqual(tracked["status"], "drafted")
        self.assertEqual(tracked["source"], "https://example.com/jobs/1")
        jobs = self.store.read_jobs()
        self.assertEqual(jobs[0]["status"], "tracked")

    def test_track_is_idempotent_for_same_company_role(self):
        saved = self.store.save_job(
            {
                "title": "Engineer",
                "company": "Acme",
                "url": "https://example.com/jobs/2",
            }
        )
        first = self.store.track_job(saved["key"])
        second = self.store.track_job(saved["key"])
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.read_tracker()), 1)

    def test_writes_to_skill_relative_seen_jobs_path(self):
        self.store.save_job(
            {"title": "Role", "company": "Co", "url": "https://example.com/a"}
        )
        expected = (
            self.root
            / ".claude"
            / "skills"
            / "job-scraper"
            / "job_scraper"
            / "seen_jobs.json"
        )
        self.assertTrue(expected.exists())


class PortalSearchTests(StoreFixture):
    def _install_portal(self, portal_id: str, enabled: bool = True) -> None:
        skill = self.root / ".agents" / "skills" / portal_id / "SKILL.md"
        cli = self.root / ".agents" / "skills" / portal_id / "cli" / "src" / "cli.ts"
        _write(
            skill,
            (
                f"---\nname: {portal_id}\nenabled: {str(enabled).lower()}\n---\n\n"
                f"# {portal_id} portal\n"
            ),
        )
        _write(cli, "// stub\n")

    def test_discovers_portals_and_enabled_flag(self):
        self._install_portal("linkedin-search", enabled=True)
        self._install_portal("jobindex-search", enabled=False)
        portals = {item["id"]: item for item in self.store.list_portals()}
        self.assertTrue(portals["linkedin-search"]["enabled"])
        self.assertTrue(portals["linkedin-search"]["requires_location"])
        self.assertFalse(portals["jobindex-search"]["enabled"])

    def test_linkedin_requires_location(self):
        self._install_portal("linkedin-search")
        with self.assertRaises(web_ui.ApiError) as ctx:
            self.store.build_search_argv("linkedin-search", {"query": "engineer"})
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("location", ctx.exception.message.lower())

    def test_jobindex_folds_city_into_query(self):
        self._install_portal("jobindex-search")
        self.store.runner = MagicMock()
        argv = self.store.build_search_argv(
            "jobindex-search",
            {"query": "python", "location": "aarhus", "limit": 10},
        )
        self.assertIn("--query", argv)
        self.assertIn("python aarhus", argv)
        self.assertNotIn("--location", argv)

    def test_jobbank_jobage_becomes_since(self):
        self._install_portal("jobbank-search")
        argv = self.store.build_search_argv(
            "jobbank-search", {"query": "data", "jobage": 7, "limit": 5}
        )
        self.assertIn("--since", argv)
        self.assertIn("--key", argv)

    def test_jobdanmark_jobage_filters_client_side(self):
        self._install_portal("jobdanmark-search")
        today = datetime.now(timezone.utc).date()
        old = (today - timedelta(days=20)).isoformat()
        recent = (today - timedelta(days=3)).isoformat()
        runner = MagicMock()
        runner.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps(
                {
                    "results": [
                        {
                            "title": "Old",
                            "company": "A",
                            "date": old,
                            "url": "https://example.com/old",
                            "location": "",
                        },
                        {
                            "title": "New",
                            "company": "B",
                            "date": recent,
                            "url": "https://example.com/new",
                            "location": "",
                        },
                        {
                            "title": "Undated",
                            "company": "C",
                            "date": None,
                            "url": "https://example.com/undated",
                            "location": "",
                        },
                    ]
                }
            ),
            stderr="",
        )
        self.store.runner = runner
        result = self.store.search(
            "jobdanmark-search", {"query": "python", "jobage": 7, "limit": 20}
        )
        titles = [row["title"] for row in result["results"]]
        self.assertEqual(titles, ["New", "Undated"])
        argv = runner.call_args.args[0]
        self.assertNotIn("--jobage", argv)
        self.assertIn("--text", argv)

    def test_jobnet_jobage_filters_client_side(self):
        self._install_portal("jobnet-search")
        today = datetime.now(timezone.utc).date()
        old = (today - timedelta(days=40)).isoformat()
        runner = MagicMock()
        runner.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps(
                {
                    "results": [
                        {
                            "title": "Stale",
                            "company": "A",
                            "date": old,
                            "url": "https://example.com/stale",
                            "location": "",
                        },
                        {
                            "title": "Fresh",
                            "company": "B",
                            "date": today.isoformat(),
                            "url": "https://example.com/fresh",
                            "location": "",
                        },
                    ]
                }
            ),
            stderr="",
        )
        self.store.runner = runner
        result = self.store.search(
            "jobnet-search", {"query": "sygeplejerske", "jobage": 14, "limit": 20}
        )
        titles = [row["title"] for row in result["results"]]
        self.assertEqual(titles, ["Fresh"])

    def test_search_uses_argv_list_not_shell(self):
        self._install_portal("linkedin-search")
        runner = MagicMock()
        runner.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps(
                {
                    "results": [
                        {
                            "id": "1",
                            "title": "Eng",
                            "company": "Co",
                            "location": "Remote",
                            "date": "2026-08-01",
                            "url": "https://example.com/j",
                        }
                    ]
                }
            ),
            stderr="",
        )
        self.store.runner = runner
        result = self.store.search(
            "linkedin-search",
            {"query": "engineer", "location": "Remote", "limit": 5},
        )
        self.assertEqual(result["count"], 1)
        kwargs = runner.call_args.kwargs
        self.assertFalse(kwargs.get("shell"))
        argv = runner.call_args.args[0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[1], "run")
        self.assertIn("--location", argv)
        self.assertIn("Remote", argv)

    def test_unknown_portal_is_404(self):
        with self.assertRaises(web_ui.ApiError) as ctx:
            self.store.build_search_argv("not-a-portal", {"query": "x"})
        self.assertEqual(ctx.exception.status, 404)

    def test_rejects_shell_metacharacters_in_portal_id(self):
        with self.assertRaises(web_ui.ApiError) as ctx:
            self.store.build_search_argv("linkedin-search;rm", {"query": "x"})
        self.assertEqual(ctx.exception.status, 400)


class ProfileTests(StoreFixture):
    def test_placeholder_profile_is_not_ready(self):
        _write(
            self.root / "CLAUDE.md",
            "- **Name:** [YOUR_NAME]\n- **Location:** [YOUR_CITY], [YOUR_COUNTRY]\n",
        )
        profile = self.store.profile()
        self.assertFalse(profile["ready"])
        self.assertEqual(profile["name"], "")

    def test_populated_profile(self):
        _write(
            self.root / "CLAUDE.md",
            '- **Name:** Ada Lovelace\n- **Location:** London, UK\n- **LinkedIn headline:** "Builder"\n',
        )
        profile = self.store.profile()
        self.assertTrue(profile["ready"])
        self.assertEqual(profile["name"], "Ada Lovelace")
        self.assertEqual(profile["headline"], "Builder")


class HttpServerTests(StoreFixture):
    def setUp(self):
        super().setUp()
        handler = web_ui.make_handler(self.store, self.root / "web" / "dist")
        self.httpd = web_ui.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        thread.start()

        def _stop():
            self.httpd.shutdown()
            self.httpd.server_close()

        self.addCleanup(_stop)

    def _request(self, method: str, path: str, body: dict | None = None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        data = json.loads(raw.decode("utf-8")) if raw else None
        return response.status, data

    def test_health_and_create_via_http(self):
        status, data = self._request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        status, created = self._request(
            "POST",
            "/api/applications",
            {"company": "Acme", "role": "Engineer", "status": "applied"},
        )
        self.assertEqual(status, 201)
        status, listing = self._request("GET", "/api/applications")
        self.assertEqual(status, 200)
        self.assertEqual(len(listing["applications"]), 1)
        status, patched = self._request(
            "PATCH",
            f"/api/applications/{created['id']}",
            {"status": "offer"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(patched["status"], "offer")

    def test_fallback_html_when_ui_not_built(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/")
        response = conn.getresponse()
        body = response.read().decode("utf-8")
        conn.close()
        self.assertEqual(response.status, 200)
        self.assertIn("API is running", body)

    def test_unknown_api_is_json_404(self):
        status, data = self._request("GET", "/api/does-not-exist")
        self.assertEqual(status, 404)
        self.assertIn("error", data)


class BindTests(unittest.TestCase):
    def test_default_host_is_localhost(self):
        self.assertEqual(web_ui.DEFAULT_HOST, "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
