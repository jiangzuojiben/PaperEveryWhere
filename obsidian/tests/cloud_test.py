"""Integration checks for the independent, self-hosted VaultDesk service.

Run from obsidian/: ../.venv/Scripts/python.exe -m unittest discover -s tests -p cloud_test.py
Each test uses a new SQLite database and never contacts an external service.
"""

import base64
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from cloud.app import create_app


class CloudIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="vaultdesk-cloud-test-")
        self.addCleanup(self.directory.cleanup)
        self.db_path = str(Path(self.directory.name) / "cloud.sqlite3")
        self.client = TestClient(create_app(self.db_path))
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.account = self.register("owner@example.test")
        self.headers = {"Authorization": "Bearer " + self.account["token"]}
        self.vault = self.create_vault("Research")

    def assert_success(self, response):
        self.assertIn(response.status_code, (200, 201, 204), response.text)
        return response.json() if response.content else None

    def register(self, email):
        return self.assert_success(self.client.post(
            "/auth/register", json={"email": email, "password": "correct-horse-123"}
        ))

    def create_vault(self, name, headers=None):
        return self.assert_success(self.client.post(
            "/vaults", json={"name": name}, headers=headers or self.headers
        ))

    def write(self, path, content, revision=0, encoding="utf8", headers=None, vault=None):
        vault_id = (vault or self.vault)["id"]
        return self.client.put(
            f"/vaults/{vault_id}/files",
            json={"path": path, "content": content, "encoding": encoding,
                  "base_revision": revision},
            headers=headers or self.headers,
        )

    def delete(self, path, revision):
        return self.client.request(
            "DELETE", f"/vaults/{self.vault['id']}/files",
            json={"path": path, "base_revision": revision}, headers=self.headers,
        )

    def changes(self, cursor=0):
        return self.assert_success(self.client.get(
            f"/vaults/{self.vault['id']}/changes", params={"cursor": cursor},
            headers=self.headers,
        ))

    def history(self, path):
        return self.assert_success(self.client.get(
            f"/vaults/{self.vault['id']}/history", params={"path": path},
            headers=self.headers,
        ))["history"]

    def publish(self, paths, slug="research", title="Research"):
        return self.assert_success(self.client.post(
            "/sites", json={"vault_id": self.vault["id"], "slug": slug,
                           "title": title, "paths": paths}, headers=self.headers,
        ))

    def test_register_login_and_logout_revoke_session(self):
        self.assertTrue(self.account["token"])
        self.assertEqual(self.account["user"]["email"], "owner@example.test")
        self.assertNotIn("password", self.account["user"])
        self.assertNotIn("password_hash", self.account["user"])
        wrong = self.client.post("/auth/login", json={
            "email": "owner@example.test", "password": "wrong-password"})
        self.assertEqual(wrong.status_code, 401)
        login = self.assert_success(self.client.post("/auth/login", json={
            "email": "owner@example.test", "password": "correct-horse-123"}))
        headers = {"Authorization": "Bearer " + login["token"]}
        self.assert_success(self.client.get("/vaults", headers=headers))
        self.assert_success(self.client.post("/auth/logout", headers=headers))
        self.assertEqual(self.client.get("/vaults", headers=headers).status_code, 401)
        # Revoking one device session must not sign out a different device.
        self.assert_success(self.client.get("/vaults", headers=self.headers))

    def test_authentication_required_and_registration_validated(self):
        for headers in ({}, {"Authorization": "Bearer invalid-session"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.get("/vaults", headers=headers).status_code, 401)
                self.assertEqual(self.client.get("/sites", headers=headers).status_code, 401)
                self.assertEqual(self.client.get(
                    f"/vaults/{self.vault['id']}/changes", headers=headers).status_code, 401)
        short = self.client.post("/auth/register", json={
            "email": "short@example.test", "password": "tiny"})
        self.assertIn(short.status_code, (400, 422))
        duplicate = self.client.post("/auth/register", json={
            "email": "owner@example.test", "password": "another-password-123"})
        self.assertIn(duplicate.status_code, (400, 409))

    def test_vault_create_rename_list_and_delete(self):
        other_vault = self.create_vault("Second")
        vaults = self.assert_success(self.client.get("/vaults", headers=self.headers))["vaults"]
        self.assertEqual({v["id"] for v in vaults}, {self.vault["id"], other_vault["id"]})
        self.assert_success(self.client.patch(
            f"/vaults/{other_vault['id']}", json={"name": "Renamed"}, headers=self.headers))
        vaults = self.assert_success(self.client.get("/vaults", headers=self.headers))["vaults"]
        self.assertEqual(next(v["name"] for v in vaults if v["id"] == other_vault["id"]), "Renamed")
        self.assert_success(self.client.delete(f"/vaults/{other_vault['id']}", headers=self.headers))
        vaults = self.assert_success(self.client.get("/vaults", headers=self.headers))["vaults"]
        self.assertEqual([v["id"] for v in vaults], [self.vault["id"]])
        self.assertEqual(self.client.get(
            f"/vaults/{other_vault['id']}/changes", headers=self.headers).status_code, 404)

    def test_users_cannot_read_modify_restore_or_publish_another_vault(self):
        original = self.assert_success(self.write("secret.md", "private content"))
        other = self.register("outsider@example.test")
        other_headers = {"Authorization": "Bearer " + other["token"]}
        self.assertEqual(self.assert_success(self.client.get(
            "/vaults", headers=other_headers))["vaults"], [])
        base = f"/vaults/{self.vault['id']}"
        requests = [
            ("GET", base + "/changes", None),
            ("GET", base + "/history?path=secret.md", None),
            ("PUT", base + "/files", {"path": "secret.md", "content": "stolen",
                                       "encoding": "utf8", "base_revision": original["revision"]}),
            ("DELETE", base + "/files", {"path": "secret.md", "base_revision": original["revision"]}),
            ("POST", base + "/restore", {"path": "secret.md", "revision": original["revision"],
                                          "base_revision": original["revision"]}),
            ("PATCH", base, {"name": "Stolen"}),
            ("POST", "/sites", {"vault_id": self.vault["id"], "slug": "stolen",
                                  "title": "Stolen", "paths": ["secret.md"]}),
            ("DELETE", base, None),
        ]
        for method, url, body in requests:
            with self.subTest(method=method, url=url):
                response = self.client.request(method, url, headers=other_headers, json=body)
                self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(self.changes()["changes"][-1]["content"], "private content")

    def test_utf8_and_binary_roundtrip_report_byte_sizes(self):
        content = "# 中文笔记\n双向链接 [[想法]] 📝\n"
        note = self.assert_success(self.write("资料/中文.md", content))
        self.assertEqual(note["content"], content)
        self.assertEqual(note["encoding"], "utf8")
        self.assertEqual(note["size"], len(content.encode("utf-8")))
        self.assertFalse(note["deleted"])
        binary = bytes(range(256)) + b"\x00\xffbinary"
        encoded = base64.b64encode(binary).decode("ascii")
        attachment = self.assert_success(self.write("attachments/data.bin", encoded, encoding="base64"))
        self.assertEqual(base64.b64decode(attachment["content"]), binary)
        self.assertEqual(attachment["size"], len(binary))
        snapshot = {item["path"]: item for item in self.changes()["changes"]}
        self.assertEqual(snapshot["资料/中文.md"]["content"], content)
        self.assertEqual(base64.b64decode(snapshot["attachments/data.bin"]["content"]), binary)

    def test_changes_are_an_incremental_ordered_event_log(self):
        initial = self.changes()
        self.assertEqual(initial["changes"], [])
        first = self.assert_success(self.write("note.md", "one"))
        first_batch = self.changes(initial["cursor"])
        self.assertEqual(len(first_batch["changes"]), 1)
        second = self.assert_success(self.write("note.md", "two", first["revision"]))
        removed = self.assert_success(self.delete("note.md", second["revision"]))
        later = self.changes(first_batch["cursor"])
        self.assertEqual([c["revision"] for c in later["changes"]],
                         [second["revision"], removed["revision"]])
        self.assertEqual(later["changes"][0]["content"], "two")
        self.assertTrue(later["changes"][-1]["deleted"])
        all_changes = self.changes()["changes"]
        self.assertEqual([c["revision"] for c in all_changes],
                         [first["revision"], second["revision"], removed["revision"]])
        self.assertEqual(self.changes(later["cursor"])["changes"], [])

    def test_stale_write_and_delete_return_conflict_without_lost_updates(self):
        first = self.assert_success(self.write("note.md", "version one"))
        second = self.assert_success(self.write("note.md", "version two", first["revision"]))
        for response in (self.write("note.md", "stale", first["revision"]),
                         self.delete("note.md", first["revision"])):
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"], {
                "code": "revision_conflict", "path": "note.md",
                "current_revision": second["revision"],
            })
        events = self.changes()["changes"]
        self.assertEqual(len(events), 2)
        self.assertEqual(events[-1]["content"], "version two")

    def test_deleted_file_keeps_tombstone_and_requires_current_revision(self):
        first = self.assert_success(self.write("note.md", "original"))
        tombstone = self.assert_success(self.delete("note.md", first["revision"]))
        self.assertTrue(tombstone["deleted"])
        stale = self.write("note.md", "accidental resurrection", first["revision"])
        self.assertEqual(stale.status_code, 409)
        stale_create = self.write("note.md", "new client", 0)
        self.assertEqual(stale_create.status_code, 409)
        restored = self.assert_success(self.write("note.md", "intentional", tombstone["revision"]))
        self.assertFalse(restored["deleted"])
        self.assertGreater(restored["revision"], tombstone["revision"])

    def test_concurrent_writers_cannot_both_replace_the_same_revision(self):
        first = self.assert_success(self.write("shared.md", "base"))
        with ThreadPoolExecutor(max_workers=2) as workers:
            responses = list(workers.map(
                lambda value: self.write("shared.md", value, first["revision"]),
                ("device one", "device two"),
            ))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        winner = next(response.json() for response in responses if response.status_code == 200)
        changes = self.changes()["changes"]
        self.assertEqual(len(changes), 2)
        self.assertEqual(changes[-1]["content"], winner["content"])
        self.assertEqual(changes[-1]["revision"], winner["revision"])

    def test_history_and_restore_create_new_revision_and_obey_cas(self):
        first = self.assert_success(self.write("note.md", "original"))
        second = self.assert_success(self.write("note.md", "changed", first["revision"]))
        tombstone = self.assert_success(self.delete("note.md", second["revision"]))
        history = {h["revision"]: h for h in self.history("note.md")}
        self.assertEqual(set(history), {first["revision"], second["revision"], tombstone["revision"]})
        self.assertEqual(history[first["revision"]]["size"], len(b"original"))
        self.assertTrue(history[tombstone["revision"]]["deleted"])
        url = f"/vaults/{self.vault['id']}/restore"
        conflict = self.client.post(url, json={"path": "note.md", "revision": first["revision"],
                                             "base_revision": second["revision"]}, headers=self.headers)
        self.assertEqual(conflict.status_code, 409)
        restored = self.assert_success(self.client.post(url, json={
            "path": "note.md", "revision": first["revision"], "base_revision": tombstone["revision"]},
            headers=self.headers))
        self.assertEqual(restored["content"], "original")
        self.assertFalse(restored["deleted"])
        self.assertGreater(restored["revision"], tombstone["revision"])
        self.assertEqual(len(self.history("note.md")), 4)

    def test_publish_selected_snapshot_and_unpublish(self):
        public = self.assert_success(self.write("guide.md", "# Public guide\nReleased content"))
        self.assert_success(self.write("private.md", "Never publish this secret"))
        site = self.publish(["guide.md"])
        sites = self.assert_success(self.client.get("/sites", headers=self.headers))["sites"]
        self.assertEqual([s["id"] for s in sites], [site["id"]])
        page = self.client.get("/p/research/guide.md")
        self.assertEqual(page.status_code, 200, page.text)
        self.assertIn("text/html", page.headers["content-type"])
        self.assertIn("Released content", page.text)
        self.assertEqual(self.client.get("/p/research/private.md").status_code, 404)
        self.assert_success(self.write("guide.md", "# Unreleased draft", public["revision"]))
        self.assertNotIn("Unreleased draft", self.client.get("/p/research/guide.md").text)
        self.assert_success(self.client.patch(f"/sites/{site['id']}", json={
            "paths": ["guide.md"]}, headers=self.headers))
        self.assertIn("Unreleased draft", self.client.get("/p/research/guide.md").text)
        self.assert_success(self.client.delete(f"/sites/{site['id']}", headers=self.headers))
        self.assertEqual(self.client.get("/p/research/guide.md").status_code, 404)
        self.assertEqual(self.assert_success(self.client.get("/sites", headers=self.headers))["sites"], [])

    def test_other_account_cannot_list_modify_or_remove_published_site(self):
        self.assert_success(self.write("guide.md", "Published"))
        site = self.publish(["guide.md"])
        other = self.register("reader@example.test")
        headers = {"Authorization": "Bearer " + other["token"]}
        self.assertEqual(self.assert_success(self.client.get("/sites", headers=headers))["sites"], [])
        self.assertEqual(self.client.patch(f"/sites/{site['id']}", json={
            "paths": ["guide.md"]}, headers=headers).status_code, 404)
        self.assertEqual(self.client.delete(f"/sites/{site['id']}", headers=headers).status_code, 404)
        self.assertEqual(self.client.get("/p/research/guide.md").status_code, 200)

    def test_public_html_neutralizes_scripts_and_active_links(self):
        dangerous = (
            '# Safe heading\n<script>alert("script")</script>\n'
            '<img src="x" onerror="alert(1)">\n'
            '[click](javascript:alert%281%29)\n'
            '[data](data:text/html;base64,PHNjcmlwdD4=)\n'
            '<iframe src="https://evil.example"></iframe>\n'
        )
        self.assert_success(self.write("unsafe.md", dangerous))
        self.publish(["unsafe.md"], title='<script>alert("title")</script>')
        page = self.client.get("/p/research/unsafe.md")
        self.assertEqual(page.status_code, 200)
        self.assertNotIn("<script", page.text.lower())
        self.assertNotIn("<iframe", page.text.lower())
        self.assertNotRegex(page.text, r'<[^>]+\bonerror\s*=')
        self.assertNotRegex(page.text, r'href=[\"\x27]\s*(?:javascript|data):')
        self.assertIn("default-src 'none'", page.headers.get("content-security-policy", ""))
        self.assertIn("sandbox", page.headers.get("content-security-policy", ""))
        self.assertEqual(page.headers.get("x-content-type-options"), "nosniff")

    def test_publish_rejects_invalid_slugs_and_missing_paths(self):
        self.assert_success(self.write("guide.md", "Published guide"))
        for slug in ("../outside", "with/slash", '<script>alert(1)</script>'):
            with self.subTest(slug=slug):
                response = self.client.post("/sites", json={
                    "vault_id": self.vault["id"], "slug": slug,
                    "title": "Title", "paths": ["guide.md"]}, headers=self.headers)
                self.assertIn(response.status_code, (400, 422), response.text)
        response = self.client.post("/sites", json={
            "vault_id": self.vault["id"], "slug": "missing-note",
            "title": "Title", "paths": ["missing.md"]}, headers=self.headers)
        self.assertIn(response.status_code, (400, 404, 422), response.text)
        self.assertEqual(self.assert_success(self.client.get("/sites", headers=self.headers))["sites"], [])

    def test_unsafe_paths_and_invalid_binary_are_rejected_without_events(self):
        for path in ("../escape.md", "folder/../../escape.md", "/absolute.md",
                     "C:\\Windows\\escape.md", "folder\\..\\escape.md", "", ".", "a\x00b.md"):
            with self.subTest(path=path):
                response = self.write(path, "should never be stored")
                self.assertIn(response.status_code, (400, 422), response.text)
        malformed = self.write("invalid.bin", "%%%not-base64%%%", encoding="base64")
        self.assertIn(malformed.status_code, (400, 422), malformed.text)
        unsupported = self.write("invalid.txt", "hello", encoding="hex")
        self.assertIn(unsupported.status_code, (400, 422), unsupported.text)
        self.assertEqual(self.changes()["changes"], [])

    def test_file_limit_counts_decoded_bytes_and_accepts_exact_boundary(self):
        with patch("cloud.app.MAX_FILE_BYTES", 8):
            text = self.assert_success(self.write("boundary.md", "中文ab"))
            self.assertEqual(text["size"], 8)
            self.assertEqual(self.write("too-large.md", "中文abc").status_code, 413)
            binary = self.assert_success(self.write(
                "boundary.bin", base64.b64encode(b"12345678").decode(), encoding="base64"))
            self.assertEqual(binary["size"], 8)
            self.assertEqual(self.write("too-large.bin", base64.b64encode(b"123456789").decode(),
                                        encoding="base64").status_code, 413)
        self.assertEqual([event["path"] for event in self.changes()["changes"]],
                         ["boundary.md", "boundary.bin"])

    def test_request_limit_handles_declared_and_streamed_oversize_bodies(self):
        payload = json.dumps({"path": "boundary.md", "content": "body", "encoding": "utf8",
                              "base_revision": 0}).encode()
        headers = {**self.headers, "Content-Type": "application/json"}
        url = f"/vaults/{self.vault['id']}/files"
        with patch("cloud.app.MAX_REQUEST_BYTES", len(payload)):
            self.assert_success(self.client.put(url, content=payload, headers=headers))
            declared = self.client.put(url, content=payload + b" ", headers=headers)
            self.assertEqual(declared.status_code, 413)
            # A chunked request has no Content-Length, so the received body must
            # also be checked instead of trusting only the declared length.
            streamed = self.client.put(url, content=iter((payload, b" ")), headers=headers)
            self.assertNotIn("content-length", streamed.request.headers)
            self.assertEqual(streamed.status_code, 413)
            misleading = self.client.put(url, content=b"{}", headers={
                **headers, "Content-Length": str(len(payload) + 1)})
            self.assertEqual(misleading.status_code, 413)
        self.assertEqual(len(self.changes()["changes"]), 1)

    def test_windows_case_and_file_directory_collisions_are_rejected(self):
        self.assert_success(self.write("Case.md", "existing file"))
        for path in ("case.md", "Case.md/child.md"):
            with self.subTest(path=path):
                response = self.write(path, "collision")
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["detail"]["code"], "path_collision")
        self.assert_success(self.write("folder/child.md", "nested file"))
        response = self.write("folder", "cannot overwrite a directory")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "path_collision")
        self.assertEqual(len(self.changes()["changes"]), 2)

    def test_data_survives_creating_another_app_instance(self):
        self.assert_success(self.write("durable.md", "survives server restart"))
        with TestClient(create_app(self.db_path)) as restarted:
            login = self.assert_success(restarted.post("/auth/login", json={
                "email": "owner@example.test", "password": "correct-horse-123"}))
            headers = {"Authorization": "Bearer " + login["token"]}
            vaults = self.assert_success(restarted.get("/vaults", headers=headers))["vaults"]
            self.assertEqual(vaults[0]["id"], self.vault["id"])
            events = self.assert_success(restarted.get(
                f"/vaults/{self.vault['id']}/changes", headers=headers))["changes"]
            self.assertEqual(events[-1]["content"], "survives server restart")


if __name__ == "__main__":
    unittest.main()
