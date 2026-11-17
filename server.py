#!/usr/bin/env python3
"""Polarboard: a small self-hosted markdown notes server.

Standard library only. Notes are plain .md files inside vault folders, so a
vault can be opened by Obsidian, VS Code, or anything else at any time.

Layout on disk (DATA defaults to the folder this file is in):
  DATA/vault/                  the main vault (POLARBOARD_VAULT overrides)
  DATA/vaults/<id>/            accounts created from the app (each account is a vault)
  DATA/.polarboard-server/     account list, sessions, share links, account pictures
  <vault>/.polarboard/         per-vault data: dates, tags, history, tokens
"""

import base64
import hashlib
import hmac
import io
import json
import mimetypes
import os
import posixpath
import queue
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.7.0"
STARTED = time.time()
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("POLARBOARD_DATA", ROOT)).resolve()
MAIN_VAULT = Path(os.environ.get("POLARBOARD_VAULT", DATA / "vault")).resolve()
HOST = os.environ.get("POLARBOARD_HOST", "0.0.0.0")
PORT = int(os.environ.get("POLARBOARD_PORT", "8787"))
# Optional "server password": when set, it is required to create or delete accounts.
ENV_PASSWORD = os.environ.get("POLARBOARD_PASSWORD", "")

SERVER_DIR = DATA / ".polarboard-server"
REGISTRY_FILE = SERVER_DIR / "server.json"
SESSIONS_FILE = SERVER_DIR / "sessions.json"
SHARES_FILE = SERVER_DIR / "shares.json"
GIT = shutil.which("git")

MAX_NOTE = 10 * 1024 * 1024
MAX_UPLOAD = 25 * 1024 * 1024
SESSION_DAYS = 30
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"}
SORTS = {"name", "name-desc", "modified", "modified-asc", "created", "created-asc"}
BAD_NAME = re.compile(r'[\\:*?"<>|#^\[\]\x00-\x1f]')
TAG_RE = re.compile(r"(?<![^\s(\[,;])#([\w/-]+)")
INLINE_CODE = re.compile(r"`+[^`]*`+")
DEFAULT_CONFIG = {
    "history": {"enabled": True, "interval": 10, "keep": 50, "days": 0},
    "trashDays": 30,
    "attachmentFolder": "attachments",
    "git": {"enabled": False, "interval": 30, "remote": "", "push": False, "message": "Polarboard: {count} files changed"},
}
GITIGNORE = "# Added by Polarboard\n.trash/\n.polarboard/history/\n.polarboard/auth.json\n.polarboard/config.json\n.polarboard/trash.json\n.polarboard/search.db*\n*.tmp\n"
MAX_IMPORT = 300 * 1024 * 1024
IMPORT_TEXT = {".md", ".markdown", ".txt"}
IMPORT_FILES = IMAGE_EXT | {".pdf"}


def fts5_available():
    try:
        c = sqlite3.connect(":memory:")
        c.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        c.close()
        return True
    except sqlite3.Error:
        return False


FTS5 = fts5_available()
PBKDF2_ROUNDS = 240_000

REG_LOCK = threading.RLock()
REGISTRY: dict = {"vaults": {}, "accounts": {}}
VAULTS: dict = {}
SESSIONS: dict = {}
SHARES: dict = {}
VERIFIED: dict = {}  # sha(Authorization header) -> user, so PBKDF2 runs once per login
LOGIN_FAILS: dict = {}
_last_sessions_save = 0.0

APP_CSP = (
    "default-src 'self'; img-src 'self' data: blob: https: http:; "
    "style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
    # wasm-unsafe-eval lets the Harper spellchecker run WebAssembly; it does not allow eval().
    "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'self'; manifest-src 'self'"
)
# Vault files (e.g. an uploaded SVG) must never run script in the app's origin.
VAULT_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"


class ApiError(Exception):
    def __init__(self, status, msg, **extra):
        super().__init__(msg)
        self.status, self.msg, self.extra = status, msg, extra


class Raw:
    """A non-JSON response (used for the vault backup download)."""
    def __init__(self, data, ctype, headers=None):
        self.data, self.ctype, self.headers = data, ctype, headers or {}


class Stream:
    """Marks a route that streams Server-Sent Events."""


def now_ms():
    return int(time.time() * 1000)


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def load_json(p, default):
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def save_json(p, data, private=False):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, sort_keys=True), "utf-8")
    if private:
        os.chmod(tmp, 0o600)
    os.replace(tmp, p)


def clean_name(name, fallback="Untitled"):
    name = BAD_NAME.sub("", str(name or "")).replace("/", "-")
    name = re.sub(r"\s+", " ", name).strip(" .")[:120]
    return name or fallback


def clean_tag(t):
    t = re.sub(r"\s+", "-", str(t).strip().lstrip("#"))
    t = re.sub(r"[^\w/-]", "", t).strip("/-")[:60]
    return t if any(c.isalpha() for c in t) else ""


def clean_tags(tags):
    out, seen = [], set()
    for t in tags if isinstance(tags, list) else []:
        t = clean_tag(t)
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out


def dedupe(tags):
    seen, out = set(), []
    for tag in tags:
        if tag and any(c.isalpha() for c in tag) and tag.lower() not in seen:
            seen.add(tag.lower())
            out.append(tag)
    return out


def frontmatter_tags(text):
    if not text.startswith("---\n"):
        return []
    end = text.find("\n---", 4)
    if end < 0:
        return []
    out, in_list = [], False
    for line in text[4:end].splitlines():
        if re.match(r"^tags\s*:", line):
            value = line.split(":", 1)[1].strip().strip("[]")
            out += [t.strip().strip("'\"#") for t in value.split(",") if t.strip()]
            in_list = not value
        elif in_list and re.match(r"^\s*-\s+", line):
            out.append(line.split("-", 1)[1].strip().strip("'\"#"))
        else:
            in_list = False
    return out


def extract_tags(text):
    found, in_fence = frontmatter_tags(text), False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if not in_fence:
            found += [m.group(1).rstrip("/-") for m in TAG_RE.finditer(INLINE_CODE.sub("", line))]
    return dedupe(found)


def unique_path(p):
    if not p.exists():
        return p
    stem, suffix = (p.stem, p.suffix) if p.suffix else (p.name, "")
    n = 2
    while True:
        candidate = p.with_name(f"{stem} {n}{suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def atomic_write(p, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, p)


def dir_size(p):
    count = size = 0
    for dirpath, _, files in os.walk(p):
        for f in files:
            try:
                size += (Path(dirpath) / f).stat().st_size
                count += 1
            except OSError:
                pass
    return count, size


def hash_pw(pw, salt):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS).hex()


def new_password(pw):
    if len(pw) < 8:
        raise ApiError(400, "Use at least 8 characters")
    salt = secrets.token_hex(16)
    return {"salt": salt, "hash": hash_pw(pw, salt)}


# ===================================================================== vault

