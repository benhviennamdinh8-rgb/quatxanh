#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Server local cho SPA "Do Truyen" (index.html/app.js/style.css).

Doc du lieu ma scraper.py da tao:
  data/meta/<slug>.json      -> meta + danh sach chuong
  data/chapters/<slug>_N.txt -> noi dung chuong
  covers/<slug>.<ext>        -> anh bia

Cung cap:
  - lenh tinh (static): /, /app.js, /style.css, /covers/..., /Banner/...
  - API cho SPA (xem app.js): /api/home, /api/novels, /api/novel/:slug,
    /api/genres, /api/banner, /api/local/chapter
  - API admin: /api/admin/login, /api/admin/config, /api/local/status,
    /api/local/sync, SSE sync-check / fetch-all / fetch-covers,
    /api/local/check-report, POST /api/local/fetch-specified,
    POST /api/local/import (dung de scraper.py --api upload)
"""

import argparse
import base64
import json
import os
import queue
import re
import struct
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
META_DIR = os.path.join(DATA_DIR, "meta")
CHAP_DIR = os.path.join(DATA_DIR, "chapters")
COVERS_DIR = os.path.join(ROOT, "covers")
BANNER_DIR = os.path.join(ROOT, "Banner")
CONFIG_FILE = os.path.join(ROOT, "config.json")
DEFAULT_BANNER = "/Banner/Banner_Shopee.png"
DEFAULT_PASSWORD = "admin"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

tokens = {}          # token -> expiry ts
CONFIG = {}          # {"password":..., "banner": {...}}
INDEX = {}           # slug -> meta dict
lastSync = 0
syncRunning = False
LAST_REPORT = None
JOB_LOCK = threading.Lock()
_chapSlugs_cache = None
_chapSlugs_cache_at = 0.0


# ------------------------- store -------------------------


def save_config():
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(CONFIG, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log("[config] save fail: %s" % e)


def load_config():
    global CONFIG
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            CONFIG = json.load(f)
    except Exception:
        CONFIG = {}
    CONFIG.setdefault("password", DEFAULT_PASSWORD)
    b = CONFIG.setdefault("banner", {})
    b.setdefault("image", DEFAULT_BANNER)
    b.setdefault("link", "https://s.shopee.vn/")
    save_config()


def load_meta(slug):
    p = os.path.join(META_DIR, slug + ".json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def rebuild_index():
    global INDEX, lastSync
    idx = {}
    if os.path.isdir(META_DIR):
        for fn in os.listdir(META_DIR):
            if fn.endswith(".json"):
                slug = fn[:-5]
                m = load_meta(slug)
                if m:
                    idx[slug] = m
    INDEX = idx
    lastSync = int(time.time() * 1000)


def chapter_slugs():
    global _chapSlugs_cache, _chapSlugs_cache_at
    now = time.time()
    if _chapSlugs_cache is not None and now - _chapSlugs_cache_at < 5:
        return _chapSlugs_cache
    s = set()
    if os.path.isdir(CHAP_DIR):
        for fn in os.listdir(CHAP_DIR):
            if fn.endswith(".txt"):
                s.add(fn.rsplit("_", 1)[0])
    _chapSlugs_cache = s
    _chapSlugs_cache_at = now
    return s


def ensure_dirs_and_assets():
    for d in (DATA_DIR, META_DIR, CHAP_DIR, COVERS_DIR, BANNER_DIR):
        os.makedirs(d, exist_ok=True)
    bp = os.path.join(BANNER_DIR, "Banner_Shopee.png")
    if not os.path.exists(bp):
        make_png(bp, 900, 200, (74, 118, 168))


def make_png(path, w, h, rgb):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    r, g, b = rgb
    row = b"".join(struct.pack("BBBB", r, g, b, 255) for _ in range(w))
    raw = b"".join(b"\x00" + row for _ in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


# ------------------------- payloads -------------------------

SUMMARY_KEYS = ("slug", "title", "cover", "status", "rating", "views", "genres",
                "chapterCount", "author")


def summary(meta):
    s = {k: meta.get(k) for k in SUMMARY_KEYS}
    if s.get("chapterCount") is None:
        s["chapterCount"] = len(meta.get("chapters") or [])
    return s


def home_payload():
    items = list(INDEX.values())
    popular = sorted(items, key=lambda m: m.get("views") or 0, reverse=True)[:12]
    recent = sorted(items, key=lambda m: m.get("lastUpdated") or 0, reverse=True)[:12]
    return {
        "popular": [summary(m) for m in popular],
        "recentlyUpdated": [summary(m) for m in recent],
    }


def novels_payload(qs):
    q = (qs.get("q", [""])[0] or "").strip().lower()
    genre = (qs.get("genre", [""])[0] or "").strip().lower()
    status = (qs.get("status", [""])[0] or "").strip().lower()
    sort = (qs.get("sort", [""])[0] or "rating").strip()
    try:
        page = max(1, int(qs.get("page", ["1"])[0] or 1))
    except ValueError:
        page = 1
    try:
        limit = max(1, min(100, int(qs.get("limit", ["24"])[0] or 24)))
    except ValueError:
        limit = 24

    items = [summary(m) for m in INDEX.values()]
    if q:
        items = [s for s in items if q in (s.get("title") or "").lower()
                 or q in (s.get("author") or "").lower()]
    if genre:
        items = [s for s in items if any((g or "").lower() == genre for g in (s.get("genres") or []))]
    if status:
        items = [s for s in items if (s.get("status") or "") == status]
    if sort == "rating":
        items.sort(key=lambda s: (s.get("rating") is not None, s.get("rating") or 0), reverse=True)
    elif sort == "popular":
        items.sort(key=lambda s: s.get("views") or 0, reverse=True)
    elif sort == "title":
        items.sort(key=lambda s: (s.get("title") or "").lower())
    else:
        items.sort(key=lambda s: s.get("lastUpdated") or 0, reverse=True)

    total = len(items)
    total_pages = max(1, -(-total // limit))
    start = (page - 1) * limit
    return {
        "items": items[start:start + limit],
        "pagination": {"total": total, "totalPages": total_pages,
                       "currentPage": page, "limit": limit},
    }


def novel_payload(slug):
    m = INDEX.get(slug) or load_meta(slug)
    if not m:
        return None
    d = dict(m)
    d.setdefault("chapterCount", len(d.get("chapters") or []))
    return d


def genres_payload():
    seen = set()
    folders = []
    for m in INDEX.values():
        for g in m.get("genres") or []:
            key = (g or "").strip()
            if key and key not in seen:
                seen.add(key)
                folders.append({"slug": key})
    return {"folders": folders}


def banner_payload():
    b = CONFIG.get("banner") or {}
    return {"image": b.get("image") or DEFAULT_BANNER, "link": b.get("link") or "#"}


def chapter_payload(url):
    m = re.match(r"^/chuong/([^/]+)/(\d+)$", url)
    if not m:
        return {"error": "url khong hop le"}
    slug, num = m.group(1), int(m.group(2))
    content = ""
    p = os.path.join(CHAP_DIR, "%s_%d.txt" % (slug, num))
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception:
            content = ""
    title = "Chương %d" % num
    meta = load_meta(slug)
    if meta:
        for c in meta.get("chapters") or []:
            if c.get("number") == num:
                title = c.get("name") or title
                break
    return {"content": content, "title": title, "slug": slug, "number": num}


def status_payload():
    chap = chapter_slugs()
    fetched = sum(1 for s in INDEX if s in chap)
    return {"total": len(INDEX), "fetched": fetched, "lastSync": lastSync,
            "syncRunning": syncRunning}


def check_report_payload():
    if LAST_REPORT is None:
        return {"error": "Chua kiem tra cap nhat lan nao"}
    return LAST_REPORT


# ------------------------- jobs -------------------------


def guarded_job(job):
    def run(emit):
        if not JOB_LOCK.acquire(blocking=False):
            emit({"error": "Dang co job khac chay"})
            return
        global syncRunning
        syncRunning = True
        try:
            job(emit)
        except Exception as e:
            log("[job] ERROR %s" % e)
            emit({"error": str(e)})
        finally:
            syncRunning = False
            JOB_LOCK.release()
    return run


def job_check(emit):
    global LAST_REPORT
    nw, up, un = [], [], 0
    title_args = []
    if os.path.isdir(META_DIR):
        slugs = sorted(fn[:-5] for fn in os.listdir(META_DIR) if fn.endswith(".json"))
    else:
        slugs = []
    total = len(slugs)
    emit({"page": 0, "total": total, "new": 0, "updated": 0})
    for i, slug in enumerate(slugs, 1):
        m = load_meta(slug)
        if not m:
            continue
        cc = len(m.get("chapters") or [])
        cur = INDEX.get(slug)
        if cur is None:
            nw.append({"slug": slug, "title": m.get("title") or slug, "chapterCount": cc})
        else:
            diffs = []
            oldcc = len(cur.get("chapters") or [])
            if cc != oldcc:
                diffs.append("%d -> %d chuong" % (oldcc, cc))
            if (m.get("lastUpdated") or 0) != (cur.get("lastUpdated") or 0):
                diffs.append("cap nhat du lieu")
            if diffs:
                up.append({"slug": slug, "title": m.get("title") or slug,
                           "chapterCount": cc, "diffs": diffs})
            else:
                un += 1
        if i % 5 == 0 or i == total:
            emit({"page": i, "total": total, "new": len(nw), "updated": len(up)})
    LAST_REPORT = {"checkedAt": int(time.time() * 1000), "new": nw,
                   "updated": up, "unchanged": un}
    emit({"page": total, "total": total, "new": len(nw), "updated": len(up)})
    emit({"complete": True})


def job_fetch_all(emit):
    import scraper
    opts = {"data_dir": DATA_DIR, "covers_dir": COVERS_DIR, "fresh": False}
    scraper.job_fetch_all(opts, emit=emit)
    rebuild_index()


def job_fetch_specified(emit, slugs):
    import scraper
    opts = {"data_dir": DATA_DIR, "covers_dir": COVERS_DIR, "fresh": False}
    scraper.job_fetch_specified(slugs, opts, emit=emit)
    rebuild_index()


def job_fetch_covers(emit):
    import scraper
    opts = {"data_dir": DATA_DIR, "covers_dir": COVERS_DIR}
    scraper.job_fetch_covers(opts, emit=emit)


def do_sync():
    try:
        rebuild_index()
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}


# ------------------------- http -------------------------


def log(msg):
    s = str(msg)
    try:
        print(s, flush=True)
    except UnicodeEncodeError:
        print(s.encode("ascii", "ignore").decode("ascii"), flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "TEHI/1.0"

    # ---- helpers ----

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _file(self, fpath, ctype):
        try:
            with open(fpath, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _auth(self):
        tok = self.headers.get("x-admin-token") or ""
        if not tok:
            qs = parse_qs(urlparse(self.path).query)
            tok = (qs.get("token", [""])[0] or "")
        return bool(tok) and tokens.get(tok, 0) > time.time()

    def _sse(self, job):
        q = queue.Queue()

        def runner():
            try:
                job(q.put)
            except Exception as e:
                q.put({"error": str(e)})
            finally:
                q.put(None)

        threading.Thread(target=runner, daemon=True).start()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        while True:
            try:
                ev = q.get(timeout=15)
            except queue.Empty:
                try:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                except Exception:
                    break
                continue
            if ev is None:
                break
            try:
                self.wfile.write(("data: " + json.dumps(ev, ensure_ascii=False) +
                                  "\n\n").encode("utf-8"))
                self.wfile.flush()
            except Exception:
                break

    # ---- serving ----

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self.api_get(path, parsed)
            return
        self.serve_static(path)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self.api_post(urlparse(self.path).path, body)

    def serve_static(self, path):
        if path in ("/", "/index.html"):
            self._file(os.path.join(ROOT, "index.html"), MIME[".html"])
            return
        rel = unquote(path.lstrip("/"))
        fpath = os.path.normpath(os.path.join(ROOT, rel))
        if os.path.commonpath([ROOT, fpath]) != ROOT:
            self.send_error(403)
            return
        if os.path.isfile(fpath):
            ext = os.path.splitext(fpath)[1].lower()
            self._file(fpath, MIME.get(ext, "application/octet-stream"))
            return
        # SPA fallback
        self._file(os.path.join(ROOT, "index.html"), MIME[".html"])

    def api_get(self, path, parsed):
        qs = parse_qs(parsed.query)
        if path == "/api/banner":
            return self._json(banner_payload())
        if path == "/api/home":
            return self._json(home_payload())
        if path == "/api/novels":
            return self._json(novels_payload(qs))
        if path == "/api/genres":
            return self._json(genres_payload())
        m = re.match(r"^/api/novel/([^/]+)$", path)
        if m:
            d = novel_payload(unquote(m.group(1)))
            if d is None:
                return self._json({"error": "not found"}, 404)
            return self._json(d)
        if path == "/api/local/chapter":
            return self._json(chapter_payload(qs.get("url", [""])[0]))

        if path in ("/api/local/status", "/api/local/check-report"):
            if not self._auth():
                return self._json({"error": "unauthorized"}, 401)
            if path == "/api/local/status":
                return self._json(status_payload())
            return self._json(check_report_payload())
        if path in ("/api/local/sync-check", "/api/local/fetch-all", "/api/local/fetch-covers"):
            if not self._auth():
                return self._json({"error": "unauthorized", "retry": True}, 401)
            job = {"sync-check": job_check,
                   "fetch-all": job_fetch_all,
                   "fetch-covers": job_fetch_covers}[path]
            return self._sse(guarded_job(job))
        if path == "/api/admin/config":
            if not self._auth():
                return self._json({"error": "unauthorized"}, 401)
            return self._json({"banner": CONFIG.get("banner")})
        self._json({"error": "not found"}, 404)

    def api_post(self, path, body):
        if path == "/api/admin/login":
            try:
                payload = json.loads(body or b"{}")
            except Exception:
                return self._json({"error": "bad json"}, 400)
            pw = payload.get("password")
            if pw and pw == CONFIG.get("password"):
                import uuid
                tok = uuid.uuid4().hex
                tokens[tok] = time.time() + 86400
                return self._json({"token": tok})
            return self._json({"error": "sai mat khau"}, 401)

        if not self._auth():
            return self._json({"error": "unauthorized"}, 401)

        if path == "/api/admin/config":
            try:
                payload = json.loads(body or b"{}")
            except Exception:
                return self._json({"error": "bad json"}, 400)
            b = payload.get("banner") or {}
            cfg_b = CONFIG.setdefault("banner", {})
            if "image" in b:
                cfg_b["image"] = str(b["image"] or DEFAULT_BANNER)
            if "link" in b:
                cfg_b["link"] = str(b.get("link") or "#")
            if "password" in payload and isinstance(payload["password"], str) and payload["password"]:
                CONFIG["password"] = payload["password"]
            save_config()
            return self._json({"banner": cfg_b})

        if path == "/api/local/sync":
            return self._json(do_sync())

        if path == "/api/local/fetch-specified":
            try:
                payload = json.loads(body or b"{}")
                slugs = [s for s in (payload.get("slugs") or []) if isinstance(s, str) and s]
            except Exception:
                return self._json({"error": "bad json"}, 400)
            return self._sse(guarded_job(lambda emit: job_fetch_specified(emit, slugs)))

        if path == "/api/local/import":
            return self.api_import(body)

        self._json({"error": "not found"}, 404)

    def api_import(self, body):
        try:
            payload = json.loads(body or b"{}")
        except Exception:
            return self._json({"error": "bad json"}, 400)
        novel = payload.get("novel") or {}
        slug = re.sub(r"[^A-Za-z0-9_\-.]", "-", str(novel.get("slug") or "")).strip(".")
        if not slug or "/" in slug:
            return self._json({"error": "no slug"}, 400)
        os.makedirs(META_DIR, exist_ok=True)
        os.makedirs(CHAP_DIR, exist_ok=True)
        meta = dict(novel)
        chlist = []
        for c in payload.get("chapters") or []:
            try:
                num = int(c.get("number") or 0)
            except (TypeError, ValueError):
                num = 0
            if num <= 0:
                continue
            name = str(c.get("name") or ("Chương %d" % num))
            content = str(c.get("content") or "")
            chlist.append({"number": num, "name": name, "url": "/chuong/%s/%d" % (slug, num)})
            if content:
                with open(os.path.join(CHAP_DIR, "%s_%d.txt" % (slug, num)),
                          "w", encoding="utf-8") as f:
                    f.write(content)
        meta["slug"] = slug
        meta["chapters"] = chlist
        meta["chapterCount"] = len(chlist)
        meta["lastUpdated"] = int(time.time() * 1000)
        meta["fetched"] = bool(chlist)
        cb = payload.get("coverBase64")
        if cb:
            ext = re.sub(r"[^a-z]", "", str(payload.get("coverExt") or "jpg").lower()) or "jpg"
            if ext not in ("jpg", "jpeg", "png", "webp", "gif"):
                ext = "jpg"
            try:
                data = base64.b64decode(cb)
                os.makedirs(COVERS_DIR, exist_ok=True)
                with open(os.path.join(COVERS_DIR, "%s.%s" % (slug, ext)), "wb") as f:
                    f.write(data)
                if ext == "jpeg":
                    ext = "jpg"
                meta["cover"] = "/covers/%s.%s" % (slug, ext)
            except Exception:
                pass
        with open(os.path.join(META_DIR, slug + ".json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        rebuild_index()
        return self._json({"ok": True, "slug": slug})


def main():
    ap = argparse.ArgumentParser(description="Do Truyen local server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    ensure_dirs_and_assets()
    load_config()
    rebuild_index()
    # clear leftover tokens from disk-less restarts
    save_config()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    host = args.host if args.host not in ("0.0.0.0", "") else "localhost"
    log("=" * 52)
    log("Do Truyen local server  ->  http://%s:%d/" % (host, args.port))
    log("Mat khau admin          :  %s" % CONFIG.get("password"))
    log("Du lieu                 :  %s" % DATA_DIR)
    log("Bia (covers)            :  %s" % COVERS_DIR)
    log("Bam Ctrl+C de dung.")
    log("=" * 52)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("\nStopped.")


if __name__ == "__main__":
    main()