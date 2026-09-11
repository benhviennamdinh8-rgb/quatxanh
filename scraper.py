#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Scrap truyen tu kiwiiudammy.com -> data/  +  covers/  (+ push len server).

Flow:
  1. Thu thap danh sach truyen tu cac trang danh muc (mac dinh truyen-hot, ngon-tinh,
     hoan-thanh, truyen-cho-full). truyen-hot tai noi dung bang AJAX
     (sources/ajax/mong-truyen-truyen-danh-muc.php); neu rong thi tu dong lay
     cac trang danh muc render san severside.
  2. Voi moi truyen: lay trang chi tiet (meta: tieu de, bia, tac gia, the loai, mo ta,
     luot xem, trang thai,...) + danh sach chuong qua sources/ajax/load-chapters.php.
  3. Tai noi dung tung chuong ve (duong: /<slug>.html?chuong=N).
  4. Tai anh bia ve covers/.

Output:
  data/meta/<slug>.json    : meta truyen (gom chapters[])
  data/chapters/<slug>_N.txt: noi dung chuong (plain text, moi doan 1 dong)
  covers/<slug>.<ext>       : anh bia

Chay:
  python scraper.py                  : scrape toan bo (mac dinh 4 nguon)
  python scraper.py --limit 5        : chi 5 truyen dau
  python scraper.py --chapters 20    : toi da 20 chuong/truyen
  python scraper.py --fresh          : scrape lai het (khong bo qua file co san)
  python scraper.py --list           : chi in danh sach URL truyen tim thay
  python scraper.py --api http://localhost:8000 --admin-pass admin
                                      : sau khi scrape, upload len server dang chay
