"""Private vault synchronization and explicitly selected public snapshots.

Run from obsidian/: python -m uvicorn cloud.app:app --host 127.0.0.1 --port 8766
No request is made to Obsidian or to any other external service.
"""
from __future__ import annotations

import base64
import binascii
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import html
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import sqlite3
import threading
import time
from typing import Literal
from urllib.parse import quote, unquote, urlsplit

import bleach
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from markdown_it import MarkdownIt
from pydantic import BaseModel, ConfigDict, Field, field_validator

PASSWORD_ITERATIONS = 600_000
MAX_FILE_BYTES = int(os.getenv("VAULTDESK_MAX_FILE_BYTES", str(16 * 1024 * 1024)))
MAX_REQUEST_BYTES = 4 * ((MAX_FILE_BYTES + 2) // 3) + 65_536
USER_QUOTA_BYTES = int(os.getenv("VAULTDESK_USER_QUOTA_BYTES", str(1024 * 1024 * 1024)))
HISTORY_QUOTA_BYTES = int(os.getenv("VAULTDESK_HISTORY_QUOTA_BYTES", str(5 * 1024 * 1024 * 1024)))
SESSION_TTL_SECONDS = int(os.getenv("VAULTDESK_SESSION_TTL_SECONDS", str(30 * 86400)))
SAFE_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif"}
PUBLIC_HEADERS = {"Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def valid_path(value: str) -> str:
    """Use a portable relative vault path, never an operating-system path."""
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 1024:
        raise ValueError("Path must contain between 1 and 1024 UTF-8 bytes")
    if value.startswith("/") or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Path must be relative with forward slashes")
    if re.search(r'[<>:"|?*]', value):
        raise ValueError("Path contains characters unsupported on Windows")
    for part in value.split("/"):
        if part in ("", ".", "..") or part.endswith((" ", ".")) or len(part.encode("utf-8")) > 255:
            raise ValueError("Invalid path segment")
        if re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part):
            raise ValueError("Reserved Windows filename")
    return value


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(Input):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=1024)

    @field_validator("email")
    @classmethod
    def email_address(cls, value: str) -> str:
        value = value.strip().casefold()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("A valid email address is required")
        return value


class VaultInput(Input):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(c) < 32 for c in value):
            raise ValueError("Vault name must be nonempty printable text")
        return value


class PathInput(Input):
    path: str
    _path = field_validator("path")(valid_path)


class FileDelete(PathInput):
    base_revision: int = Field(ge=0, strict=True)


class FileWrite(FileDelete):
    content: str
    encoding: Literal["utf8", "base64"] = "utf8"


class FileRestore(FileDelete):
    revision: int = Field(gt=0, strict=True)


