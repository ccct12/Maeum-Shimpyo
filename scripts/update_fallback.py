"""Apps Script 웹 앱에서 노출 기관 목록을 받아 data/facilities-fallback.json(예비 데이터)을 새로 만든다.
시트 데이터를 못 불러올 때 사이트가 먼저 보여 주는 사본이라, 받아 온 내용이 이상하면 덮어쓰지 않는다."""
import json, re, sys, urllib.request
from datetime import datetime, timedelta, timezone

cfg = open('assets/config.js', encoding='utf-8').read()
m = re.search(r"DATA_URL:\s*'([^']+)'", cfg)
if not m:
    sys.exit('config.js에서 DATA_URL을 찾지 못했어요')
url = m.group(1) + ('&' if '?' in m.group(1) else '?') + 'type=facilities&v=gh' + datetime.now().strftime('%Y%m%d%H')
with urllib.request.urlopen(url, timeout=120) as r:
    j = json.load(r)

items = j.get('items') or []
old = json.load(open('data/facilities-fallback.json', encoding='utf-8'))
# 안전장치: 비었거나 갑자기 절반 아래로 줄면(시트 오류 등) 기존 사본을 그대로 둔다
if len(items) < 1000 or len(items) < len(old.get('items', [])) * 0.5:
    sys.exit(f'받아 온 기관 수가 너무 적어요({len(items)}곳). 예비 데이터를 바꾸지 않아요.')
if not all('id' in f and 'lat' in f for f in items[:50]):
    sys.exit('받아 온 형식이 예상과 달라요. 예비 데이터를 바꾸지 않아요.')

kst = datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d')
out = {'asOf': kst, 'fallback': True, 'count': len(items), 'items': items}
json.dump(out, open('data/facilities-fallback.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(f'예비 데이터 갱신: {len(items)}곳 (그 밖의 기관 {sum(1 for f in items if f.get("g"))}곳)')