"""

import argparse
import base64
import html as htmlmod
import json
import os
import re
import sys
import time
import urllib.parse

import requests
from bs4 import BeautifulSoup

BASE = "https://kiwiiudammy.com"
LIST_AJAX = BASE + "/sources/ajax/mong-truyen-truyen-danh-muc.php"
CHAPTER_LIST_AJAX = BASE + "/sources/ajax/load-chapters.php"

DEFAULT_SOURCES = [
    BASE + "/truyen-hot.html",
    BASE + "/ngon-tinh.html",
    BASE + "/hoan-thanh.html",
    BASE + "/truyen-cho-full.html",
]

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                   " (KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
}

_delay = 0.5


def log(msg):
    s = str(msg)
    try:
        print(s, flush=True)
    except UnicodeEncodeError:
        print(s.encode("ascii", "ignore").decode("ascii"), flush=True)


def clean_ws(s):
    return re.sub(r"\s+", " ", s).strip() if s else ""


def parse_num(s):
    if not s:
        return 0
    s = s.replace(",", "").strip()
    m = re.match(r"^([0-9.]+)\s*([KkMm])?", s)
    if not m:
        return 0
    try:
        n = float(m.group(1))
    except ValueError:
        return 0
    u = (m.group(2) or "").lower()
    if u == "k":
        n *= 1000
    elif u == "m":
        n *= 1000000
    return int(n)


# ------------------------- HTTP -------------------------


def fetch_html(url, form=None, referer=None):
    last = None
    for attempt in range(3):
        try:
            hdrs = dict(HEADERS)
            if referer:
                hdrs["Referer"] = referer
            if form is not None:
                r = requests.post(url, data=form, headers=hdrs, timeout=30)
            else:
                r = requests.get(url, headers=hdrs, timeout=30)
            if r.status_code == 200:
                r.encoding = "utf-8"
                return r.text.lstrip("\ufeff")
            last = RuntimeError("HTTP %s" % r.status_code)
        except Exception as e:
            last = e
        time.sleep(_delay + 1)
    raise last


def post_json(url, form):
    for _ in range(3):
        try:
            r = requests.post(url, data=form, headers=HEADERS, timeout=30)
            if r.status_code == 200:
                r.encoding = "utf-8"
                return json.loads(r.text.lstrip("\ufeff"))
        except Exception:
            pass
        time.sleep(_delay + 1)
    return {}


def story_url(slug):
    return "%s/%s.html" % (BASE, slug)


def full_url(u):
    if not u:
        return ""
    if re.match(r"^https?://", u):
        return u
    return BASE + ("/" + u.lstrip("/") if not u.startswith("/") else u)


# ------------------------- listing -------------------------


def parse_card(card):
    a = card.select_one("a.hydrosite-mong-truyen-book-title")
    if not a or not a.get("href"):
        return None
    img = card.select_one(".hydrosite-mong-truyen-book-thumbnail img") or card.select_one("img")
    href = full_url(a["href"].strip())
    slug = href.rstrip("/").rsplit("/", 1)[-1].replace(".html", "").strip()
    if not slug or not re.match(r"^[a-z0-9\-]+$", slug, re.I):
        return None
    title = ""
    if img and img.get("alt"):
        title = img.get("alt")
    else:
        title = a.get_text(" ", strip=True)
    title = re.sub(r"\s*-\s*Chương\s*\d+.*$", "", title).strip()
    cover = img.get("src", "") if img else ""
    author = ""
    au = card.select_one(".hydrosite-mong-truyen-book-author")
    if au:
        author = clean_ws(au.get_text(" ", strip=True))
    views = 0
    v = card.select_one(".hydrosite-mong-truyen-book-views")
    if v:
        views = parse_num(v.get_text(" ", strip=True))
    status = ""
    st = card.select_one(".hydrosite-mong-truyen-book-status")
    if st:
        status = clean_ws(st.get_text(" ", strip=True))
    return {
        "slug": slug,
        "title": title or slug,
        "cover": cover,
        "author": author,
        "views": views,
        "status": "",
        "sourceUrl": href,
    }


def collect_via_ajax(page_url, page_html, seen, progress, max_pages=80):
    chuyenmuc = None
    m = re.search(r"chuyenmuc\s*[:=]\s*[\"']?(\d+)", page_html)
    if m:
        chuyenmuc = m.group(1)
    m = re.search(r"limit\s*[:=]\s*(\d+)", page_html, re.I)
    limit = int(m.group(1)) if m else 12
    if not chuyenmuc:
        return 0
    total = None
    got = 0
    for page in range(1, max_pages + 1):
        js = post_json(LIST_AJAX, {"page": str(page), "limit": limit, "chuyenmuc": chuyenmuc})
        block = js.get("html") or ""
        if block:
            soup = BeautifulSoup(block, "html.parser")
            for c in soup.select(".hydrosite-mong-truyen-book-card"):
                item = parse_card(c)
                if item and item["slug"] not in seen:
                    seen[item["slug"]] = item
                    got += 1
        if total is None:
            try:
                total = int(js.get("total_page") or 0)
            except (TypeError, ValueError):
                total = 0
        if progress:
            progress("ajax", page_url, got)
        if not block and total == 0:
            break
        if total and page >= total:
            break
    return got


def same_site(url):
    try:
        return urllib.parse.urlparse(url).netloc == urllib.parse.urlparse(BASE).netloc
    except Exception:
        return False


def collect_stories(sources, progress=None):
    seen = {}
    queue_ = []
    for s in sources:
        if s not in queue_:
            queue_.append(s)
    processed = set()
    budget = {}
    while queue_:
        url = queue_.pop(0)
        if url in processed:
            continue
        processed.add(url)
        try:
            page_html = fetch_html(url)
        except Exception as e:
            log("[list] FAIL %s (%s)" % (url, e))
            continue
        soup = BeautifulSoup(page_html, "html.parser")
        cards = soup.select(".hydrosite-mong-truyen-book-card")
        got = 0
        if cards:
            for c in cards:
                item = parse_card(c)
                if item and item["slug"] not in seen:
                    seen[item["slug"]] = item
                    got += 1
        else:
            got = collect_via_ajax(url, page_html, seen, progress) or 0
        # tuyen pagination (server-rendered pages)
        base = re.sub(r"\?.*$", "", url)
        left = budget.get(base, 20)
        if left > 0:
            for link in soup.select("a[href*='page=']"):
                href = full_url(link.get("href", ""))
                if not href or not same_site(href) or href in processed or href in queue_:
                    continue
                queue_.append(href)
                left -= 1
                if left <= 0:
                    break
            budget[base] = left
        log("[list] %s => %d stories (total %d)" % (url, got, len(seen)))
    return list(seen.values())


# ------------------------- detail & chapters -------------------------


def map_status(raw):
    if not raw:
        return "ongoing"
    low = htmlmod.unescape(raw).lower()
    if "hoàn" in low or "hoan" in low or "full" in low or "trọn" in low:
        return "full"
    return "ongoing"


def chapter_name(num, raw):
    if not raw:
        return "Chương %d" % num
    m = re.match(r"^Chương\s+(\d+)\s*[:\-]?\s*(.*)$", raw, re.I)
    if not m:
        return raw
    nn = int(m.group(1))
    tail = (m.group(2) or "").strip()
    if nn != num:
        return raw
    if not tail or re.match(r"^Chương\s+\d+\s*$", tail, re.I) or tail.lower().startswith("chương"):
        return "Chương %d" % num
    return "Chương %d: %s" % (num, tail)


def fetch_detail(slug, progress=None):
    url = story_url(slug)
    text = fetch_html(url)
    soup = BeautifulSoup(text, "html.parser")

    title = ""
    t = soup.select_one(".mdv-san-pham-show-name")
    if t:
        title = clean_ws(t.get_text(" ", strip=True))
    if not title:
        og = soup.select_one('meta[property="og:title"]')
        title = clean_ws(og.get("content")) if og else slug

    id_truyen = ""
    inp = soup.select_one('input[name="id_truyen"]')
    if inp and inp.get("value"):
        id_truyen = inp.get("value").strip()

    cover_url = ""
    img = soup.select_one(".san-pham-book-item-show-image img")
    if img and img.get("src"):
        cover_url = full_url(img["src"])
    if not cover_url or "no-image" in cover_url.lower():
        og = soup.select_one('meta[property="og:image"]')
        if og and og.get("content"):
            cover_url = full_url(og["content"])

    author = ""
    au = soup.select_one(".tac-gia-ten")
    if au:
        author = clean_ws(au.get_text(" | ", strip=True))

    views = 0
    v = soup.select_one(".mdv-sps-luot-xem .san-pham-read-text")
    if v:
        views = parse_num(v.get_text(" ", strip=True))

    status = ""
    st = soup.select_one(".mdv-sps-tinh-trang")
    if st:
        status = clean_ws(st.get_text(" ", strip=True))

    desc = ""
    d = soup.select_one(".mdv-san-pham-show-gioi-thieu-des")
    if d:
        desc = htmlmod.unescape(d.get_text("\n", strip=True))

    genres = []
    for gtag in soup.select("ul.san-pham-the-loai a"):
        g = clean_ws(gtag.get_text(" ", strip=True))
        if g and g not in genres:
            genres.append(g)

    rating = None
    m = re.search(r"sourcePage\s*=\s*'([^']+)'", text)
    if progress:
        progress("detail", slug, 1)

    meta = {
        "slug": slug,
        "title": title,
        "author": author,
        "cover": cover_url,
        "status": map_status(status),
        "rating": None,
        "views": views,
        "genres": genres,
        "desc": desc,
        "sourceUrl": url,
    }
    if rating is not None:
        meta["rating"] = rating
    return meta, id_truyen


def fetch_chapters(slug, id_truyen, progress=None, max_pages=300):
    chapters = []
    for page in range(1, max_pages + 1):
        try:
            html_text = fetch_html(CHAPTER_LIST_AJAX,
                                   {"page": str(page), "id_truyen": str(id_truyen)},
                                   referer=story_url(slug))
        except Exception as e:
            log("[chapters] FAIL %s page %d (%s)" % (slug, page, e))
            break
        soup = BeautifulSoup(html_text, "html.parser")
        rows = soup.select(".mvd-san-pham-show-danh-sach-chuong-item a") or \
               soup.select("a[href*='chuong=']")
        if not rows:
            break
        found = 0
        for a in rows:
            href = a.get("href", "")
            m = re.search(r"[?&]chuong=(\d+)", href)
            if not m:
                continue
            num = int(m.group(1))
            if any(c["number"] == num for c in chapters):
                continue
            name = clean_ws(a.get_text(" ", strip=True))
            chapters.append({
                "number": num,
                "name": chapter_name(num, name),
                "url": "/chuong/%s/%d" % (slug, num),
            })
            found += 1
        if progress:
            progress("chapters", slug, len(chapters))
        if found == 0:
            break
        time.sleep(_delay)
    chapters.sort(key=lambda c: c["number"])
    return chapters


def chapters_from_reader(slug):
    chapters = []
    try:
        text = fetch_html(story_url(slug))
    except Exception:
        return chapters
    soup = BeautifulSoup(text, "html.parser")
    for a in soup.select("#chuongList .msv-chuong-item a"):
        href = a.get("href", "")
        m = re.search(r"[?&]chuong=(\d+)", href)
        if not m:
            continue
        num = int(m.group(1))
        name = clean_ws(a.get_text(" ", strip=True))
        if not any(c["number"] == num for c in chapters):
            chapters.append({
                "number": num,
                "name": chapter_name(num, name),
                "url": "/chuong/%s/%d" % (slug, num),
            })
    chapters.sort(key=lambda c: c["number"])
    return chapters


def fetch_chapter_content(slug, number, progress=None):
    url = "%s/%s.html?chuong=%d" % (BASE, slug, number)
    text = fetch_html(url)
    soup = BeautifulSoup(text, "html.parser")
    title = ""
    t = soup.select_one(".mdv-san-pham-detail-chuong-title-text")
    if t:
        title = clean_ws(t.get_text(" ", strip=True))
    content = ""
    div = soup.select_one("#noi_dung_truyen")
    if div:
        ps = div.find_all("p")
        if ps:
            content = "\n".join(htmlmod.unescape(p.get_text()).strip() for p in ps)
        else:
            content = htmlmod.unescape(div.get_text()).strip()
    published = ""
    tg = soup.select_one(".mdv-san-pham-detail-tgian small")
    if tg:
        published = clean_ws(tg.get_text(" ", strip=True)).replace("Đăng lúc", "").strip()
    if progress:
        progress("chapter", slug, number)
    return {
        "number": number,
        "title": title or ("Chương %d" % number),
        "content": content,
        "published": published,
    }


# ------------------------- covers & save -------------------------


def download_cover(slug, cover_url, covers_dir):
    if not cover_url or "no-image" in cover_url.lower():
        return ""
    ext = ".jpg"
    path = urllib.parse.urlparse(cover_url).path
    m = re.search(r"\.(jpe?g|png|webp|gif)$", path, re.I)
    if m:
        ext = "." + m.group(1).lower()
        if ext == ".jpeg":
            ext = ".jpg"
    dest = os.path.join(covers_dir, slug + ext)
    if os.path.exists(dest):
        return "/covers/" + slug + ext
    for _ in range(3):
        try:
            r = requests.get(cover_url, headers=HEADERS, timeout=30)
            if r.status_code == 200 and r.content:
                with open(dest, "wb") as f:
                    f.write(r.content)
                return "/covers/" + slug + ext
        except Exception:
            pass
        time.sleep(_delay + 1)
    return ""


def meta_path(data_dir, slug):
    return os.path.join(data_dir, "meta", slug + ".json")


def chap_path(data_dir, slug, number):
    return os.path.join(data_dir, "chapters", "%s_%d.txt" % (slug, number))


def scrape_story(item, opts=None, progress=None):
    opts = opts or {}
    data_dir = opts.get("data_dir", "data")
    covers_dir = opts.get("covers_dir", "covers")
    fresh = bool(opts.get("fresh"))
    max_chapters = int(opts.get("max_chapters") or 0)
    do_covers = bool(opts.get("covers", True))

    slug = item["slug"]
    mpath = meta_path(data_dir, slug)
    meta = {}
    if not fresh and os.path.exists(mpath):
        try:
            with open(mpath, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            meta = {}

    chapters = meta.get("chapters") or []
    have_all = bool(chapters) and not fresh and \
        all(os.path.exists(chap_path(data_dir, slug, c["number"])) for c in chapters)
    if have_all:
        if progress:
            progress("skip", slug, chapters[-1]["number"])
        return meta, []

    try:
        detail, id_truyen = fetch_detail(slug, progress)
    except Exception as e:
        log("[fail] detail %s (%s)" % (slug, e))
        if progress:
            progress("fail", slug, 0)
        return meta, []

    meta = dict(item)
    meta.update(detail)

    chapters = []
    if id_truyen:
        try:
            chapters = fetch_chapters(slug, id_truyen, progress)
        except Exception as e:
            log("[fail] list-chuong %s (%s)" % (slug, e))
    if not chapters:
        chapters = chapters_from_reader(slug)
    if max_chapters and len(chapters) > max_chapters:
        chapters = chapters[:max_chapters]
    meta["chapters"] = chapters
    meta["chapterCount"] = len(chapters)

    contents = []
    for c in chapters:
        cpath = chap_path(data_dir, slug, c["number"])
        content = ""
        if fresh or not os.path.exists(cpath):
            try:
                ch = fetch_chapter_content(slug, c["number"], progress)
                content = ch["content"]
                if content:
                    os.makedirs(os.path.dirname(cpath), exist_ok=True)
                    with open(cpath, "w", encoding="utf-8") as f:
                        f.write(content)
                if ch["published"] and not meta.get("published"):
                    meta["published"] = ch["published"]
            except Exception as e:
                log("[fail] chuong %s/%d (%s)" % (slug, c["number"], e))
            time.sleep(_delay)
        else:
            try:
                with open(cpath, "r", encoding="utf-8") as f:
                    content = f.read()
            except Exception:
                content = ""
        contents.append({"number": c["number"], "name": c["name"], "content": content})

    cover = ""
    if do_covers:
        cover = download_cover(slug, meta.get("cover"), covers_dir)
    meta["cover"] = cover
    meta["lastUpdated"] = int(time.time() * 1000)
    meta["fetched"] = bool(chapters)

    os.makedirs(os.path.dirname(mpath), exist_ok=True)
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    log("[ok] %s (%d chapters)" % (slug, len(chapters)))
    return meta, contents


# ------------------------- signed jobs (admin) -------------------------


def job_fetch_all(opts=None, emit=None):
    emit = emit or (lambda d: None)
    opts = opts or {}
    sources = list(opts.get("sources") or DEFAULT_SOURCES)
    stories = collect_stories(sources, None)
    total = len(stories)
    limit = int(opts.get("limit") or 0)
    if limit:
        stories = stories[:limit]
        total = limit
    detail_done = 0
    chapter_done = 0
    errors = 0
    emit({"total": total, "detailDone": 0, "chapterDone": 0, "errors": 0})
    for item in stories:
        try:
            meta, contents = scrape_story(item, opts)
            detail_done += 1
            chapter_done += len(contents)
        except Exception as e:
            log("[job] fail %s (%s)" % (item.get("slug"), e))
            errors += 1
        emit({"total": total, "detailDone": detail_done, "chapterDone": chapter_done, "errors": errors})
    emit({"total": total, "detailDone": detail_done, "chapterDone": chapter_done, "errors": errors, "complete": True})


def job_fetch_specified(slugs, opts=None, emit=None):
    emit = emit or (lambda d: None)
    opts = opts or {}
    total = len(slugs)
    detail_done = 0
    chapter_done = 0
    errors = 0
    emit({"total": total, "detailDone": 0, "chapterDone": 0, "errors": 0})
    for s in slugs:
        item = {"slug": s, "title": s, "cover": "", "author": "", "views": 0, "status": ""}
        try:
            meta, contents = scrape_story(item, opts)
            detail_done += 1
            chapter_done += len(contents)
        except Exception as e:
            log("[job] fail %s (%s)" % (s, e))
            errors += 1
        emit({"total": total, "detailDone": detail_done, "chapterDone": chapter_done, "errors": errors})
    emit({"total": total, "detailDone": detail_done, "chapterDone": chapter_done, "errors": errors, "complete": True})


def job_fetch_covers(opts=None, emit=None):
    emit = emit or (lambda d: None)
    opts = opts or {}
    data_dir = opts.get("data_dir", "data")
    covers_dir = opts.get("covers_dir", "covers")
    meta_dir = os.path.join(data_dir, "meta")
    slugs = [fn[:-5] for fn in os.listdir(meta_dir) if fn.endswith(".json")] if os.path.isdir(meta_dir) else []
    total = len(slugs)
    done = 0
    errors = 0
    emit({"total": total, "done": 0, "errors": 0})
    for slug in slugs:
        try:
            with open(os.path.join(meta_dir, slug + ".json"), "r", encoding="utf-8") as f:
                meta = json.load(f)
            cur = meta.get("cover") or ""
            if cur.startswith("/covers/"):
                done += 1
            else:
                need = meta.get("sourceUrl") and story_url(slug) or ""
                if not need:
                    need, _ = fetch_detail(slug)
                cover = download_cover(slug, need.get("cover") if isinstance(need, dict) else "", covers_dir)
                if cover:
                    meta["cover"] = cover
                    with open(os.path.join(meta_dir, slug + ".json"), "w", encoding="utf-8") as f:
                        json.dump(meta, f, ensure_ascii=False, indent=2)
                    done += 1
                else:
                    errors += 1
        except Exception:
            errors += 1
        emit({"total": total, "done": done, "errors": errors})
    emit({"total": total, "done": done, "errors": errors, "complete": True})


# ------------------------- api push (--api) -------------------------


def api_login(api_url, password):
    try:
        r = requests.post(api_url.rstrip("/") + "/api/admin/login",
                          json={"password": password or "admin"}, timeout=30)
        if r.status_code == 200:
            return r.json().get("token")
    except Exception:
        pass
    return None


def api_push_story(api_url, token, meta, contents, cover_b64=None, cover_ext=None):
    payload = {
        "novel": meta,
        "chapters": contents,
        "coverBase64": cover_b64,
        "coverExt": cover_ext,
    }
    try:
        r = requests.post(api_url.rstrip("/") + "/api/local/import",
                          headers={"Content-Type": "application/json", "x-admin-token": token},
                          json=payload, timeout=120)
        return r.status_code == 200
    except Exception:
        return False


# ------------------------- CLI -------------------------


def main():
    ap = argparse.ArgumentParser(description="Scraper kiwiiudammy.com -> data/ + covers/ (+ push len server)")
    ap.add_argument("--sources", nargs="+", default=None,
                    help="Danh sach URL trang danh muc (mac dinh: truyen-hot, ngon-tinh, hoan-thanh, truyen-cho-full)")
    ap.add_argument("--limit", type=int, default=0, help="Gioi han so truyen can scrape")
    ap.add_argument("--chapters", type=int, default=0, help="Gioi han so chuong moi truyen")
    ap.add_argument("--delay", type=float, default=0.5, help="Giay cho giua cac request")
    ap.add_argument("--fresh", action="store_true", help="Scrape lai het (khong bo qua file co san)")
    ap.add_argument("--no-covers", action="store_true", help="Khong tai anh bia")
    ap.add_argument("--list", action="store_true", help="Chi in danh sach URL truyen tim thay")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--covers-dir", default="covers")
    ap.add_argument("--api", default=None, help="URL server de upload vi du http://localhost:8000")
    ap.add_argument("--admin-pass", default=None, help="Mat khau admin (can khi --api)")
    args = ap.parse_args()

    global _delay
    _delay = args.delay

    opts = {
        "data_dir": args.data_dir,
        "covers_dir": args.covers_dir,
        "fresh": args.fresh,
        "max_chapters": args.chapters,
        "covers": not args.no_covers,
        "sources": args.sources or DEFAULT_SOURCES,
        "limit": args.limit,
    }

    log("Da cai dat requests ? %r" % opts["sources"][0] if args.sources else "fetching...")

    stories = collect_stories(list(opts["sources"]), progress=lambda *a: None)
    if args.limit:
        stories = stories[:args.limit]

    if args.list:
        for s in stories:
            log(s["sourceUrl"])
        log("Tong so truyen: %d" % len(stories))
        return

    token = None
    if args.api:
        token = api_login(args.api, args.admin_pass)
        log("[api] login %s" % ("OK" if token else "FAIL"))

    os.makedirs(os.path.join(args.data_dir, "meta"), exist_ok=True)
    os.makedirs(os.path.join(args.data_dir, "chapters"), exist_ok=True)
    os.makedirs(args.covers_dir, exist_ok=True)

    start = time.time()
    for i, item in enumerate(stories, 1):
        meta, contents = scrape_story(item, opts)
        if args.api and token:
            cover_b64, cover_ext = None, None
            local_cover = meta.get("cover") or ""
            if local_cover.startswith("/covers/"):
                fpath = os.path.join(args.covers_dir, os.path.basename(local_cover))
                if os.path.exists(fpath):
                    with open(fpath, "rb") as f:
                        cover_b64 = base64.b64encode(f.read()).decode("ascii")
                    cover_ext = os.path.splitext(fpath)[1].lstrip(".") or "jpg"
            ok_push = api_push_story(args.api, token, meta, contents, cover_b64, cover_ext)
            log("[push] %s => %s" % (item["slug"], "OK" if ok_push else "FAIL"))
        log("[%d/%d] %s (%ds)" % (i, len(stories), item["slug"], int(time.time() - start)))
    log("Done: %d stories" % len(stories))


if __name__ == "__main__":
    main()