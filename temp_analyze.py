import urllib.request
import urllib.parse
import json

url = "https://kiwiiudammy.com/sources/ajax/mong-truyen-truyen-danh-muc.php"
data = urllib.parse.urlencode({
    'page': 1,
    'limit': 5,
    'chuyenmuc': '268'
}).encode('utf-8')

req = urllib.request.Request(url, data=data, method='POST')
req.add_header('Content-Type', 'application/x-www-form-urlencoded')
req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
req.add_header('Referer', 'https://kiwiiudammy.com/truyen-hot.html')
req.add_header('X-Requested-With', 'XMLHttpRequest')
req.add_header('Origin', 'https://kiwiiudammy.com')
req.add_header('Accept', 'application/json, text/javascript, */*; q=0.01')

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        if raw[:3] == b'\xef\xbb\xbf':
            raw = raw[3:]
        result = json.loads(raw.decode('utf-8'))
        with open(r'D:\TEHI\temp_api_response.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print("Keys:", list(result.keys()))
        if 'total_page' in result:
            print("Total pages:", result['total_page'])
        if 'html' in result:
            with open(r'D:\TEHI\temp_api_html.html', 'w', encoding='utf-8') as f:
                f.write(result['html'])
            print("HTML length:", len(result['html']))
except Exception as e:
    print(f"Error: {e}")
