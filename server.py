# [Nhiệm vụ của file]: Server web + API lưu dữ liệu dùng chung cho C2 Chill Chill Online.
# - Phục vụ tĩnh toàn bộ thư mục D:\WEB (web + admin) như python -m http.server.
# - GET  /api/store -> trả JSON data truyện hiện tại (file data/store.json).
# - POST /api/store -> ghi data mới từ client vào file (mọi thiết bị dùng chung một nguồn).
# data/store.json là nguồn dữ liệu thật; browser localStorage chỉ đóng vai trò cache dự phòng.
import json
import os
import sys
import socket
import ipaddress
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
DATA_FILE = os.path.join(DATA_DIR, 'store.json')
DEFAULTS = {'added': [], 'updated': {}, 'removed': [], 'clicks': {}}

# Chỉ cho phép crawl từ các nguồn đã được cấu hình — tránh biến thành open proxy.
ALLOWED_CRAWL_HOSTS = ['truyen2k.com', 'monkeydd.com', 'kiwiiudammy.com', 'bienxinhtruyen.com']

# Giới hạn dữ liệu nhận về để chống DoS qua bộ nhớ.
MAX_STORE_BYTES = 12 * 1024 * 1024        # toàn bộ payload POST /api/store
MAX_HTML_BYTES = 2 * 1024 * 1024          # trang HTML crawl
MAX_IMAGE_BYTES = 8 * 1024 * 1024         # ảnh proxy-image


