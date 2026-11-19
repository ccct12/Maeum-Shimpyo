"""본 사이트 index.html에서 시제품 v2/index.html을 만든다.
첫 화면(#v-home)만 v2/home.html로 바꾸고, 나머지는 본 사이트와 똑같이 둔다.
index.html을 고친 뒤에는 `python3 scripts/build_v2.py`를 다시 돌리면 v2에도 반영된다."""
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'index.html').read_text(encoding='utf-8')
home = (root / 'v2' / 'home.html').read_text(encoding='utf-8').rstrip() + '\n'
s, n = re.subn(r'    <section class="view page" id="v-home".*?</section>\n', lambda m: home, src, count=1, flags=re.S)
assert n == 1, '처음 화면 구역을 찾지 못했어요'
s = re.sub(r'(href|src)="assets/', r'\1="../assets/', s)
ver = re.search(r'style\.css\?v=(\d+)', s).group(1)
s = s.replace('<title>', '<meta name="robots" content="noindex">\n<title>', 1)
s = s.replace('</head>', '<link rel="stylesheet" href="v2.css?v=%s">\n</head>' % ver, 1)
s = s.replace('<script src="../assets/app.js', "<script>window.MAEUM_VARIANT='v2';(function(c){c.FALLBACK_URL='../'+c.FALLBACK_URL;c.STATS_URL='../'+c.STATS_URL;c.SUPPORT_FALLBACK_URL='../'+c.SUPPORT_FALLBACK_URL;})(window.MAEUM_CONFIG);</script>\n<script src=\"../assets/app.js", 1)
s = s.replace('</body>', '<script src="v2.js?v=%s"></script>\n</body>' % ver, 1)
s = s.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- 자동 생성: scripts/build_v2.py. 이 파일을 직접 고치지 말고 index.html·v2/home.html을 고친 뒤 다시 만드세요 -->', 1)
(root / 'v2' / 'index.html').write_text(s, encoding='utf-8')
print('v2/index.html 생성, 버전', ver)