class Vault:
    """Everything that belongs to one vault: its files, metadata, history,
    trash, API tokens and live-update subscribers."""

    def __init__(self, vid, name, root):
        self.id, self.name, self.root = vid, name, Path(root).resolve()
        self.polar = self.root / ".polarboard"
        self.trash = self.root / ".trash"
        self.history = self.polar / "history"
        self.lock = threading.RLock()
        self.tag_cache = {}
        self.subscribers = set()
        self.last_purge = 0.0
        self.git_last = time.time()
        self.git_error = ""
        self.index_lock = threading.Lock()
        self.index_dirty = True
        self.index_checked = 0.0
        self.root.mkdir(parents=True, exist_ok=True)
        self.meta = load_json(self.polar / "meta.json", {})
        saved = load_json(self.polar / "config.json", {})
        self.config = json.loads(json.dumps(DEFAULT_CONFIG))
        for k, v in saved.items():
            if isinstance(v, dict) and isinstance(self.config.get(k), dict):
                self.config[k].update(v)
            elif k in self.config:
                self.config[k] = v
        self.auth = load_json(self.polar / "auth.json", {})

    # -- persistence
    def save_meta(self):
        save_json(self.polar / "meta.json", self.meta)

    def save_config(self):
        save_json(self.polar / "config.json", self.config)

    def save_auth(self):
        save_json(self.polar / "auth.json", self.auth, private=True)

    def public(self):
        return account_public(self.id)

    # -- events
    def publish(self, kind, paths=(), client=""):
        self.index_dirty = True
        event = {"type": kind, "paths": list(paths), "client": client, "at": now_ms()}
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    # -- paths
    def rel(self, p):
        return p.relative_to(self.root).as_posix()

    def resolve(self, rel, note=False):
        rel = (rel or "").replace("\\", "/").strip().strip("/")
        if not rel or "\x00" in rel:
            raise ApiError(400, "Missing path")
        p = (self.root / rel).resolve()
        if p == self.root or self.root not in p.parents:
            raise ApiError(400, "Path is outside the vault")
        if any(part.startswith(".") for part in p.relative_to(self.root).parts):
            raise ApiError(400, "Hidden paths are not allowed")
        if note and p.suffix.lower() != ".md":
            raise ApiError(400, "Notes must end in .md")
        return p

    def attach_rel(self):
        return self.config.get("attachmentFolder") or "attachments"

    def skip_dir(self, here, d):
        return d.startswith(".") or self.rel(here / d) == self.attach_rel()

    def iter_notes(self):
        for dirpath, dirnames, filenames in os.walk(self.root):
            here = Path(dirpath)
            dirnames[:] = sorted(d for d in dirnames if not self.skip_dir(here, d))
            for f in sorted(filenames):
                if f.lower().endswith(".md") and not f.startswith("."):
                    yield here / f

    def files(self):
        """Non-note files (images, PDFs), wherever they are, for resolving embeds."""
        out = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for f in filenames:
                if not f.startswith(".") and not f.lower().endswith(".md"):
                    out.append(self.rel(Path(dirpath) / f))
        return sorted(out)

    # -- search index (SQLite FTS5, kept in .polarboard/search.db)
    def index_db(self):
        self.polar.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.polar / "search.db", timeout=10)
        db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3')")
        db.execute("CREATE TABLE IF NOT EXISTS seen (path TEXT PRIMARY KEY, version TEXT, docid INTEGER)")
        return db

    def sync_index(self):
        """Bring the index up to date with the files, re-reading only notes that changed."""
        with self.index_lock:
            if not self.index_dirty and time.time() - self.index_checked < 30:
                return
            db = self.index_db()
            try:
                seen = {p: (ver, docid) for p, ver, docid in db.execute("SELECT path, version, docid FROM seen")}
                current = set()
                for p in self.iter_notes():
                    rel = self.rel(p)
                    current.add(rel)
                    try:
                        ver = str(p.stat().st_mtime_ns)
                    except OSError:
                        continue
                    old = seen.get(rel)
                    if old and old[0] == ver:
                        continue
                    if old:
                        db.execute("DELETE FROM docs WHERE rowid = ?", (old[1],))
                    text = searchable(p.read_text("utf-8", errors="replace"))
                    docid = db.execute("INSERT INTO docs (title, body) VALUES (?, ?)", (p.stem, text)).lastrowid
                    db.execute("INSERT OR REPLACE INTO seen VALUES (?, ?, ?)", (rel, ver, docid))
                for rel in set(seen) - current:
                    db.execute("DELETE FROM docs WHERE rowid = ?", (seen[rel][1],))
                    db.execute("DELETE FROM seen WHERE path = ?", (rel,))
                db.commit()
            finally:
                db.close()
            self.index_dirty = False
            self.index_checked = time.time()

    def folders(self):
        out = []
        for dirpath, dirnames, _ in os.walk(self.root):
            here = Path(dirpath)
            dirnames[:] = [d for d in dirnames if not self.skip_dir(here, d)]
            out += [self.rel(here / d) for d in dirnames]
        return sorted(out)

    # -- metadata
    def created_ms(self, rel, st):
        entry = self.meta.setdefault(rel, {})
        if "created" not in entry:
            born = getattr(st, "st_birthtime", None) or st.st_mtime
            entry["created"] = int(born * 1000)
        return entry["created"]

    def tags_for(self, path, rel, st):
        key = (st.st_mtime_ns, st.st_size)
        hit = self.tag_cache.get(rel)
        if hit and hit[0] == key:
            return hit[1]
        try:
            tags = extract_tags(path.read_text("utf-8", errors="replace"))
        except OSError:
            tags = []
        self.tag_cache[rel] = (key, tags)
        return tags

    def note_info(self, p, st=None):
        st = st or p.stat()
        rel = self.rel(p)
        own = self.meta.get(rel, {}).get("tags", [])
        inherited, parts = [], rel.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            folder = "/".join(parts[:i])
            inherited += [{"tag": t, "folder": folder} for t in self.meta.get(folder, {}).get("tags", [])]
        return {
            "path": rel,
            "version": str(st.st_mtime_ns),
            "modified": st.st_mtime_ns // 1_000_000,
            "created": self.created_ms(rel, st),
            "size": st.st_size,
            "tags": dedupe(self.tags_for(p, rel, st) + own + [x["tag"] for x in inherited]),
            "ownTags": own,
            "inherited": inherited,
            "pinned": bool(self.meta.get(rel, {}).get("pinned")),
        }

    def meta_move(self, old, new):
        def moved(key):
            if key == old:
                return new
            if key.startswith(old + "/"):
                return new + key[len(old):]
            return None

        for table in (self.meta, self.tag_cache):
            for key in list(table):
                target = moved(key)
                if target:
                    table[target] = table.pop(key)
        for entry in self.meta.values():
            if isinstance(entry, dict) and entry.get("note"):
                target = moved(entry["note"])
                if target:
                    entry["note"] = target
        src, dst = self.history / old, self.history / new
        if src.exists() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
        with REG_LOCK:
            changed = False
            for info in SHARES.values():
                if info["vault"] == self.id:
                    target = moved(info["path"])
                    if target:
                        info["path"] = target
                        changed = True
            if changed:
                save_json(SHARES_FILE, SHARES, private=True)
        self.save_meta()

    def meta_drop(self, rel):
        for table in (self.meta, self.tag_cache):
            for key in list(table):
                if key == rel or key.startswith(rel + "/"):
                    table.pop(key, None)
        for entry in self.meta.values():
            if isinstance(entry, dict) and entry.get("note") and (entry["note"] == rel or entry["note"].startswith(rel + "/")):
                entry.pop("note")
        self.save_meta()

    # -- history
    def snapshot(self, rel, text, force=False):
        """Keep the previous version of a note, at most once per interval."""
        h = self.config["history"]
        if not h.get("enabled") or not text.strip():
            return
        d = self.history / rel
        stamps = [int(f.stem) for f in d.glob("*.md") if f.stem.isdigit()] if d.is_dir() else []
        now = now_ms()
        if not force and stamps and now - max(stamps) < h.get("interval", 10) * 60_000:
            return
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{now}.md").write_text(text, "utf-8")
        self.prune_history(d)

    def prune_history(self, d):
        h = self.config["history"]
        files = sorted((f for f in d.glob("*.md") if f.stem.isdigit()), key=lambda f: -int(f.stem))
        cutoff = now_ms() - h.get("days", 0) * 86_400_000 if h.get("days") else None
        for i, f in enumerate(files):
            if (h.get("keep") and i >= h["keep"]) or (cutoff and int(f.stem) < cutoff):
                f.unlink(missing_ok=True)
        if d.is_dir() and not any(d.iterdir()):
            d.rmdir()

    def prune_all_history(self):
        if self.history.is_dir():
            for dirpath, _, files in list(os.walk(self.history)):
                if any(f.endswith(".md") for f in files):
                    self.prune_history(Path(dirpath))

    # -- trash
    def to_trash(self, p):
        rel = self.rel(p)
        dest = unique_path(self.trash / rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), str(dest))
        index = load_json(self.polar / "trash.json", {})
        index[dest.relative_to(self.trash).as_posix()] = {"from": rel, "deleted": now_ms(), "dir": dest.is_dir()}
        save_json(self.polar / "trash.json", index)

    def trash_items(self):
        index = load_json(self.polar / "trash.json", {})
        items = []
        for tid, info in list(index.items()):
            p = self.trash / tid
            if not p.exists():
                index.pop(tid)
                continue
            count, size = dir_size(p) if p.is_dir() else (1, p.stat().st_size)
            items.append({"id": tid, **info, "size": size, "files": count})
        if self.trash.is_dir():  # files trashed before the index existed
            for dirpath, _, files in os.walk(self.trash):
                for f in files:
                    rel = (Path(dirpath) / f).relative_to(self.trash).as_posix()
                    if not any(rel == k or rel.startswith(k + "/") for k in index):
                        st = (Path(dirpath) / f).stat()
                        items.append({"id": rel, "from": rel, "deleted": int(st.st_mtime * 1000), "dir": False, "size": st.st_size, "files": 1})
        save_json(self.polar / "trash.json", index)
        return sorted(items, key=lambda x: -x["deleted"])

    def trash_remove(self, tid):
        p = (self.trash / tid).resolve()
        if self.trash.resolve() not in p.parents:
            raise ApiError(400, "Bad trash item")
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()
        index = load_json(self.polar / "trash.json", {})
        index.pop(tid, None)
        save_json(self.polar / "trash.json", index)

    def purge_trash(self):
        days = self.config.get("trashDays") or 0
        if not days or time.time() - self.last_purge < 3600:
            return
        self.last_purge = time.time()
        cutoff = now_ms() - days * 86_400_000
        for item in self.trash_items():
            if item["deleted"] < cutoff:
                self.trash_remove(item["id"])

    def remove(self, p, permanent):
        rel = self.rel(p)
        if permanent:
            shutil.rmtree(p) if p.is_dir() else p.unlink()
            shutil.rmtree(self.history / rel, ignore_errors=True)
        else:
            self.to_trash(p)
        self.meta_drop(rel)

    # -- links
    def link_patterns(self, rel):
        stem, noext = Path(rel).stem, rel[:-3]
        names = "|".join(re.escape(x) for x in {stem, noext})
        wiki = re.compile(r"\[\[(?:" + names + r")(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]", re.I)
        md = re.compile(r"\]\((?:\./)?(?:" + "|".join(re.escape(x) for x in {rel, urllib.parse.quote(rel)}) + r")(?:#[^)]*)?\)")
        return wiki, md

    def relink(self, old, new):
        """Point [[wikilinks]] and markdown links at a renamed or moved note."""
        old_stem, new_stem = Path(old).stem, Path(new).stem
        rules = []
        if old[:-3] != new[:-3] and "/" in old:
            rules.append((re.compile(r"\[\[" + re.escape(old[:-3]) + r"(?=[\]|#])", re.I), "[[" + new[:-3]))
        if old_stem != new_stem:
            rules.append((re.compile(r"\[\[" + re.escape(old_stem) + r"(?=[\]|#])", re.I), "[[" + new_stem))
        for variant in {old, urllib.parse.quote(old)}:
            rules.append((re.compile(r"\]\((?:\./)?" + re.escape(variant) + r"(?=[)#])"), "](" + urllib.parse.quote(new)))
        changed = []
        for p in self.iter_notes():
            try:
                text = p.read_text("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            updated = text
            for rx, repl in rules:
                updated = rx.sub(lambda m: repl, updated)
            if updated != text:
                self.snapshot(self.rel(p), text)
                atomic_write(p, updated.encode("utf-8"))
                changed.append(self.rel(p))
        return changed

    # -- git
    def git(self, *args, timeout=60):
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": os.environ.get("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")}
        return subprocess.run([GIT, "-C", str(self.root), *args], capture_output=True, text=True, timeout=timeout, env=env)

    def git_ensure(self):
        if not GIT:
            raise ApiError(501, "git is not installed on the server")
        if not (self.root / ".git").exists():
            self.git("init", "-q")
        ignore = self.root / ".gitignore"
        current = ignore.read_text("utf-8") if ignore.exists() else ""
        if "Added by Polarboard" not in current:
            ignore.write_text(current + ("\n" if current and not current.endswith("\n") else "") + GITIGNORE, "utf-8")
        if not self.git("config", "user.name").stdout.strip():
            self.git("config", "user.name", "Polarboard")
            self.git("config", "user.email", "polarboard@localhost")
        remote = self.config["git"].get("remote", "").strip()
        have = self.git("remote", "get-url", "origin")
        if remote and have.returncode != 0:
            self.git("remote", "add", "origin", remote)
        elif remote and have.stdout.strip() != remote:
            self.git("remote", "set-url", "origin", remote)

    def git_commit(self, push=None):
        with self.lock:
            self.git_ensure()
            status = self.git("status", "--porcelain").stdout.splitlines()
            committed = False
            if status:
                self.git("add", "-A")
                msg = self.config["git"].get("message") or "Polarboard: {count} files changed"
                r = self.git("commit", "-q", "-m", msg.replace("{count}", str(len(status))))
                if r.returncode != 0:
                    self.git_error = (r.stderr or r.stdout).strip()[:500]
                    raise ApiError(500, f"git commit failed: {self.git_error}")
                committed = True
            self.git_last = time.time()
            self.git_error = ""
        if (push if push is not None else self.config["git"].get("push")) and self.config["git"].get("remote"):
            r = self.git("push", "-q", "origin", "HEAD", timeout=120)
            if r.returncode != 0:
                self.git_error = (r.stderr or r.stdout).strip()[:500]
                raise ApiError(502, f"git push failed: {self.git_error}")
        return {"committed": committed, "files": len(status)}


def git_loop():
    while True:
        time.sleep(30)
        for v in list(VAULTS.values()):
            g = v.config.get("git", {})
            if g.get("enabled") and GIT and time.time() - v.git_last >= max(1, g.get("interval", 30)) * 60:
                try:
                    v.git_commit()
                except Exception as e:  # keep looping; the error shows in Settings
                    v.git_error = str(getattr(e, "msg", e))[:500]
                    v.git_last = time.time()


# ================================================================ accounts
# An account *is* a vault: a named set of notes with an icon and an optional
# password. With no password, anyone who can reach the server can open it.

GLYPHS = ["feather", "snowflake", "mountain", "moon", "leaf", "book", "star", "flame", "coffee", "compass", "wave", "home", "heart", "code"]
ICON_DIR = SERVER_DIR / "icons"
ICON_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


def default_icon(aid):
    """Every account starts as a feather; the color differs per account."""
    return {"type": "glyph", "name": "feather", "hue": 212 if aid == "main" else int(sha(aid)[:8], 16) % 360}


def old_default_icon(aid):
    """What 0.5 and 0.6 assigned, so untouched defaults can move to the feather."""
    if aid == "main":
        return {"type": "glyph", "name": "snowflake", "hue": 212}
    old = ["snowflake", "mountain", "moon", "leaf", "book", "star", "flame", "coffee", "feather", "compass", "wave", "home", "heart", "code"]
    n = int(sha(aid)[:8], 16)
    return {"type": "glyph", "name": old[n % len(old)], "hue": n % 360}


def clean_icon(icon):
    if isinstance(icon, dict) and icon.get("type") == "glyph" and icon.get("name") in GLYPHS:
        try:
            hue = int(icon.get("hue", 212)) % 360
        except (TypeError, ValueError):
            hue = 212
        return {"type": "glyph", "name": icon["name"], "hue": hue}
    return None


def account_dir(entry):
    p = Path(entry["path"])
    return p if p.is_absolute() else DATA / p


def load_registry():
    global REGISTRY, SESSIONS, SHARES
    reg = load_json(REGISTRY_FILE, {})
    accounts = reg.get("accounts", {})
    if "vaults" in reg:  # 0.4.0 kept vaults and users apart; each vault becomes an account
        users, accounts = accounts, {}
        for vid, info in reg["vaults"].items():
            entry = {"name": info.get("name") or vid, "path": info["path"], "created": now_ms(), "icon": default_icon(vid)}
            owner = next((u for u in users.values() if vid in u.get("vaults", []) and u.get("hash")), None)
            if owner:
                entry["password"] = {"salt": owner["salt"], "hash": owner["hash"]}
            accounts[vid] = entry
    main = accounts.setdefault("main", {"name": "polarboard", "created": now_ms()})
    main["path"] = str(MAIN_VAULT)
    if main.get("name") in (None, "", "Main"):
        main["name"] = "polarboard"
    REGISTRY = {"accounts": accounts}
    for aid, a in accounts.items():
        if a.get("icon") == old_default_icon(aid):  # never picked by hand, so follow the new default
            a["icon"] = default_icon(aid)
        a.setdefault("icon", default_icon(aid))
        a.setdefault("created", now_ms())
        VAULTS[aid] = Vault(aid, a["name"], account_dir(a))
    # Sessions from 0.4.0 belonged to users, which no longer exist.
    SESSIONS = {k: s for k, s in load_json(SESSIONS_FILE, {}).items() if s.get("accounts")}
    SHARES = load_json(SHARES_FILE, {})
    v = VAULTS["main"]
    if v.auth.get("password") and not main.get("password"):  # 0.3 kept one password inside the vault
        main["password"] = v.auth.pop("password")
        v.auth.pop("user", None)
        v.save_auth()
    save_registry()


def save_registry():
    save_json(REGISTRY_FILE, REGISTRY, private=True)


def save_sessions():
    save_json(SESSIONS_FILE, SESSIONS, private=True)


def account_public(aid, h=None):
    a = REGISTRY["accounts"][aid]
    out = {"id": aid, "name": a["name"], "icon": a.get("icon") or default_icon(aid), "locked": bool(a.get("password")), "created": a.get("created")}
    if h is not None:
        out["open"] = h.can_open(aid)
    return out


def check_password(aid, pw):
    p = REGISTRY["accounts"].get(aid, {}).get("password")
    return bool(p) and hmac.compare_digest(hash_pw(pw, p["salt"]), p["hash"])


def check_server_password(pw):
    return not ENV_PASSWORD or hmac.compare_digest(str(pw or "").encode(), ENV_PASSWORD.encode())


def throttle(h):
    ip = h.client_ip()
    recent = [t for t in LOGIN_FAILS.get(ip, []) if time.time() - t < 600]
    if len(recent) >= 8:
        raise ApiError(429, "Too many attempts. Wait a few minutes and try again.")
    return ip, recent


def failed(ip, recent):
    LOGIN_FAILS[ip] = recent + [time.time()]
    time.sleep(0.4)


def unlock_session(h, aid, remember=True):
    """Remember in this browser's session that it has unlocked an account."""
    token = h.cookie("pb_session")
    s = SESSIONS.get(sha(token)) if token else None
    if not s:
        token = secrets.token_urlsafe(32)
        s = SESSIONS[sha(token)] = {"accounts": [], "created": now_ms(), "seen": now_ms(),
                                    "agent": (h.headers.get("User-Agent") or "")[:200], "ip": h.client_ip()}
        secure = "; Secure" if h.headers.get("X-Forwarded-Proto") == "https" else ""
        age = f"; Max-Age={SESSION_DAYS * 86400}" if remember else ""
        h.extra_headers["Set-Cookie"] = f"pb_session={token}; Path=/; HttpOnly; SameSite=Strict{age}{secure}"
    if aid not in s["accounts"]:
        s["accounts"].append(aid)
    h.session_accounts.add(aid)
    save_sessions()


def lock_session(h, aid=None):
    token = h.cookie("pb_session")
    s = SESSIONS.get(sha(token)) if token else None
    if not s:
        return
    s["accounts"] = [] if aid is None else [x for x in s["accounts"] if x != aid]
    h.session_accounts.discard(aid)
    if not s["accounts"]:
        SESSIONS.pop(sha(token))
        h.extra_headers["Set-Cookie"] = "pb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    save_sessions()


def forget_account_sessions(aid, keep=None):
    for k, s in list(SESSIONS.items()):
        if k != keep and aid in s["accounts"]:
            s["accounts"].remove(aid)
            if not s["accounts"]:
                SESSIONS.pop(k)
    for k in [k for k, x in VERIFIED.items() if x == aid]:
        VERIFIED.pop(k)
    save_sessions()


def remove_icon_files(aid):
    for ext in ICON_TYPES.values():
        (ICON_DIR / f"{aid}{ext}").unlink(missing_ok=True)


def seed(v):
    if any(True for _ in v.iter_notes()):
        return
    (v.root / "Welcome.md").write_text(WELCOME, "utf-8")
    (v.root / "Ideas").mkdir(exist_ok=True)
    (v.root / "Ideas" / "Ideas.md").write_text("A place for loose threads. #ideas\n\n- Things worth keeping\n- \n", "utf-8")


# ===================================================================== API
# Vault routes receive (handler, vault, query); global routes (handler, query).

def api_tree(h, v, q):
    with v.lock:
        v.purge_trash()
        notes, before = [], json.dumps(v.meta, sort_keys=True)
        folders = v.folders()
        for p in v.iter_notes():
            try:
                notes.append(v.note_info(p))
            except OSError:
                pass
        folder_meta = {}
        for f in folders:
            m = {k: val for k, val in v.meta.get(f, {}).items() if k in ("sort", "note", "tags")}
            if m:
                folder_meta[f] = m
        if json.dumps(v.meta, sort_keys=True) != before:
            v.save_meta()
        return {"folders": folders, "notes": notes, "folderMeta": folder_meta, "files": v.files(), "vault": v.public()}


def api_note_get(h, v, q):
    p = v.resolve(q.get("path"), note=True)
    if not p.is_file():
        raise ApiError(404, "Note not found")
    with v.lock:
        info = v.note_info(p)
    info["content"] = p.read_text("utf-8", errors="replace")
    return info


def api_note_put(h, v, q):
    p = v.resolve(q.get("path"), note=True)
    body = h.json_body(MAX_NOTE)
    content = body.get("content")
    if not isinstance(content, str):
        raise ApiError(400, "content must be a string")
    with v.lock:
        current = p.read_text("utf-8", errors="replace") if p.exists() else None
        if current is not None and body.get("base") and not body.get("force"):
            st = p.stat()
            if str(st.st_mtime_ns) != str(body["base"]) and current != content:
                raise ApiError(409, "Note changed elsewhere", **v.note_info(p, st), content=current)
        if current == content:
            return v.note_info(p)
        if current is not None:
            v.snapshot(v.rel(p), current)
        atomic_write(p, content.encode("utf-8"))
        if current is None:
            v.meta.setdefault(v.rel(p), {})["created"] = now_ms()
            v.save_meta()
        info = v.note_info(p)
    v.publish("tree" if current is None else "note", [info["path"]], h.client_id)
    return info


def api_note_create(h, v, q):
    body = h.json_body(MAX_NOTE)
    folder = (body.get("folder") or "").strip("/")
    base = v.resolve(folder) if folder else v.root
    with v.lock:
        base.mkdir(parents=True, exist_ok=True)
        p = unique_path(base / f"{clean_name(body.get('name'))}.md")
        atomic_write(p, str(body.get("content") or "").encode("utf-8"))
        v.meta.setdefault(v.rel(p), {})["created"] = now_ms()
        if body.get("tags"):
            v.meta[v.rel(p)]["tags"] = clean_tags(body["tags"])
        v.save_meta()
        info = v.note_info(p)
    v.publish("tree", [info["path"]], h.client_id)
    return info


def api_note_delete(h, v, q):
    p = v.resolve(q.get("path"), note=True)
    with v.lock:
        if not p.is_file():
            raise ApiError(404, "Note not found")
        v.remove(p, q.get("permanent") == "1")
    v.publish("tree", [q.get("path")], h.client_id)
    return {"ok": True}


def api_move(h, v, q):
    body = h.json_body()
    src = v.resolve(body.get("from"))
    if not src.exists():
        raise ApiError(404, "Nothing to move")
    to = (body.get("to") or "").strip("/")
    parent, _, name = to.rpartition("/")
    if src.is_file():
        name = clean_name(name[:-3] if name.lower().endswith(".md") else name) + ".md"
    else:
        name = clean_name(name, "Folder")
    dst = v.resolve(f"{parent}/{name}" if parent else name, note=src.is_file())
    if dst == src:
        return {"path": v.rel(src), "relinked": 0}
    if src.is_dir() and src in dst.parents:
        raise ApiError(400, "Cannot move a folder into itself")
    with v.lock:
        if dst.exists() and dst.resolve() != src.resolve():
            raise ApiError(409, "Something with that name already exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        old, was_file = v.rel(src), src.is_file()
        os.replace(src, dst)
        v.meta_move(old, v.rel(dst))
        relinked = v.relink(old, v.rel(dst)) if was_file and body.get("relink") else []
    v.publish("tree", [old, v.rel(dst), *relinked], h.client_id)
    return {"path": v.rel(dst), "relinked": len(relinked)}


def api_duplicate(h, v, q):
    src = v.resolve(h.json_body().get("path"), note=True)
    if not src.is_file():
        raise ApiError(404, "Note not found")
    with v.lock:
        dst = unique_path(src.with_name(f"{src.stem} copy.md"))
        shutil.copyfile(src, dst)
        own = v.meta.get(v.rel(src), {}).get("tags")
        v.meta[v.rel(dst)] = {"created": now_ms(), **({"tags": list(own)} if own else {})}
        v.save_meta()
        info = v.note_info(dst)
    v.publish("tree", [info["path"]], h.client_id)
    return info


def api_meta(h, v, q):
    body = h.json_body()
    p = v.resolve(body.get("path"))
    changes = body.get("set") or {}
    with v.lock:
        if not p.exists():
            raise ApiError(404, "Not found")
        rel = v.rel(p)
        entry = v.meta.setdefault(rel, {})
        if "tags" in changes:
            entry["tags"] = clean_tags(changes["tags"])
        if p.is_file() and "pinned" in changes:
            entry["pinned"] = bool(changes["pinned"])
        if p.is_dir() and "sort" in changes:
            entry["sort"] = changes["sort"] if changes["sort"] in SORTS else None
        if p.is_dir() and "note" in changes:
            if changes["note"]:
                n = v.resolve(changes["note"], note=True)
                if not n.is_file():
                    raise ApiError(404, "Note not found")
                entry["note"] = v.rel(n)
            else:
                entry["note"] = None
        for k in [k for k, val in entry.items() if val in (None, False, [], "")]:
            entry.pop(k)
        if not entry:
            v.meta.pop(rel)
        v.save_meta()
    v.publish("tree", [rel], h.client_id)
    return {"ok": True}


def api_folder_create(h, v, q):
    body = h.json_body()
    parent, _, name = (body.get("path") or "").strip("/").rpartition("/")
    name = clean_name(name, "New folder")
    p = v.resolve(f"{parent}/{name}" if parent else name)
    with v.lock:
        p = unique_path(p)
        p.mkdir(parents=True)
    v.publish("tree", [v.rel(p)], h.client_id)
    return {"path": v.rel(p)}


def api_folder_delete(h, v, q):
    p = v.resolve(q.get("path"))
    with v.lock:
        if not p.is_dir():
            raise ApiError(404, "Folder not found")
        v.remove(p, q.get("permanent") == "1")
    v.publish("tree", [q.get("path")], h.client_id)
    return {"ok": True}


def api_upload(h, v, q):
    stem, ext = os.path.splitext(os.path.basename(q.get("name") or "image.png"))
    ext = ext.lower()
    if ext not in IMAGE_EXT:
        raise ApiError(415, "Only images can be uploaded")
    stem = re.sub(r"[^\w.-]+", "-", stem).strip("-.")[:60] or "image"
    data = h.read_body(MAX_UPLOAD)
    if not data:
        raise ApiError(400, "Empty upload")
    with v.lock:
        p = unique_path(v.resolve(v.attach_rel()) / f"{stem}{ext}")
        if " " in p.name:  # unique_path adds " 2"; keep names link-safe
            p = p.with_name(p.name.replace(" ", "-"))
        atomic_write(p, data)
    return {"path": v.rel(p), "name": p.name}


def api_append(h, v, q):
    """Append text to a note, creating it if needed. Handy for automations."""
    body = h.json_body(MAX_NOTE)
    rel = (body.get("path") or "Inbox").strip("/")
    p = v.resolve(rel if rel.lower().endswith(".md") else rel + ".md", note=True)
    text = str(body.get("text") or "")
    if not text.strip():
        raise ApiError(400, "Nothing to append")
    with v.lock:
        old = p.read_text("utf-8", errors="replace") if p.exists() else None
        sep = "" if not old or old.endswith("\n") else "\n"
        if old:
            v.snapshot(v.rel(p), old)
        atomic_write(p, ((old or "") + sep + text.rstrip("\n") + "\n").encode("utf-8"))
        if old is None:
            v.meta.setdefault(v.rel(p), {})["created"] = now_ms()
            v.save_meta()
        info = v.note_info(p)
    v.publish("tree" if old is None else "note", [info["path"]], h.client_id)
    return info


SEARCH_FIELDS = {"tag": "tag", "path": "path", "in": "path", "folder": "path", "title": "title", "file": "title"}


def parse_query(q):
    """Words, "exact phrases", -excluded, and tag: path: title: filters (each may be negated)."""
    terms, excludes, filters = [], [], []
    for neg, field, raw in re.findall(r'(-?)(?:([A-Za-z]+):)?("[^"]*"?|\S+)', q):
        phrase = raw.startswith('"')
        value = raw.strip('"')
        key = SEARCH_FIELDS.get(field.lower()) if field else None
        if field and not key:  # not a filter, e.g. a URL like http://…
            value, phrase = f"{field}:{raw}", False
        if not value:
            continue
        if key:
            filters.append((key, value.lstrip("#").lower(), bool(neg)))
        elif neg:
            excludes.append(value.lower())
        else:
            terms.append((value, phrase))
    return terms, excludes, filters


def fts_query(terms):
    parts = []
    for value, phrase in terms:
        if phrase:
            parts.append('"' + value.replace('"', '') + '"')
        else:
            parts += ['"' + w + '"*' for w in re.findall(r"\w+", value)]
    return " ".join(parts)


def search_filters_ok(v, p, rel, filters, cache):
    for key, value, neg in filters:
        if key == "path":
            hit = value in rel.lower()
        elif key == "title":
            hit = value in p.stem.lower()
        else:
            if rel not in cache:
                cache[rel] = [t.lower() for t in v.note_info(p)["tags"]]
            hit = any(t == value or t.startswith(value + "/") for t in cache[rel])
        if hit == neg:
            return False
    return True


def searchable(text):
    """Note text for searching: front matter becomes plain "key value" lines at the end,
    so properties are found but never shown as raw YAML in snippets."""
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end > 0:
            front = text[4:end]
            rest = text[end + 4:].lstrip("-").lstrip("\n")
            flat = " · ".join(re.sub(r"^\s*-\s*", "", line).replace(":", "", 1).strip() for line in front.splitlines() if line.strip())
            return f"{rest}\n\n{flat}"
    return text


def make_snippet(text, words):
    low = text.lower()
    i = next((low.find(w) for w in words if w and low.find(w) >= 0), -1)
    if i < 0:
        return re.sub(r"\s+", " ", text[:160]).strip()
    start = max(0, i - 60)
    out = ("…" if start else "") + re.sub(r"\s+", " ", text[start:i + 140]).strip()
    for w in sorted(set(words), key=len, reverse=True):
        if w:
            out = re.sub(re.escape(w), lambda m: "\x02" + m.group(0) + "\x03", out, flags=re.I)
    return out


def api_search(h, v, q):
    """Full-text search through SQLite FTS5 when available, with a plain scan as fallback."""
    raw = (q.get("q") or "").strip()
    if not raw:
        return {"results": []}
    terms, excludes, filters = parse_query(raw)
    words = [w.lower() for value, _ in terms for w in ([value] if _ else re.findall(r"\w+", value))]
    tag_cache, results, engine = {}, [], "scan"
    match = fts_query(terms)
    if FTS5 and match:
        try:
            v.sync_index()
            db = v.index_db()
            try:
                rows = db.execute(
                    "SELECT seen.path, snippet(docs, 1, char(2), char(3), '…', 16), bm25(docs, 8.0, 1.0), docs.body "
                    "FROM docs JOIN seen ON seen.docid = docs.rowid WHERE docs MATCH ? ORDER BY bm25(docs, 8.0, 1.0) LIMIT 400",
                    (match,)).fetchall()
            finally:
                db.close()
            engine = "fts5"
            for rel, snippet, rank, body in rows:
                p = v.root / rel
                low = body.lower()
                if any(x in low or x in p.stem.lower() for x in excludes) or not p.is_file():
                    continue
                if not search_filters_ok(v, p, rel, filters, tag_cache):
                    continue
                results.append({"path": rel, "title": p.stem, "snippet": re.sub(r"\s+", " ", snippet).strip(), "score": -rank})
        except sqlite3.Error:
            engine, results = "scan", []
    if engine == "scan":
        for p in v.iter_notes():
            rel = v.rel(p)
            try:
                text = searchable(p.read_text("utf-8", errors="replace"))
            except OSError:
                continue
            title, low = p.stem.lower(), text.lower()
            if not all(w in title or w in low for w in words) or any(x in low or x in title for x in excludes):
                continue
            if not search_filters_ok(v, p, rel, filters, tag_cache):
                continue
            score = sum(title.count(w) * 8 + low.count(w) for w in words) or 1
            results.append({"path": rel, "title": p.stem, "snippet": make_snippet(text, words), "score": score})
        results.sort(key=lambda r: -r["score"])
    return {"results": results[:80], "engine": engine, "words": words}


def safe_part(part, fallback):
    return re.sub(r"[^\w.\- ()]+", "-", part).strip(" .-")[:120] or fallback


def import_one(v, base, parts, data, counts):
    """Write one imported file under base, never overwriting anything."""
    parts = [x for x in parts if x not in ("", "/", ".", "..")]
    if not parts or any(x.startswith(".") or x == "__MACOSX" for x in parts):
        counts["skipped"] += 1
        return
    name = parts[-1]
    ext = os.path.splitext(name)[1].lower()
    folders = [clean_name(x, "Folder") for x in parts[:-1]]
    if ext in IMPORT_TEXT:
        target = "/".join([*folders, clean_name(os.path.splitext(name)[0]) + ".md"])
        p = unique_path(v.resolve(v.rel(base / target) if base != v.root else target, note=True))
        atomic_write(p, data.decode("utf-8", errors="replace").replace("\r\n", "\n").encode("utf-8"))
        v.meta.setdefault(v.rel(p), {})["created"] = now_ms()
        counts["notes"] += 1
    elif ext in IMPORT_FILES:
        target = "/".join([*folders, safe_part(os.path.splitext(name)[0], "file") + ext])
        p = unique_path(v.resolve(v.rel(base / target) if base != v.root else target))
        atomic_write(p, data)
        counts["files"] += 1
    else:
        counts["skipped"] += 1


def api_import(h, v, q):
    """Import .md/.txt files, images, or a .zip of a folder (an Obsidian vault works)."""
    name = os.path.basename((q.get("name") or "import").replace("\\", "/"))
    folder = (q.get("folder") or "").strip("/")
    data = h.read_body(MAX_IMPORT)
    counts = {"notes": 0, "files": 0, "skipped": 0}
    with v.lock:
        base = v.resolve(folder) if folder else v.root
        base.mkdir(parents=True, exist_ok=True)
        if name.lower().endswith(".zip"):
            try:
                z = zipfile.ZipFile(io.BytesIO(data))
            except zipfile.BadZipFile:
                raise ApiError(400, "That isn't a readable .zip file")
            infos = [i for i in z.infolist() if not i.is_dir()]
            if len(infos) > 20000 or sum(i.file_size for i in infos) > 2 * 1024 ** 3:
                raise ApiError(413, "That archive is too large to import")
            paths = [i.filename.replace("\\", "/").split("/") for i in infos]
            # A zip of a folder wraps everything in that folder; drop the wrapper.
            tops = {p[0] for p in paths if len(p) > 1}
            strip = len(tops) == 1 and all(len(p) > 1 for p in paths)
            for info, parts in zip(infos, paths):
                if info.file_size > 50 * 1024 * 1024:
                    counts["skipped"] += 1
                    continue
                import_one(v, base, parts[1:] if strip else parts, z.read(info), counts)
        else:
            import_one(v, base, [name], data, counts)
        v.save_meta()
    v.publish("tree", [], h.client_id)
    return counts


REF_MD = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?")
REF_WIKI = re.compile(r"!?\[\[([^\]|#]+)")


def api_attachments(h, v, q):
    """Every non-note file, and whether any note still points at it."""
    paths, names = set(), set()
    for p in v.iter_notes():
        try:
            text = p.read_text("utf-8", errors="replace")
        except OSError:
            continue
        here = posixpath.dirname(v.rel(p))
        for m in REF_MD.finditer(text):
            target = urllib.parse.unquote(m.group(1)).split("#")[0].split("?")[0]
            if re.match(r"^[a-z]+:", target, re.I):
                continue
            paths.add(posixpath.normpath(target.lstrip("/")))
            paths.add(posixpath.normpath(posixpath.join(here, target)))
        for m in REF_WIKI.finditer(text):
            target = m.group(1).strip()
            paths.add(posixpath.normpath(target))
            names.add(posixpath.basename(target).lower())
    files, unused_bytes = [], 0
    for rel in v.files():
        size = (v.root / rel).stat().st_size
        used = rel in paths or posixpath.basename(rel).lower() in names
        if not used:
            unused_bytes += size
        files.append({"path": rel, "size": size, "used": used})
    return {"files": files, "unused": sum(1 for f in files if not f["used"]), "unusedBytes": unused_bytes,
            "bytes": sum(f["size"] for f in files)}


def api_attachments_trash(h, v, q):
    moved = 0
    with v.lock:
        for rel in h.json_body().get("paths") or []:
            p = v.resolve(rel)
            if p.is_file() and p.suffix.lower() != ".md":
                v.to_trash(p)
                moved += 1
    v.publish("tree", [], h.client_id)
    return {"moved": moved}


def api_backlinks(h, v, q):
    """Notes that link here, and notes that mention this note's name without linking."""
    target = v.resolve(q.get("path"), note=True)
    rel, stem = v.rel(target), target.stem
    wiki, md = v.link_patterns(rel)
    word = re.compile(r"(?<![\w\[])" + re.escape(stem) + r"(?![\w\]])", re.I) if len(stem) >= 3 else None
    linked, unlinked = [], []
    for p in v.iter_notes():
        if p == target:
            continue
        try:
            text = p.read_text("utf-8", errors="replace")
        except OSError:
            continue
        hits, mentions = [], []
        for line in text.splitlines():
            if wiki.search(line) or md.search(line):
                hits.append(line.strip()[:220])
            elif word and word.search(line):
                mentions.append(line.strip()[:220])
        if hits:
            linked.append({"path": v.rel(p), "lines": hits[:3], "count": len(hits)})
        elif mentions:
            unlinked.append({"path": v.rel(p), "lines": mentions[:2], "count": len(mentions)})
    return {"linked": linked[:200], "unlinked": unlinked[:100]}


# -- history
def api_history_list(h, v, q):
    p = v.resolve(q.get("path"), note=True)
    d = v.history / v.rel(p)
    versions = []
    if d.is_dir():
        for f in d.glob("*.md"):
            if f.stem.isdigit():
                versions.append({"id": f.stem, "time": int(f.stem), "size": f.stat().st_size})
    return {"versions": sorted(versions, key=lambda x: -x["time"])}


def history_file(v, q):
    p = v.resolve(q.get("path"), note=True)
    vid = str(q.get("id") or "")
    if not vid.isdigit():
        raise ApiError(400, "Bad version")
    f = v.history / v.rel(p) / f"{vid}.md"
    if not f.is_file():
        raise ApiError(404, "Version not found")
    return p, f


def api_history_get(h, v, q):
    _, f = history_file(v, q)
    return {"content": f.read_text("utf-8", errors="replace")}


def api_history_restore(h, v, q):
    p, f = history_file(v, h.json_body())
    with v.lock:
        if p.exists():
            v.snapshot(v.rel(p), p.read_text("utf-8", errors="replace"), force=True)
        atomic_write(p, f.read_bytes())
        info = v.note_info(p)
    v.publish("note", [info["path"]], h.client_id)
    return info


def api_history_clear(h, v, q):
    with v.lock:
        if q.get("path"):
            shutil.rmtree(v.history / v.rel(v.resolve(q["path"], note=True)), ignore_errors=True)
        else:
            shutil.rmtree(v.history, ignore_errors=True)
    return {"ok": True}


# -- trash
def api_trash_list(h, v, q):
    with v.lock:
        return {"items": v.trash_items()}


def api_trash_restore(h, v, q):
    tid = h.json_body().get("id") or ""
    with v.lock:
        item = next((i for i in v.trash_items() if i["id"] == tid), None)
        if not item:
            raise ApiError(404, "Not in trash")
        src = (v.trash / tid).resolve()
        if v.trash.resolve() not in src.parents:
            raise ApiError(400, "Bad trash item")
        dst = unique_path(v.resolve(item["from"]))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        index = load_json(v.polar / "trash.json", {})
        index.pop(tid, None)
        save_json(v.polar / "trash.json", index)
    v.publish("tree", [v.rel(dst)], h.client_id)
    return {"path": v.rel(dst)}


def api_trash_delete(h, v, q):
    with v.lock:
        if q.get("id"):
            v.trash_remove(q["id"])
        else:
            shutil.rmtree(v.trash, ignore_errors=True)
            save_json(v.polar / "trash.json", {})
    return {"ok": True}


# -- info, config, backup
def api_info(h, v, q):
    with v.lock:
        notes = sum(1 for _ in v.iter_notes())
        folders = len(v.folders())
        att = dir_size(v.root / v.attach_rel())
        hist = dir_size(v.history)
        tr = dir_size(v.trash)
    return {
        "version": VERSION, "vault": str(v.root), "vaultName": v.name, "started": int(STARTED * 1000),
        "notes": notes, "folders": folders,
        "attachments": {"files": att[0], "bytes": att[1]},
        "history": {"versions": hist[0], "bytes": hist[1]},
        "trash": {"files": tr[0], "bytes": tr[1]},
        "git": bool(GIT), "live": len(v.subscribers),
    }


def api_config_get(h, v, q):
    return v.config


def api_config_put(h, v, q):
    body = h.json_body()
    clamp = lambda x, lo, hi, d: max(lo, min(hi, int(x))) if isinstance(x, (int, float)) and not isinstance(x, bool) else d
    with v.lock:
        hist, c = body.get("history") or {}, v.config["history"]
        if "enabled" in hist:
            c["enabled"] = bool(hist["enabled"])
        c["interval"] = clamp(hist.get("interval"), 1, 1440, c["interval"])
        c["keep"] = clamp(hist.get("keep"), 0, 1000, c["keep"])
        c["days"] = clamp(hist.get("days"), 0, 3650, c["days"])
        v.config["trashDays"] = clamp(body.get("trashDays"), 0, 3650, v.config["trashDays"])
        if "attachmentFolder" in body:
            parts = [clean_name(part, "") for part in str(body["attachmentFolder"]).split("/")]
            folder = "/".join(p for p in parts if p)
            if folder:
                v.resolve(folder)  # validates: inside the vault, not hidden
            v.config["attachmentFolder"] = folder or "attachments"
        g, gc = body.get("git") or {}, v.config["git"]
        if "enabled" in g:
            gc["enabled"] = bool(g["enabled"])
        if "push" in g:
            gc["push"] = bool(g["push"])
        gc["interval"] = clamp(g.get("interval"), 1, 1440, gc["interval"])
        if "remote" in g:
            gc["remote"] = str(g["remote"]).strip()[:500]
        if "message" in g:
            gc["message"] = str(g["message"]).strip()[:200] or DEFAULT_CONFIG["git"]["message"]
        v.save_config()
        v.prune_all_history()
        return v.config


def api_export(h, v, q):
    with_history = q.get("history") == "1"
    buf = io.BytesIO()
    with v.lock, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, files in os.walk(v.root):
            here = Path(dirpath)
            dirnames[:] = [d for d in dirnames
                           if not (here == v.root and d in (".trash", ".git"))
                           and not (here == v.polar and d == "history" and not with_history)]
            for f in files:
                p = here / f
                if p == v.polar / "auth.json" or f.endswith(".tmp") or f.startswith("search.db"):  # no secrets; the index rebuilds
                    continue
                z.write(p, v.rel(p))
    stamp = time.strftime("%Y%m%d-%H%M")
    name = re.sub(r"[^\w-]+", "-", v.name).strip("-").lower() or "vault"
    return Raw(buf.getvalue(), "application/zip", {"Content-Disposition": f'attachment; filename="polarboard-{name}-{stamp}.zip"'})


def api_events(h, v, q):
    return Stream()


# -- personal dictionary (shared by every device using this vault)
def clean_words(words):
    out = []
    for w in words if isinstance(words, list) else []:
        w = str(w).strip()[:60]
        if w and not any(c.isspace() for c in w) and w not in out:
            out.append(w)
    return sorted(out, key=str.lower)[:5000]


def api_dictionary(h, v, q):
    return {"words": load_json(v.polar / "dictionary.json", {}).get("words", [])}


def api_dictionary_put(h, v, q):
    body = h.json_body()
    with v.lock:
        words = load_json(v.polar / "dictionary.json", {}).get("words", [])
        if "add" in body:
            words = clean_words(words + [body["add"]])
        else:
            words = clean_words(body.get("words"))
        save_json(v.polar / "dictionary.json", {"words": words})
    v.publish("dictionary", [], h.client_id)
    return {"words": words}


# -- tokens (vault-scoped)
def require_person(h):
    if h.token_account:
        raise ApiError(403, "API tokens can only use notes")


def api_tokens(h, v, q):
    require_person(h)
    return {"tokens": [{k: t.get(k) for k in ("id", "name", "created", "lastUsed")} for t in v.auth.get("tokens", [])]}


def api_token_create(h, v, q):
    require_person(h)
    name = clean_name(h.json_body().get("name") or "", "Token")[:60]
    token = "pb_" + secrets.token_urlsafe(30)
    entry = {"id": secrets.token_hex(6), "name": name, "hash": sha(token), "created": now_ms(), "lastUsed": None}
    with v.lock:
        v.auth.setdefault("tokens", []).append(entry)
        v.save_auth()
    return {"token": token, "id": entry["id"], "name": name}


def api_token_delete(h, v, q):
    require_person(h)
    with v.lock:
        v.auth["tokens"] = [t for t in v.auth.get("tokens", []) if t["id"] != q.get("id")]
        v.save_auth()
    return {"ok": True}


# -- share links
def share_public(token, info):
    return {"token": token, "path": info["path"], "created": info["created"], "expires": info.get("expires"),
            "views": info.get("views", 0), "by": info.get("by", "")}


def api_shares(h, v, q):
    with REG_LOCK:
        items = [share_public(t, i) for t, i in SHARES.items()
                 if i["vault"] == v.id and (not q.get("path") or i["path"] == q["path"])]
    return {"shares": sorted(items, key=lambda s: -s["created"])}


def api_share_create(h, v, q):
    require_person(h)
    body = h.json_body()
    p = v.resolve(body.get("path"), note=True)
    if not p.is_file():
        raise ApiError(404, "Note not found")
    days = body.get("days") or 0
    token = secrets.token_urlsafe(18)
    info = {"vault": v.id, "path": v.rel(p), "created": now_ms(), "views": 0,
            "expires": now_ms() + int(days) * 86_400_000 if days else None}
    with REG_LOCK:
        SHARES[token] = info
        save_json(SHARES_FILE, SHARES, private=True)
    return share_public(token, info)


def api_share_delete(h, v, q):
    require_person(h)
    with REG_LOCK:
        info = SHARES.get(q.get("token") or "")
        if not info or info["vault"] != v.id:
            raise ApiError(404, "Share not found")
        SHARES.pop(q["token"])
        save_json(SHARES_FILE, SHARES, private=True)
    return {"ok": True}


def shared_note(token):
    with REG_LOCK:
        info = SHARES.get(token)
    if not info or (info.get("expires") and info["expires"] < now_ms()):
        raise ApiError(404, "This link has expired or was removed")
    v = VAULTS.get(info["vault"])
    if not v:
        raise ApiError(404, "This link has expired or was removed")
    p = v.resolve(info["path"], note=True)
    if not p.is_file():
        raise ApiError(404, "This note no longer exists")
    return info, v, p


def api_public_note(h, token):
    info, v, p = shared_note(token)
    with REG_LOCK:
        info["views"] = info.get("views", 0) + 1
        save_json(SHARES_FILE, SHARES, private=True)
    st = p.stat()
    return {"title": p.stem, "content": p.read_text("utf-8", errors="replace"), "modified": st.st_mtime_ns // 1_000_000,
            "attachmentFolder": v.attach_rel()}


def public_file(h, token, rel):
    """Images a shared note uses, and nothing else."""
    _, v, p = shared_note(token)
    content = p.read_text("utf-8", errors="replace")
    f = v.resolve(rel)
    if rel not in content and urllib.parse.quote(rel) not in content and f"[[{f.name}" not in content:
        raise ApiError(404, "Not found")
    h.send_file(f, VAULT_CSP, "public, max-age=3600")


# -- git
def api_git(h, v, q):
    out = {"available": bool(GIT), "config": v.config["git"], "error": v.git_error, "repo": (v.root / ".git").exists(),
           "next": int((v.git_last + v.config["git"]["interval"] * 60) * 1000) if v.config["git"]["enabled"] else None}
    if GIT and out["repo"]:
        log = v.git("log", "-n", "15", "--pretty=format:%h%x09%ct%x09%s").stdout.splitlines()
        out["log"] = [dict(zip(("hash", "time", "message"), (a, int(b) * 1000, c))) for a, b, c in (l.split("\t", 2) for l in log if l.count("\t") >= 2)]
        out["pending"] = len(v.git("status", "--porcelain").stdout.splitlines())
    return out


def api_git_commit(h, v, q):
    require_person(h)
    return v.git_commit(push=h.json_body().get("push"))


# --------------------------------------------------------------- accounts
def api_accounts(h, q):
    return {"accounts": [account_public(aid, h) for aid in REGISTRY["accounts"]],
            "createNeedsServerPassword": bool(ENV_PASSWORD), "version": VERSION}


def api_unlock(h, q):
    body = h.json_body()
    aid = body.get("id")
    if aid not in REGISTRY["accounts"]:
        raise ApiError(404, "No such account")
    if REGISTRY["accounts"][aid].get("password"):
        ip, recent = throttle(h)
        if not check_password(aid, str(body.get("password") or "")):
            failed(ip, recent)
            raise ApiError(403, "That password isn't right")
        LOGIN_FAILS.pop(ip, None)
        unlock_session(h, aid, body.get("remember", True))
    return account_public(aid, h)


def api_lock(h, q):
    lock_session(h, h.json_body().get("id"))
    return {"ok": True}


def api_account_create(h, q):
    body = h.json_body()
    if not check_server_password(body.get("serverPassword")):
        ip, recent = throttle(h)
        failed(ip, recent)
        raise ApiError(403, "The server password isn't right")
    name = clean_name(body.get("name") or "", "")[:40]
    if not name:
        raise ApiError(400, "Give the account a name")
    pw = str(body.get("password") or "")
    with REG_LOCK:
        base = re.sub(r"[^\w-]+", "-", name.lower()).strip("-") or "account"
        aid, n = base, 2
        while aid in REGISTRY["accounts"] or aid == "main" or (DATA / "vaults" / aid).exists():
            aid, n = f"{base}-{n}", n + 1
        path = DATA / "vaults" / aid
        entry = {"name": name, "path": path.relative_to(DATA).as_posix(), "created": now_ms(),
                 "icon": clean_icon(body.get("icon")) or default_icon(aid)}
        if pw:
            entry["password"] = new_password(pw)
        REGISTRY["accounts"][aid] = entry
        VAULTS[aid] = Vault(aid, name, path)
        save_registry()
    if pw:
        unlock_session(h, aid)
    return account_public(aid, h)


def api_account_icon_get(h, q):
    aid = q.get("id") or ""
    icon = REGISTRY["accounts"].get(aid, {}).get("icon") or {}
    if icon.get("type") != "image":
        raise ApiError(404, "No picture")
    h.send_file(ICON_DIR / f"{aid}{icon['ext']}", VAULT_CSP, "public, max-age=86400")


# -- the open account
def api_account_update(h, v, q):
    require_person(h)
    body = h.json_body()
    with REG_LOCK:
        a = REGISTRY["accounts"][v.id]
        if "name" in body:
            name = clean_name(body.get("name") or "", "")[:40]
            if not name:
                raise ApiError(400, "Give the account a name")
            a["name"] = v.name = name
        if "icon" in body:
            icon = clean_icon(body["icon"])
            if not icon:
                raise ApiError(400, "Unknown icon")
            remove_icon_files(v.id)
            a["icon"] = icon
        save_registry()
    return account_public(v.id, h)


def api_account_picture(h, v, q):
    require_person(h)
    ext = ICON_TYPES.get((h.headers.get("Content-Type") or "").split(";")[0].strip().lower())
    if not ext:
        raise ApiError(415, "Use a PNG, JPEG, WebP or GIF picture")
    data = h.read_body(2 * 1024 * 1024)
    if not data:
        raise ApiError(400, "Empty picture")
    with REG_LOCK:
        remove_icon_files(v.id)
        ICON_DIR.mkdir(parents=True, exist_ok=True)
        atomic_write(ICON_DIR / f"{v.id}{ext}", data)
        a = REGISTRY["accounts"][v.id]
        a["icon"] = {"type": "image", "ext": ext, "v": now_ms(), "hue": (a.get("icon") or {}).get("hue", 212)}
        save_registry()
    return account_public(v.id, h)


def api_account_password(h, v, q):
    require_person(h)
    body = h.json_body()
    a = REGISTRY["accounts"][v.id]
    if a.get("password"):
        ip, recent = throttle(h)
        if not check_password(v.id, str(body.get("current") or "")):
            failed(ip, recent)
            raise ApiError(403, "Current password isn't right")
    with REG_LOCK:
        if body.get("remove"):
            a.pop("password", None)
        else:
            a["password"] = new_password(str(body.get("password") or ""))
        save_registry()
        forget_account_sessions(v.id, keep=sha(h.cookie("pb_session") or ""))
    if a.get("password"):
        unlock_session(h, v.id)  # stay signed in on this device
    return account_public(v.id, h)


def api_account_delete(h, v, q):
    require_person(h)
    body = h.json_body()
    if v.id == "main":
        raise ApiError(400, "The first account can't be deleted, but you can rename it")
    if REGISTRY["accounts"][v.id].get("password") and not check_password(v.id, str(body.get("password") or "")):
        raise ApiError(403, "That password isn't right")
    if not check_server_password(body.get("serverPassword")):
        raise ApiError(403, "The server password isn't right")
    with REG_LOCK:
        REGISTRY["accounts"].pop(v.id)
        VAULTS.pop(v.id, None)
        save_registry()
        forget_account_sessions(v.id)
        remove_icon_files(v.id)
        for t in [t for t, i in SHARES.items() if i["vault"] == v.id]:
            SHARES.pop(t)
        save_json(SHARES_FILE, SHARES, private=True)
        if DATA / "vaults" in v.root.parents:  # moved aside, not destroyed
            dest = SERVER_DIR / "deleted-accounts" / f"{v.id}-{time.strftime('%Y%m%d-%H%M%S')}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(v.root), str(dest))
    return {"ok": True}


def api_sessions(h, v, q):
    mine = sha(h.cookie("pb_session") or "")
    return {"sessions": sorted(({"id": k[:12], "created": s["created"], "seen": s.get("seen"), "agent": s.get("agent", ""),
                                 "ip": s.get("ip", ""), "current": k == mine}
                                for k, s in SESSIONS.items() if v.id in s.get("accounts", [])), key=lambda s: -(s["seen"] or 0))}


def api_session_delete(h, v, q):
    require_person(h)
    with REG_LOCK:
        for k, s in list(SESSIONS.items()):
            if k.startswith(q.get("id") or "-") and v.id in s["accounts"]:
                s["accounts"].remove(v.id)
                if not s["accounts"]:
                    SESSIONS.pop(k)
        save_sessions()
    return {"ok": True}


VAULT_ROUTES = {
    ("GET", "/api/tree"): api_tree,
    ("GET", "/api/note"): api_note_get,
    ("PUT", "/api/note"): api_note_put,
    ("POST", "/api/note"): api_note_create,
    ("DELETE", "/api/note"): api_note_delete,
    ("POST", "/api/duplicate"): api_duplicate,
    ("POST", "/api/move"): api_move,
    ("POST", "/api/meta"): api_meta,
    ("POST", "/api/folder"): api_folder_create,
    ("DELETE", "/api/folder"): api_folder_delete,
    ("POST", "/api/upload"): api_upload,
    ("POST", "/api/append"): api_append,
    ("GET", "/api/search"): api_search,
    ("GET", "/api/backlinks"): api_backlinks,
    ("POST", "/api/import"): api_import,
    ("GET", "/api/attachments"): api_attachments,
    ("POST", "/api/attachments/trash"): api_attachments_trash,
    ("GET", "/api/history"): api_history_list,
    ("GET", "/api/history/version"): api_history_get,
    ("POST", "/api/history/restore"): api_history_restore,
    ("DELETE", "/api/history"): api_history_clear,
    ("GET", "/api/trash"): api_trash_list,
    ("POST", "/api/trash/restore"): api_trash_restore,
    ("DELETE", "/api/trash"): api_trash_delete,
    ("GET", "/api/info"): api_info,
    ("GET", "/api/config"): api_config_get,
    ("PUT", "/api/config"): api_config_put,
    ("GET", "/api/export"): api_export,
    ("GET", "/api/events"): api_events,
    ("GET", "/api/tokens"): api_tokens,
    ("POST", "/api/tokens"): api_token_create,
    ("DELETE", "/api/tokens"): api_token_delete,
    ("GET", "/api/shares"): api_shares,
    ("POST", "/api/shares"): api_share_create,
    ("DELETE", "/api/shares"): api_share_delete,
    ("GET", "/api/dictionary"): api_dictionary,
    ("PUT", "/api/dictionary"): api_dictionary_put,
    ("POST", "/api/account"): api_account_update,
    ("POST", "/api/account/icon"): api_account_picture,
    ("POST", "/api/account/password"): api_account_password,
    ("DELETE", "/api/account"): api_account_delete,
    ("GET", "/api/sessions"): api_sessions,
    ("DELETE", "/api/sessions"): api_session_delete,
    ("GET", "/api/git"): api_git,
    ("POST", "/api/git/commit"): api_git_commit,
}
PUBLIC_ROUTES = {
    ("GET", "/api/accounts"): api_accounts,
    ("POST", "/api/accounts"): api_account_create,
    ("POST", "/api/accounts/unlock"): api_unlock,
    ("POST", "/api/accounts/lock"): api_lock,
}

TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json",
         ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8", ".webp": "image/webp",
         ".avif": "image/avif", ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Polarboard"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("POLARBOARD_LOG"):
            super().log_message(fmt, *args)

    def do_GET(self): self.route("GET")
    def do_HEAD(self): self.route("HEAD")
    def do_PUT(self): self.route("PUT")
    def do_POST(self): self.route("POST")
    def do_DELETE(self): self.route("DELETE")

    # -- helpers
    def read_body(self, limit=MAX_NOTE):
        self.body_read = True
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            self.close_connection = True
            raise ApiError(413, "Too large")
        return self.rfile.read(n) if n else b""

    def json_body(self, limit=1024 * 1024):
        try:
            data = json.loads(self.read_body(limit) or b"{}")
        except ValueError:
            raise ApiError(400, "Invalid JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "Expected an object")
        return data

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For", "")
        return (fwd.split(",")[0].strip() if fwd else self.client_address[0])[:64]

    def cookie(self, name):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, val = part.strip().partition("=")
            if k == name:
                return val
        return ""

    def send(self, status, data, ctype, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in {**self.extra_headers, **(headers or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status, obj):
        self.send(status, json.dumps(obj).encode(), "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def send_file(self, p, csp, cache, extra=None):
        if not p.is_file():
            raise ApiError(404, "Not found")
        st = p.stat()
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        headers = {"ETag": etag, "Cache-Control": cache, "Content-Security-Policy": csp, **(extra or {})}
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ctype = TYPES.get(p.suffix.lower()) or mimetypes.guess_type(p.name)[0] or ("text/plain" if p.name in ("LICENSE", "NOTICE") else "application/octet-stream")
        if ctype.startswith("text/") and "charset" not in ctype:
            ctype += "; charset=utf-8"
        self.send(200, p.read_bytes(), ctype, headers)

    def static(self, rel):
        p = (STATIC / rel).resolve()
        if STATIC not in p.parents:
            raise ApiError(404, "Not found")
        vendor = "/vendor/" in p.as_posix()
        self.send_file(p, APP_CSP, "public, max-age=604800, immutable" if vendor else "no-cache",
                       {"Service-Worker-Allowed": "/"} if p.name == "sw.js" else None)

    # -- auth
    def identify(self):
        """Work out what this request may open: an API token's account, the
        accounts unlocked in this browser's session, or basic-auth credentials."""
        global _last_sessions_save
        self.token_account, self.session_accounts, self.basic_account = None, set(), None
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            digest = sha(header[7:].strip())
            for v in VAULTS.values():
                for t in v.auth.get("tokens", []):
                    if hmac.compare_digest(digest, t["hash"]):
                        t["lastUsed"] = now_ms()
                        if time.time() - _last_sessions_save > 60:
                            _last_sessions_save = time.time()
                            v.save_auth()
                        self.token_account = v.id
                        return
            raise ApiError(401, "That API token isn't valid")
        token = self.cookie("pb_session")
        if token:
            s = SESSIONS.get(sha(token))
            if s and now_ms() - s.get("seen", 0) < SESSION_DAYS * 86_400_000:
                self.session_accounts = set(s["accounts"])
                if now_ms() - s.get("seen", 0) > 600_000:
                    s["seen"] = now_ms()
                    save_sessions()
        if header.startswith("Basic "):  # for scripts: curl -u account:password
            key = sha(header)
            if key in VERIFIED:
                self.basic_account = VERIFIED[key]
                return
            try:
                user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
            except ValueError:
                return
            aid = user if user in REGISTRY["accounts"] else next((k for k, a in REGISTRY["accounts"].items() if a["name"] == user), None)
            if aid and check_password(aid, pw):
                VERIFIED[key] = self.basic_account = aid

    def can_open(self, aid):
        a = REGISTRY["accounts"].get(aid)
        if not a:
            return False
        if self.token_account:
            return self.token_account == aid
        return not a.get("password") or aid in self.session_accounts or self.basic_account == aid

    def open_account(self, aid):
        if aid not in VAULTS:
            raise ApiError(404, "That account doesn't exist", account=aid, gone=True)
        if self.token_account and self.token_account != aid:
            raise ApiError(403, "This token belongs to another account")
        if not self.can_open(aid):
            raise ApiError(401, "This account is locked", login=True, account=aid)
        return VAULTS[aid]

    # -- routing
    def route(self, method):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        self.body_read = False
        self.extra_headers = {}
        self.token_account, self.session_accounts, self.basic_account = None, set(), None
        self.client_id = (self.headers.get("X-Client") or "")[:40]
        try:
            self.dispatch(method, url, path)
        except ApiError as e:
            self.send_json(e.status, {"error": e.msg, **e.extra})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # keep serving; report the bug
            print(f"error: {method} {path}: {e!r}", file=sys.stderr)
            try:
                self.send_json(500, {"error": "Internal error"})
            except OSError:
                pass
        finally:
            # An error sent before the body was read leaves it on the socket,
            # where it would be parsed as the next request. Close instead.
            if not self.body_read and int(self.headers.get("Content-Length") or 0):
                self.close_connection = True

    def dispatch(self, method, url, path):
        query = dict(urllib.parse.parse_qsl(url.query))
        verb = "GET" if method == "HEAD" else method
        if path == "/healthz":
            return self.send(200, b"ok", "text/plain")
        # Pages and assets carry no data, so they load before an account is open.
        if verb == "GET" and not path.startswith(("/api/", "/vault/")):
            if path in ("/", "/index.html"):
                return self.static("index.html")
            if path == "/sw.js":
                return self.static("sw.js")
            if path.startswith("/s/"):
                return self.static("share.html")
            if path.startswith("/static/"):
                return self.static(path[len("/static/"):])
            raise ApiError(404, "Not found")
        m = re.fullmatch(r"/api/public/([\w-]{8,64})(/file)?", path)
        if m and verb == "GET":
            if m.group(2):
                return public_file(self, m.group(1), query.get("path", ""))
            return self.send_json(200, api_public_note(self, m.group(1)))
        self.identify()
        # Writes from a browser must carry this header, which other sites can't send.
        if verb in ("POST", "PUT", "DELETE") and not self.token_account and self.headers.get("X-Polarboard") != "1":
            raise ApiError(403, "Missing request header")
        if verb == "GET" and path == "/api/account-icon":
            return api_account_icon_get(self, query)
        if (verb, path) in PUBLIC_ROUTES:
            if self.token_account:
                raise ApiError(403, "API tokens can only use notes")
            return self.send_json(200, PUBLIC_ROUTES[(verb, path)](self, query))
        if path.startswith("/vault/"):
            aid, _, rel = path[len("/vault/"):].partition("/")
            v = self.open_account(aid)
            return self.send_file(v.resolve(rel), VAULT_CSP, "private, max-age=86400")
        fn = VAULT_ROUTES.get((verb, path))
        if not fn:
            raise ApiError(404, "Unknown endpoint")
        v = self.open_account(self.headers.get("X-Vault") or query.get("vault") or "main")
        result = fn(self, v, query)
        if isinstance(result, Stream):
            return self.stream(v)
        if isinstance(result, Raw):
            return self.send(200, result.data, result.ctype, {"Cache-Control": "no-store", **result.headers})
        self.send_json(200, result)

    def stream(self, v):
        """Server-Sent Events: push changes to every open tab on this vault."""
        if len(v.subscribers) >= 64:
            raise ApiError(503, "Too many live connections")
        q = queue.Queue(maxsize=200)
        v.subscribers.add(q)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.wfile.write(b"retry: 3000\n: connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=20)
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            v.subscribers.discard(q)


WELCOME = """Polarboard keeps your notes as plain **markdown files** on your own server. Nothing is locked in, so you can open the vault folder in any editor, sync it, or back it up however you like. #welcome #polarboard

## Writing

- Type markdown and the editor shades it as you go
- Press **Ctrl E** to switch between writing and reading
- Paste or drop an image into a note to embed it
- Add hashtags anywhere (like #welcome) and they gather in the tags panel
- Link notes with double brackets, like [[Ideas]]

## Getting around

- [x] **Ctrl O** jumps to any note, **Ctrl Shift P** runs any command
- [x] Saves itself while you type, and keeps older versions
- [ ] Write something

> [!tip] Out of the way
> The focus button (Ctrl Shift F) hides everything but the page. Point at the top or bottom edge to bring the controls back.

Right-click a note or folder for more: tags, pinning, sorting, sharing, version history. Everything else lives in Settings.
"""


def main():
    SERVER_DIR.mkdir(parents=True, exist_ok=True)
    load_registry()
    seed(VAULTS["main"])
    threading.Thread(target=git_loop, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    locked = sum(1 for a in REGISTRY["accounts"].values() if a.get("password"))
    print(f"Polarboard {VERSION} on http://{HOST}:{PORT}  accounts={len(VAULTS)} ({locked} with a password)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