# ---------- Bảo vệ SSRF (chặn proxy fetch về IP nội bộ / LAN) ----------
def _is_private_ip(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return (a.is_private or a.is_loopback or a.is_link_local
            or a.is_multicast or a.is_reserved or a.is_unspecified)


# Kiểm tra target URL: chặn nếu là IP literal private/loopback/link-local,
# hoặc hostname mà khi resolve MỌI địa chỉ đều private (bail closed khi không resolve được).
def _is_blocked_target(url):
    try:
        host = (urlparse(url).hostname or '').strip('[]').lower()
        if not host or host == 'localhost':
            return True
        try:
            ipaddress.ip_address(host)
            return _is_private_ip(host)
        except ValueError:
            pass
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror:
            return True
        addrs = {info[4][0] for info in infos}
        if not addrs:
            return True
        return all(_is_private_ip(a) for a in addrs)
    except Exception:
        return True


# ---------- Vệ sinh dữ liệu POST /api/store ----------
# Loại bỏ ký tự < > khỏi mọi chuỗi — chặn kịch bản kẻ trong LAN gửi PHÂN ĐOẠN html
# (title/chương/đoạn văn) để lưu XSS vào store dùng chung.
def _sanitize_value(v):
    if isinstance(v, str):
        return v.replace('<', '').replace('>', '')
    if isinstance(v, list):
        return [_sanitize_value(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _sanitize_value(x) for k, x in v.items()}
    return v


def _sanitize_incoming(incoming):
    if not isinstance(incoming, dict):
        return {}
    out = {}
    for key in ('added', 'updated', 'removed', 'clicks'):
        if key in incoming:
            out[key] = _sanitize_value(incoming[key])
    return out


def load_data():
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for k, v in DEFAULTS.items():
            if k not in data:
                data[k] = v
        return data
    except Exception:
        return dict(DEFAULTS)


def save_data(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)


def _ts(item):
    if not isinstance(item, dict):
        return 0
    try:
        t = item.get('ts')
        return int(t) if t is not None else 0
    except (TypeError, ValueError):
        return 0


# Hợp nhất hai danh sách chương theo id — KHÔNG BAO GIỜ làm mất chương.
# - Chương chỉ có ở base -> giữ.
# - Chương chỉ có ở incoming -> thêm (chương vừa lưu không bị rơi).
# - Chương trùng id -> giữ bản có updatedAt mới hơn (không cho snapshot cũ ghi đè).
def _merge_chapters(base_list, incoming_list):
    base_map = {}
    for c in (base_list or []):
        if isinstance(c, dict) and c.get('id') is not None:
            base_map[str(c['id'])] = c
    out = []
    seen = set()
    for c in (base_list or []):
        if isinstance(c, dict) and c.get('id') is None:
            continue
        out.append(c)
        seen.add(str(c['id']))
    for c in (incoming_list or []):
        if not isinstance(c, dict):
            continue
        cid = str(c['id'] or id(c))
        if cid in seen:
            if cid in base_map:
                b = base_map[cid]
                bu = str(b.get('updatedAt') or '')
                cu = str(c.get('updatedAt') or '')
                if cu and (cu > bu or not bu):
                    out = [c if str(x.get('id')) == cid else x for x in out]
            continue
        out.append(c)
        seen.add(cid)
    return out


# Hợp nhất hai story (cùng id) theo nguyên tắc KHÔNG MẤT DỮ LIỆU:
# - Bản incoming có ts MỚI HƠN hẳn (admin thao tác bằng code mới) => chính là trạng
#   thái đầy đủ, dùng thẳng — tôn trọng cả việc XÓA chương.
# - Bản incoming CŨ hơn / không có ts (legacy browser hoặc tab snapshot cũ) => chỉ gộp
#   THÊM: chương mới được đưa vào, chương đang có giữ nguyên, không ghi đè field khác.
def _merge_story(base_v, v):
    if _ts(v) >= _ts(base_v):
        return v
    if not isinstance(base_v, dict):
        return dict(v)
    out = dict(base_v)
    if isinstance(v.get('chapters'), list):
        out['chapters'] = _merge_chapters(base_v.get('chapters', []) or [], v.get('chapters') or [])
    return out


# Hợp nhất dữ liệu từ client (incoming) vào dữ liệu đang lưu (base).
# Lý do: mỗi tab/browser giữ một bản snapshot cũ của toàn bộ store; nếu ghi đè
# trực tiếp thì một thao tác nhỏ của tab cũ (click/đóng tab) sẽ XÓA truyện mới
# vừa được thêm từ thiết bị khác. Merge theo id/key để không bao giờ làm mất dữ liệu.
def merge_data(base, incoming):
    out = {}
    for k, v in base.items():
        out[k] = v

    # added: chống mất truyện mới — giữ cả truyện đang có lẫn truyện incoming;
    # khi trùng id thì hợp nhất theo chương (bản ts mới hơn thắng field).
    added_map = {}
    for s in out.get('added', []) or []:
        if isinstance(s, dict) and s.get('id') is not None:
            key = str(s['id'])
            added_map[key] = s if key not in added_map else _merge_story(added_map[key], s)
    for s in incoming.get('added', []) or []:
        if isinstance(s, dict) and s.get('id') is not None:
            key = str(s['id'])
            added_map[key] = _merge_story(added_map.get(key, dict(s)), s) if key in added_map else s
        elif isinstance(s, dict):
            added_map[id(s)] = s
    out['added'] = list(added_map.values())

    # updated: hợp nhất theo từng story — bản có ts MỚI HƠN ghi đè field tương ứng;
    # giữ field không có ở incoming, không xóa story patch của thiết bị khác.
    upd = dict(out.get('updated', {}) or {})
    for k, v in (incoming.get('updated', {}) or {}).items():
        base_v = upd.get(k)
        if isinstance(base_v, dict) and isinstance(v, dict):
            if _ts(v) >= _ts(base_v):
                upd[k] = {**base_v, **v}
            else:
                upd[k] = base_v
                if isinstance(v.get('chapters'), list):
                    merged_b = dict(base_v)
                    merged_b['chapters'] = _merge_chapters(base_v.get('chapters', []), v.get('chapters') or [])
                    upd[k] = merged_b
        else:
            upd[k] = _merge_story(base_v, v)
    out['updated'] = upd

    # removed: hợp nhất danh sách id (không lặp, không mất).
    removed = list(out.get('removed', []) or [])
    for r in (incoming.get('removed', []) or []):
        if r not in removed:
            removed.append(r)
    out['removed'] = removed

    # clicks: lấy max — số click không bao giờ thụt lùi dù tab cũ gửi bản ít hơn.
    clicks = dict(out.get('clicks', {}) or {})
    for k, v in (incoming.get('clicks', {}) or {}).items():
        clicks[k] = max(int(clicks.get(k, 0) or 0), int(v or 0))
    out['clicks'] = clicks

    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_allowed_host(self, url):
        try:
            host = (urlparse(url).hostname or '').lower().replace('www.', '')
            return any(host == h or host.endswith('.' + h) for h in ALLOWED_CRAWL_HOSTS)
        except Exception:
            return False

    def _proxy_fetch(self, url, timeout=12, as_json=True):
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
            'Accept': '*/*',
            'Referer': 'https://truyen2k.com/',
        })
        limit = MAX_HTML_BYTES if as_json else MAX_IMAGE_BYTES
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ct = (resp.headers.get('Content-Type') or '').lower()
            raw = resp.read(limit + 1)
            if len(raw) > limit:
                self._send_json({'ok': False, 'error': 'Nội dung quá lớn'}, 413)
                return
            if as_json:
                text = raw.decode('utf-8', errors='ignore')
                self._send_json({'ok': True, 'html': text, 'url': url})
            else:
                import base64
                mime = 'image/jpeg'
                if 'png' in ct: mime = 'image/png'
                elif 'webp' in ct: mime = 'image/webp'
                b64 = base64.b64encode(raw).decode('ascii')
                self._send_json({'ok': True, 'dataUrl': f'data:{mime};base64,{b64}', 'url': url})

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/store':
            self._send_json(load_data())
            return
        if path == '/api/crawl':
            try:
                qs = parse_qs(urlparse(self.path).query)
                target = (qs.get('url', [''])[0]).strip()
                if not target or not target.startswith(('http://', 'https://')):
                    self._send_json({'ok': False, 'error': 'Thiếu URL hợp lệ'}, 400); return
                if not self._is_allowed_host(target):
                    self._send_json({'ok': False, 'error': 'Nguồn không được hỗ trợ'}, 403); return
                if _is_blocked_target(target):
                    self._send_json({'ok': False, 'error': 'Địa chỉ không được phép'}, 403); return
                self._proxy_fetch(target, timeout=12, as_json=True)
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)[:200]}, 502)
            return
        if path == '/api/proxy-image':
            try:
                qs = parse_qs(urlparse(self.path).query)
                target = (qs.get('url', [''])[0]).strip()
                if not target or not target.startswith(('http://', 'https://')):
                    self._send_json({'ok': False, 'error': 'Thiếu URL ảnh hợp lệ'}, 400); return
                if _is_blocked_target(target):
                    self._send_json({'ok': False, 'error': 'Địa chỉ không được phép'}, 403); return
                self._proxy_fetch(target, timeout=15, as_json=False)
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)[:200]}, 502)
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] == '/api/store':
            try:
                length = int(self.headers.get('Content-Length', 0) or 0)
                if length <= 0 or length > MAX_STORE_BYTES:
                    self._send_json({'ok': False, 'error': 'payload quá lớn'}, 413)
                    return
                raw = self.rfile.read(length).decode('utf-8')
                incoming = _sanitize_incoming(json.loads(raw))
                save_data(merge_data(load_data(), incoming))
            except Exception:
                self.send_error(400, 'bad json')
                return
            self._send_json({'ok': True})
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        pass


def main():
    os.chdir(ROOT)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    with ThreadingHTTPServer(('0.0.0.0', port), Handler) as httpd:
        print('Serving', ROOT, 'on http://0.0.0.0:' + str(port), 'data=', DATA_FILE, flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()