class SiteInput(Input):
    vault_id: str
    slug: str = Field(pattern=r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    title: str = Field(min_length=1, max_length=200)
    paths: list[str] = Field(min_length=1, max_length=1000)

    @field_validator("paths")
    @classmethod
    def safe_paths(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(valid_path(v) for v in values))


class SitePatch(Input):
    vault_id: str | None = None
    slug: str | None = Field(None, pattern=r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    title: str | None = Field(None, min_length=1, max_length=200)
    paths: list[str] = Field(min_length=1, max_length=1000)

    @field_validator("paths")
    @classmethod
    def safe_paths(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(valid_path(v) for v in values))


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, path TEXT NOT NULL, content BLOB, encoding TEXT NOT NULL,
    deleted INTEGER NOT NULL, size INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(vault_id, revision)
);
CREATE INDEX IF NOT EXISTS versions_path ON versions(vault_id, path, revision);
CREATE TABLE IF NOT EXISTS files (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, path TEXT NOT NULL,
    revision INTEGER NOT NULL, PRIMARY KEY(vault_id, path)
);
CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS published_files (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, path TEXT NOT NULL,
    content BLOB NOT NULL, encoding TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(site_id, path)
);
"""


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2-sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def check_password(password: str, saved: str) -> bool:
    _, iterations, salt, digest = saved.split("$")
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations))
    return hmac.compare_digest(candidate.hex(), digest)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def file_output(row: sqlite3.Row, content: bool = True) -> dict:
    data = {key: row[key] for key in ("path", "revision", "encoding", "size", "updated_at")}
    data["deleted"] = bool(row["deleted"])
    if content and not data["deleted"]:
        data["content"] = bytes(row["content"]).decode("utf-8") if row["encoding"] == "utf8" else base64.b64encode(row["content"]).decode("ascii")
    return data


class BodyLimitMiddleware:
    """Bound both Content-Length and chunked bodies before JSON parsing."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = MAX_REQUEST_BYTES + 1
        if declared < 0 or declared > MAX_REQUEST_BYTES:
            return await JSONResponse({"detail": "Request body exceeds configured file limit"}, status_code=413)(scope, receive, send)
        chunks, length = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            length += len(message.get("body", b""))
            if length > MAX_REQUEST_BYTES:
                return await JSONResponse({"detail": "Request body exceeds configured file limit"}, status_code=413)(scope, receive, send)
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": b"".join(chunks), "more_body": False}

        await self.app(scope, replay, send)


def create_app(db_path: str | Path | None = None) -> FastAPI:
    db_path = str(db_path or os.getenv("VAULTDESK_DB", str(Path(__file__).parent / "data" / "vaultdesk.sqlite3")))
    if db_path == ":memory:":
        raise ValueError("Use a temporary file, not :memory:, because requests use independent connections")
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def database(write: bool = False):
        connection = sqlite3.connect(db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    with database() as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript(SCHEMA)

    app = FastAPI(title="VaultDesk Self-hosted Cloud", version="1.0.0")
    app.state.db_path = db_path
    app.add_middleware(BodyLimitMiddleware)
    origins = [x.strip() for x in os.getenv("VAULTDESK_CORS_ORIGINS", "http://localhost:5178,http://127.0.0.1:5178").split(",") if x.strip()]
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Authorization", "Content-Type"], allow_credentials=False)

    limiter: dict[str, deque] = defaultdict(deque)
    limiter_lock = threading.Lock()
    dummy_password_hash = password_hash("dummy-account-password")

    def throttle(request: Request):
        key = request.client.host if request.client else "unknown"
        stamp = time.monotonic()
        with limiter_lock:
            if len(limiter) > 10000:
                for entry in list(limiter):
                    if not limiter[entry] or limiter[entry][-1] < stamp - 60:
                        del limiter[entry]
            queue = limiter[key]
            while queue and queue[0] < stamp - 60:
                queue.popleft()
            if len(queue) >= 30:
                raise HTTPException(429, "Too many authentication attempts; wait one minute", headers={"Retry-After": "60"})
            queue.append(stamp)

    def user(request: Request) -> dict:
        authorization = request.headers.get("Authorization", "")
        if not authorization.startswith("Bearer ") or len(authorization) > 512:
            raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
        digest = token_hash(authorization[7:])
        with database() as connection:
            row = connection.execute("SELECT u.id,u.email,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?", (digest, time.time())).fetchone()
        if not row:
            raise HTTPException(401, "Session is invalid or expired", headers={"WWW-Authenticate": "Bearer"})
        return dict(row)

    def own_vault(connection, vault_id: str, account: dict):
        row = connection.execute("SELECT * FROM vaults WHERE id=? AND user_id=?", (vault_id, account["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Vault not found")
        return row

    def own_site(connection, site_id: str, account: dict):
        row = connection.execute("SELECT * FROM sites WHERE id=? AND user_id=?", (site_id, account["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Site not found")
        return row

    def session(connection, account: dict):
        token = secrets.token_urlsafe(48)
        connection.execute("DELETE FROM sessions WHERE expires_at<=?", (time.time(),))
        connection.execute("INSERT INTO sessions VALUES(?,?,?,?)", (token_hash(token), account["id"], time.time() + SESSION_TTL_SECONDS, now_iso()))
        return {"token": token, "user": account, "expires_in": SESSION_TTL_SECONDS}

    def current_file(connection, vault_id: str, path: str):
        return connection.execute("SELECT v.* FROM files f JOIN versions v ON v.vault_id=f.vault_id AND v.revision=f.revision WHERE f.vault_id=? AND f.path=?", (vault_id, path)).fetchone()

    def apply_version(connection, vault, path: str, base_revision: int, content: bytes | None, encoding: str, deleted: bool):
        previous = current_file(connection, vault["id"], path)
        current_revision = previous["revision"] if previous else 0
        if current_revision != base_revision:
            raise HTTPException(409, {"code": "revision_conflict", "path": path, "current_revision": current_revision})
        if deleted and (not previous or previous["deleted"]):
            raise HTTPException(404, "File does not exist or is already deleted")
        if not deleted:
            folded = path.casefold()
            active_paths = connection.execute("SELECT f.path FROM files f JOIN versions v ON v.vault_id=f.vault_id AND v.revision=f.revision WHERE f.vault_id=? AND v.deleted=0 AND f.path!=?", (vault["id"], path))
            for item in active_paths:
                other = item["path"].casefold()
                if other == folded or other.startswith(folded + "/") or folded.startswith(other + "/"):
                    raise HTTPException(409, {"code": "path_collision", "path": path, "existing_path": item["path"]})
        size = len(content) if content is not None else 0
        active_size = connection.execute("SELECT COALESCE(SUM(v.size),0) FROM files f JOIN versions v ON v.vault_id=f.vault_id AND v.revision=f.revision JOIN vaults a ON a.id=f.vault_id WHERE a.user_id=?", (vault["user_id"],)).fetchone()[0]
        if active_size - (previous["size"] if previous else 0) + size > USER_QUOTA_BYTES:
            raise HTTPException(413, "Account storage quota exceeded")
        history_size = connection.execute("SELECT COALESCE(SUM(v.size),0) FROM versions v JOIN vaults a ON a.id=v.vault_id WHERE a.user_id=?", (vault["user_id"],)).fetchone()[0]
        if history_size + size > HISTORY_QUOTA_BYTES:
            raise HTTPException(413, "Account version history quota exceeded; export or remove old vaults")
        revision = vault["revision"] + 1
        connection.execute("UPDATE vaults SET revision=? WHERE id=?", (revision, vault["id"]))
        connection.execute("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)", (vault["id"], revision, path, content, encoding, int(deleted), size, now_iso()))
        connection.execute("INSERT INTO files VALUES(?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET revision=excluded.revision", (vault["id"], path, revision))
        return file_output(connection.execute("SELECT * FROM versions WHERE vault_id=? AND revision=?", (vault["id"], revision)).fetchone())

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "vaultdesk", "version": "1.0.0", "end_to_end_encryption": False, "https_required_for_remote": True}

    @app.post("/auth/register", status_code=201)
    def register(body: Credentials, request: Request):
        throttle(request)
        if os.getenv("VAULTDESK_ALLOW_REGISTRATION", "true").lower() not in ("true", "1", "yes"):
            raise HTTPException(403, "New account registration is disabled")
        account = {"id": secrets.token_hex(16), "email": body.email, "created_at": now_iso()}
        hashed_password = password_hash(body.password)
        with database(True) as connection:
            try:
                connection.execute("INSERT INTO users VALUES(?,?,?,?)", (account["id"], account["email"], hashed_password, account["created_at"]))
            except sqlite3.IntegrityError:
                raise HTTPException(409, "Email is already registered")
            return session(connection, account)

    @app.post("/auth/login")
    def login(body: Credentials, request: Request):
        throttle(request)
        with database() as connection:
            row = connection.execute("SELECT * FROM users WHERE email=?", (body.email,)).fetchone()
        valid = check_password(body.password, row["password_hash"] if row else dummy_password_hash)
        if not row or not valid:
            raise HTTPException(401, "Incorrect email or password")
        with database(True) as connection:
            return session(connection, {key: row[key] for key in ("id", "email", "created_at")})

    @app.get("/auth/me")
    def me(account: dict = Depends(user)):
        return {"user": account}

    @app.post("/auth/logout", status_code=204)
    def logout(request: Request, account: dict = Depends(user)):
        with database(True) as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(request.headers["Authorization"][7:]),))
        return Response(status_code=204)

    @app.get("/vaults")
    def list_vaults(account: dict = Depends(user)):
        with database() as connection:
            return {"vaults": [dict(row) for row in connection.execute("SELECT id,name,revision,created_at FROM vaults WHERE user_id=? ORDER BY created_at,id", (account["id"],))]}

    @app.post("/vaults", status_code=201)
    def create_vault(body: VaultInput, account: dict = Depends(user)):
        vault = {"id": secrets.token_hex(16), "name": body.name, "revision": 0, "created_at": now_iso()}
        with database(True) as connection:
            if connection.execute("SELECT COUNT(*) FROM vaults WHERE user_id=?", (account["id"],)).fetchone()[0] >= 100:
                raise HTTPException(409, "Account limit of 100 vaults reached")
            connection.execute("INSERT INTO vaults VALUES(?,?,?,?,?)", (vault["id"], account["id"], vault["name"], 0, vault["created_at"]))
        return vault

    @app.get("/vaults/{vault_id}")
    def get_vault(vault_id: str, account: dict = Depends(user)):
        with database() as connection:
            row = own_vault(connection, vault_id, account)
            return {key: row[key] for key in ("id", "name", "revision", "created_at")}

    @app.patch("/vaults/{vault_id}")
    def rename_vault(vault_id: str, body: VaultInput, account: dict = Depends(user)):
        with database(True) as connection:
            own_vault(connection, vault_id, account)
            connection.execute("UPDATE vaults SET name=? WHERE id=?", (body.name, vault_id))
        return {"id": vault_id, "name": body.name}

    @app.delete("/vaults/{vault_id}", status_code=204)
    def delete_vault(vault_id: str, account: dict = Depends(user)):
        with database(True) as connection:
            own_vault(connection, vault_id, account)
            connection.execute("DELETE FROM vaults WHERE id=?", (vault_id,))
        return Response(status_code=204)

    @app.get("/vaults/{vault_id}/files")
    def read_file(vault_id: str, path: str, account: dict = Depends(user)):
        try:
            path = valid_path(path)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        with database() as connection:
            own_vault(connection, vault_id, account)
            row = current_file(connection, vault_id, path)
            if not row or row["deleted"]:
                raise HTTPException(404, "File not found")
            return file_output(row)

    @app.put("/vaults/{vault_id}/files")
    def write_file(vault_id: str, body: FileWrite, account: dict = Depends(user)):
        try:
            content = body.content.encode("utf-8") if body.encoding == "utf8" else base64.b64decode(body.content, validate=True)
        except (UnicodeError, binascii.Error, ValueError):
            raise HTTPException(422, "Content is not valid for its encoding")
        if len(content) > MAX_FILE_BYTES:
            raise HTTPException(413, "File exceeds configured byte limit")
        with database(True) as connection:
            vault = own_vault(connection, vault_id, account)
            return apply_version(connection, vault, body.path, body.base_revision, content, body.encoding, False)

    @app.delete("/vaults/{vault_id}/files")
    def delete_file(vault_id: str, body: FileDelete, account: dict = Depends(user)):
        with database(True) as connection:
            vault = own_vault(connection, vault_id, account)
            return apply_version(connection, vault, body.path, body.base_revision, None, "utf8", True)

    @app.get("/vaults/{vault_id}/changes")
    def changes(vault_id: str, cursor: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100), account: dict = Depends(user)):
        with database() as connection:
            # One read transaction ensures the revision and event page agree.
            connection.execute("BEGIN")
            vault = own_vault(connection, vault_id, account)
            if cursor > vault["revision"]:
                raise HTTPException(400, "Cursor is ahead of this vault; reset to zero")
            rows = connection.execute("SELECT * FROM versions WHERE vault_id=? AND revision>? ORDER BY revision LIMIT ?", (vault_id, cursor, limit))
            result, total_size = [], 0
            for row in rows:
                if result and total_size + row["size"] > 32 * 1024 * 1024:
                    break
                result.append(file_output(row))
                total_size += row["size"]
            next_cursor = result[-1]["revision"] if result else vault["revision"]
            return {"changes": result, "cursor": next_cursor, "has_more": next_cursor < vault["revision"]}

    @app.get("/vaults/{vault_id}/history")
    def history(vault_id: str, path: str, before: int | None = Query(None, gt=0), limit: int = Query(100, ge=1, le=100), account: dict = Depends(user)):
        try:
            path = valid_path(path)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        with database() as connection:
            own_vault(connection, vault_id, account)
            rows = connection.execute("SELECT * FROM versions WHERE vault_id=? AND path=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?", (vault_id, path, before, before, limit + 1)).fetchall()
            page = rows[:limit]
            return {"history": [file_output(row, content=False) for row in page], "next_before": page[-1]["revision"] if len(rows) > limit else None}

    @app.post("/vaults/{vault_id}/restore")
    def restore(vault_id: str, body: FileRestore, account: dict = Depends(user)):
        with database(True) as connection:
            vault = own_vault(connection, vault_id, account)
            source = connection.execute("SELECT * FROM versions WHERE vault_id=? AND path=? AND revision=?", (vault_id, body.path, body.revision)).fetchone()
            if not source or source["deleted"]:
                raise HTTPException(404, "A non-deleted file version is required")
            return apply_version(connection, vault, body.path, body.base_revision, source["content"], source["encoding"], False)

    def site_output(connection, row):
        result = {key: row[key] for key in ("id", "vault_id", "slug", "title", "created_at", "updated_at")}
        result["paths"] = [item[0] for item in connection.execute("SELECT path FROM published_files WHERE site_id=? ORDER BY path", (row["id"],))]
        result["url"] = "/p/" + row["slug"] + "/"
        return result

    def publish(connection, body: SiteInput, account: dict, site_id: str | None = None):
        own_vault(connection, body.vault_id, account)
        if site_id:
            own_site(connection, site_id, account)
        else:
            if connection.execute("SELECT COUNT(*) FROM sites WHERE user_id=?", (account["id"],)).fetchone()[0] >= 100:
                raise HTTPException(409, "Account limit of 100 sites reached")
        snapshots = []
        for path in body.paths:
            row = current_file(connection, body.vault_id, path)
            if not row or row["deleted"]:
                raise HTTPException(422, {"code": "missing_publish_file", "path": path})
            snapshots.append(row)
        public_size = connection.execute("SELECT COALESCE(SUM(length(p.content)),0) FROM published_files p JOIN sites s ON s.id=p.site_id WHERE s.user_id=? AND s.id!=?", (account["id"], site_id or "")).fetchone()[0]
        if public_size + sum(row["size"] for row in snapshots) > USER_QUOTA_BYTES:
            raise HTTPException(413, "Published snapshot storage quota exceeded")
        stamp = now_iso()
        try:
            if site_id:
                connection.execute("UPDATE sites SET vault_id=?,slug=?,title=?,updated_at=? WHERE id=?", (body.vault_id, body.slug, body.title, stamp, site_id))
                connection.execute("DELETE FROM published_files WHERE site_id=?", (site_id,))
            else:
                site_id = secrets.token_hex(16)
                connection.execute("INSERT INTO sites VALUES(?,?,?,?,?,?,?)", (site_id, account["id"], body.vault_id, body.slug, body.title, stamp, stamp))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Public slug is already in use")
        connection.executemany("INSERT INTO published_files VALUES(?,?,?,?,?)", [(site_id, row["path"], row["content"], row["encoding"], row["revision"]) for row in snapshots])
        return site_output(connection, connection.execute("SELECT * FROM sites WHERE id=?", (site_id,)).fetchone())

    @app.get("/sites")
    def list_sites(account: dict = Depends(user)):
        with database() as connection:
            return {"sites": [site_output(connection, row) for row in connection.execute("SELECT * FROM sites WHERE user_id=? ORDER BY created_at,id", (account["id"],)).fetchall()]}

    @app.post("/sites", status_code=201)
    def create_site(body: SiteInput, account: dict = Depends(user)):
        with database(True) as connection:
            return publish(connection, body, account)

    @app.patch("/sites/{site_id}")
    def update_site(site_id: str, body: SitePatch, account: dict = Depends(user)):
        with database(True) as connection:
            existing = own_site(connection, site_id, account)
            values = {key: body.model_dump().get(key) or existing[key] for key in ("vault_id", "slug", "title")}
            return publish(connection, SiteInput(**values, paths=body.paths), account, site_id)

    @app.delete("/sites/{site_id}", status_code=204)
    def unpublish(site_id: str, account: dict = Depends(user)):
        with database(True) as connection:
            own_site(connection, site_id, account)
            connection.execute("DELETE FROM sites WHERE id=?", (site_id,))
        return Response(status_code=204)

    @app.get("/p/{slug}/", response_class=HTMLResponse)
    def public_index(slug: str):
        with database() as connection:
            site = connection.execute("SELECT * FROM sites WHERE slug=?", (slug,)).fetchone()
            if not site:
                raise HTTPException(404, "Site not found")
            paths = [row[0] for row in connection.execute("SELECT path FROM published_files WHERE site_id=? ORDER BY path", (site["id"],))]
            content = "<h1>" + html.escape(site["title"]) + "</h1><ul>" + "".join('<li><a href="' + html.escape(public_url(slug, path), quote=True) + '">' + html.escape(path) + "</a></li>" for path in paths) + "</ul>"
            return HTMLResponse(page_html(site["title"], content), headers=PUBLIC_HEADERS)

    @app.get("/p/{slug}/{path:path}")
    def public_page(slug: str, path: str):
        try:
            path = valid_path(path)
        except ValueError:
            raise HTTPException(404, "Published file not found")
        with database() as connection:
            site = connection.execute("SELECT * FROM sites WHERE slug=?", (slug,)).fetchone()
            row = connection.execute("SELECT p.* FROM published_files p JOIN sites s ON s.id=p.site_id WHERE s.slug=? AND p.path=?", (slug, path)).fetchone()
            if not site or not row:
                raise HTTPException(404, "Published file not found")
            paths = {item[0] for item in connection.execute("SELECT path FROM published_files WHERE site_id=?", (site["id"],))}
        suffix = PurePosixPath(path).suffix.lower()
        if suffix in (".md", ".markdown"):
            try:
                source = bytes(row["content"]).decode("utf-8")
            except UnicodeError:
                raise HTTPException(422, "Published Markdown is not UTF-8")
            content = render_markdown(source, slug, path, paths)
            return HTMLResponse(page_html(site["title"], content, slug), headers=PUBLIC_HEADERS)
        headers = dict(PUBLIC_HEADERS)
        if suffix not in SAFE_IMAGE_TYPES:
            headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(PurePosixPath(path).name, safe="")
        return Response(bytes(row["content"]), media_type=SAFE_IMAGE_TYPES.get(suffix, "application/octet-stream"), headers=headers)

    return app


def public_url(slug: str, path: str) -> str:
    return "/p/" + slug + "/" + quote(path, safe="/")


def render_markdown(source: str, slug: str, path: str, selected: set[str]) -> str:
    parser = MarkdownIt("commonmark", {"html": False, "breaks": True}).enable("table").enable("strikethrough")

    def safe_target(href: str, image: bool = False) -> str | None:
        try:
            parsed = urlsplit(href)
        except ValueError:
            return None
        if parsed.scheme or parsed.netloc:
            return href if not image and parsed.scheme.lower() in ("https", "http", "mailto") else None
        if href.startswith("#"):
            return href if not image else None
        target = unquote(parsed.path)
        if target.startswith("/") or "\\" in target:
            return None
        parts = list(PurePosixPath(path).parent.parts)
        for part in target.split("/"):
            if part == "..":
                if not parts:
                    return None
                parts.pop()
            elif part and part != ".":
                parts.append(part)
        resolved = "/".join(parts)
        if resolved not in selected and resolved + ".md" in selected:
            resolved += ".md"
        if resolved not in selected:
            matches = [candidate for candidate in selected if PurePosixPath(candidate).name in (target, target + ".md")]
            if len(matches) == 1:
                resolved = matches[0]
        if resolved not in selected or (image and PurePosixPath(resolved).suffix.lower() not in SAFE_IMAGE_TYPES):
            return None
        return public_url(slug, resolved) + ("#" + quote(unquote(parsed.fragment), safe="-_") if parsed.fragment else "")

    # Convert only text wiki references; code tokens remain literal. Obsidian
    # transclusions are links unless an explicitly selected image is referenced.
    def wiki_rule(state, silent):
        start = state.pos
        embed = state.src.startswith("![[", start)
        offset = 3 if embed else 2
        if not embed and not state.src.startswith("[[", start):
            return False
        end = state.src.find("]]", start + offset)
        if end < 0:
            return False
        raw = state.src[start + offset:end]
        if "\n" in raw:
            return False
        target, separator, alias = raw.partition("|")
        label = alias if separator else target
        if not silent:
            image_target = safe_target(target, image=True) if embed else None
            if image_target:
                token = state.push("html_inline", "", 0)
                token.content = '<img src="' + html.escape(image_target, quote=True) + '" alt="' + html.escape(label, quote=True) + '">'
            else:
                token = state.push("link_open", "a", 1)
                token.attrSet("href", target)
                token = state.push("text", "", 0)
                token.content = label
                state.push("link_close", "a", -1)
        state.pos = end + 2
        return True

    parser.inline.ruler.before("link", "wiki_link", wiki_rule)
    tokens = parser.parse(source)

    def rewrite(items):
        for token in items:
            if token.type == "link_open":
                href = safe_target(token.attrGet("href") or "")
                token.attrs.pop("href", None)
                if href:
                    token.attrSet("href", href)
                    token.attrSet("rel", "noopener noreferrer")
            if token.type == "image":
                src = safe_target(token.attrGet("src") or "", image=True)
                if src:
                    token.attrSet("src", src)
                else:
                    token.type = "text"
                    token.tag = ""
                    token.content = "[Image not selected for publication]"
                    token.children = None
            if token.children:
                rewrite(token.children)

    rewrite(tokens)
    rendered = parser.renderer.render(tokens, parser.options, {})
    return bleach.clean(rendered, tags={"p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "del", "blockquote", "pre", "code", "a", "img", "table", "thead", "tbody", "tr", "th", "td"}, attributes={"a": ["href", "title", "rel"], "img": ["src", "alt", "title"], "ol": ["start"], "code": ["class"]}, protocols={"http", "https", "mailto"}, strip=True)


def page_html(title: str, content: str, slug: str | None = None) -> str:
    navigation = '<nav><a href="/p/' + slug + '/">' + html.escape(title) + "</a></nav>" if slug else ""
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + html.escape(title) + '</title><style>body{max-width:860px;margin:40px auto;padding:0 24px;font:17px/1.7 system-ui,sans-serif;color:#282735;background:#faf9fc}a{color:#7054bd}nav{border-bottom:1px solid #dedbe6;padding-bottom:16px;margin-bottom:32px}pre{overflow:auto;background:#efedf4;padding:16px;border-radius:8px}code{font-family:ui-monospace,monospace}img{max-width:100%;height:auto}blockquote{border-left:3px solid #9d89cd;padding-left:18px;color:#686275}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 12px}</style></head><body>' + navigation + "<main>" + content + "</main></body></html>"


app = create_app()
