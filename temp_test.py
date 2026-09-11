import urllib.request
import urllib.parse
import http.cookiejar
import json

BASE = "https://kiwiiudammy.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def post(url, data, referer):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    h = {
        "User-Agent": UA,
        "Accept-Language": "vi-VN,vi;q=0.9",
        "Referer": referer,
        "Origin": BASE,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }
    body = urllib.parse.urlencode(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    try:
        resp = opener.open(req, timeout=25)
        raw = resp.read()
        if raw[:3] == b'\xef\xbb\xbf':
            raw = raw[3:]
        return raw.decode('utf-8', 'ignore').strip()
    except Exception as e:
        return "ERROR: %s" % e

out = []

# 1) search endpoint
r1 = post(BASE + "/sources/ajax/mongdaovien/tim-kiem-truyen.php",
          {"keyword": "may tan troi"}, BASE + "/truyen-hot.html")
out.append("== SEARCH ==")
out.append(r1[:600])

# 2) chapters for story id 1831
r2 = post(BASE + "/sources/ajax/load-chapters.php",
          {"page": "1", "id_truyen": "1831"}, BASE + "/may-tan-troi-lai-sang.html")
out.append("\n\n== LOAD-CHAPTERS id=1831 ==")
out.append(r2[:800])

# 3) alternative chapter loader mongdaovien
r3 = post(BASE + "/sources/ajax/mongdaovien/load-chuong.php",
          {"id_truyen": "1831"}, BASE + "/may-tan-troi-lai-sang.html")
out.append("\n\n== mongdaovien/load-chuong ==")
out.append(r3[:800])

with open(r'D:\TEHI\temp_test.txt', 'w', encoding='utf-8') as f:
    f.write("\n\n".join(out))
print("done")