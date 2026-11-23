"""data/facilities-fallback.json으로 시군구별 정적 페이지(area/<지역>/index.html)와 sitemap.xml을 만든다.

- 검색엔진은 주소의 # 뒤를 따로 보지 않아서, 앱 화면만으로는 "송파구 정신건강의학과" 같은 검색에 걸리지 않는다.
  그래서 지역마다 실제 기관 목록이 들어간 HTML을 따로 만든다.
- 순위·추천 없이 가나다순. 거리·진료 중 여부는 앱(지도)에서 계산한다.
- 내용이 그대로면 파일을 다시 쓰지 않고, sitemap의 lastmod도 그대로 둔다(6시간마다 의미 없는 커밋이 생기지 않게).
실행: python scripts/build_area_pages.py
"""
import html, json, os, re, shutil, statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

BASE = 'https://ccct12.github.io/Maeum-Shimpyo/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'area')
TODAY = datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d')
CSS_V = '202611231100'

# 주소 첫 단어 → (짧은 이름, 정식 이름)
SIDO = [
    ('서울', '서울특별시', ['서울특별시', '서울시', '서울']),
    ('부산', '부산광역시', ['부산광역시', '부산']),
    ('대구', '대구광역시', ['대구광역시', '대구']),
    ('인천', '인천광역시', ['인천광역시', '인천']),
    ('광주', '광주 (전남광주통합특별시)', ['광주광역시']),
    ('대전', '대전광역시', ['대전광역시', '대전']),
    ('울산', '울산광역시', ['울산광역시', '울산']),
    ('세종', '세종특별자치시', ['세종특별자치시', '세종시', '세종']),
    ('경기', '경기도', ['경기도', '경기']),
    ('강원', '강원특별자치도', ['강원특별자치도', '강원도', '강원']),
    ('충북', '충청북도', ['충청북도', '충북']),
    ('충남', '충청남도', ['충청남도', '충남']),
    ('전북', '전북특별자치도', ['전북특별자치도', '전라북도', '전북']),
    ('전남', '전남 (전남광주통합특별시)', ['전라남도', '전남']),
    ('경북', '경상북도', ['경상북도', '경북']),
    ('경남', '경상남도', ['경상남도', '경남']),
    ('제주', '제주특별자치도', ['제주특별자치도', '제주도', '제주']),
]
ALIAS = {a: s for s, _, al in SIDO for a in al}
# 최신 심평원 자료는 '전남광주통합특별시'로, 예전 자료는 광주광역시·전라남도로 적혀 있다.
# 같은 동네가 두 페이지로 갈리지 않게, 검색에 익숙한 이름(광주 ○구 / 전남 ○○시·군)으로 모은다.
UNIFIED = '전남광주통합특별시'
GWANGJU_GU = {'동구', '서구', '남구', '북구', '광산구'}
FULL = {s: f for s, f, _ in SIDO}
ORDER = [s for s, _, _ in SIDO]

FREE_FIRST = ['정신건강복지센터(광역)', '정신건강복지센터', '자살예방센터', '중독관리통합지원센터', '보건소', '보건의료원', '보건지소']
GROUP = {'care': '요양·재활·생활시설', 'gen': '일반 병의원·보건기관', 'unk': '진료과목 확인 필요'}
DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
DAYKO = dict(zip(DAYS, '월화수목금토일'))
CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
e = html.escape


def mins(t):
    h, m = str(t).split(':')
    return int(h) * 60 + int(m)


def area_of(addr):
    t = re.sub(r'\s+', ' ', str(addr or '')).strip().split(' ')
    sido = ALIAS.get(t[0]) if t else None
    if t and t[0] == UNIFIED:
        sido = ('광주' if t[1] in GWANGJU_GU else '전남') if len(t) > 1 else None
    if sido == '세종':
        return '세종', '세종시'
    if sido and len(t) > 1 and re.search(r'(시|군|구)$', t[1]):
        return sido, t[1]
    if not sido and t and re.search(r'(시|군)$', t[0]):   # "강릉시 남구길 …"처럼 시도가 빠진 주소
        return None, t[0]
    return sido, None


def is_night(f):
    h = f.get('h') or {}
    return any(isinstance(h.get(d), list) and mins(h[d][1]) >= 1200 for d in DAYS[:5])


def has(f, d):
    return isinstance((f.get('h') or {}).get(d), list)


def hours_line(f):
    """같은 시간이 이어지는 요일은 묶는다: 월–금 09:00–18:00 · 토 09:00–13:00"""
    h = f.get('h')
    if not h:
        return ''
    runs = []   # [시작요일, 끝요일, 시간]
    for d in DAYS:
        v = h.get(d)
        v = tuple(v) if isinstance(v, list) else None
        if v and runs and runs[-1][2] == v and DAYS.index(runs[-1][1]) == DAYS.index(d) - 1:
            runs[-1][1] = d
        elif v:
            runs.append([d, d, v])
    def lab(a, b):
        if a == 'mon' and b == 'fri':
            return '평일'
        return DAYKO[a] if a == b else DAYKO[a] + ('·' if DAYS.index(b) - DAYS.index(a) == 1 else '–') + DAYKO[b]
    s = ' · '.join('%s %s–%s' % (lab(a, b), v[0], v[1]) for a, b, v in runs)
    return s.replace('00:00–24:00', '24시간')


def short_addr(a):
    a = re.sub(r'\(.*?\)', '', str(a or '')).split(',')[0].strip()
    return re.sub(r'\s+', ' ', a)


def tel_digits(t):
    return re.sub(r'[^0-9]', '', str(t or ''))


def section(f):
    if f.get('g'):
        return 'etc'
    if f['c'] == 'p' and f.get('cost') == '무료':
        return 'free'
    if f['c'] == 'm':
        return 'med'
    return 'talk'


def tags(f):
    out = []
    if f['c'] == 'p' and f.get('cost') == '무료':
        out.append('무료')
    if f.get('cost') == '바우처':
        out.append('마음투자 바우처')
    if has(f, 'sat'):
        out.append('토요일')
    if is_night(f):
        out.append('저녁 8시 이후')
    if has(f, 'sun'):
        out.append('일요일')
    return out


def item_html(f):
    tel = tel_digits(f.get('tel'))
    kakao = 'https://map.kakao.com/link/to/%s,%s,%s' % (quote(f['n']), f['lat'], f['lng'])
    hl = hours_line(f)
    old = f.get('d', '')[:4].isdigit() and int(f['d'][:4]) < int(TODAY[:4]) - 1
    tg = ''.join('<span class="tag">%s</span>' % e(x) for x in tags(f))
    kind = (GROUP[f['g']] + ' · ' if f.get('g') else '') + f.get('t', '')
    return ('<li><div class="it"><h3>%s</h3><p class="k">%s</p><p class="a">%s</p>%s%s%s</div>'
            '<div class="ac">%s<a class="map" href="%s" target="_blank" rel="noopener">길찾기</a></div></li>') % (
        e(f['n']), e(kind), e(short_addr(f['a'])),
        '<p class="h">%s</p>' % e(hl) if hl else '',
        '<p class="tags">%s</p>' % tg if tg else '',
        '<p class="old">%s년 자료라 옮겼을 수 있어요. 가기 전에 확인해 주세요.</p>' % f['d'][:4] if old else '',
        '<a class="call" href="tel:%s" aria-label="%s에 전화하기">%s</a>' % (tel, e(f['n']), e(f['tel'])) if tel else '',
        kakao)


def head(title, desc, url, extra=''):
    return '''<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>%s</title>
<meta name="description" content="%s">
<link rel="canonical" href="%s">
<meta name="theme-color" content="#F1F4EF">
<meta property="og:title" content="%s">
<meta property="og:description" content="%s">
<meta property="og:type" content="website">
<meta property="og:url" content="%s">
<meta property="og:site_name" content="마음쉼표">
<meta property="og:locale" content="ko_KR">
<meta property="og:image" content="%sassets/img/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="%sassets/img/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="%sassets/img/apple-touch-icon.png">
<link rel="manifest" href="%smanifest.webmanifest">
<link rel="stylesheet" href="%sassets/area.css?v=%s">
%s</head>
<body>
<header class="top"><a class="brand" href="%s">마음쉼표<span aria-hidden="true">,</span></a><a class="tomap" href="%s#map">지도에서 찾기</a></header>
<div class="crisis" role="note" aria-label="위기상담 전화"><span>지금 많이 힘들다면</span><a href="tel:109">109 자살예방</a><a href="tel:15770199">1577-0199 위기상담</a><span>24시간</span></div>
<main>
''' % (e(title), e(desc), url, e(title), e(desc), url, BASE, BASE, BASE, BASE, BASE, CSS_V, extra, BASE, BASE)


FOOT = '''</main>
<footer class="foot">
<p>목록은 가나다순이에요. 광고·후기·유료 노출은 없어요.</p>
<p>기관 정보: 건강보험심사평가원 병원정보서비스(2026), 국립정신건강센터 정신건강 관련기관 정보(2022), 전국민 마음투자 지원사업 제공기관 목록(2024), 전국건강증진센터표준데이터. 공공데이터라 실제와 다를 수 있으니 가기 전에 전화로 확인해 주세요.</p>
<p><a href="%s">마음쉼표 처음으로</a> · <a href="%sarea/">다른 지역 보기</a> · <a href="%s#ask">틀린 정보 알려 주기</a></p>
</footer>
<script>
(function(){var b=document.getElementById('share');if(!b)return;b.hidden=false;b.addEventListener('click',function(){
var d={title:document.title,text:b.getAttribute('data-text'),url:location.href.split('#')[0]};
function done(){b.textContent='링크를 복사했어요';}
function copy(){var t=d.text+' '+d.url;if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(t).then(done,legacy);else legacy();
function legacy(){var a=document.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();try{if(document.execCommand('copy'))done();}catch(e){}a.remove();}}
if(navigator.share)navigator.share(d).catch(function(err){if(err&&err.name!=='AbortError')copy();});else copy();});})();
</script>
</body>
</html>
''' % (BASE, BASE, BASE)


def ld(crumbs):
    return '<script type="application/ld+json">%s</script>\n' % json.dumps({
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        'itemListElement': [{'@type': 'ListItem', 'position': i + 1, 'name': n, 'item': u} for i, (n, u) in enumerate(crumbs)]
    }, ensure_ascii=False)


def sort_key(f):
    return re.sub(r'^\(.*?\)\s*|^[\s(（]*', '', f['n'])


def build():
    data = json.load(open(os.path.join(ROOT, 'data/facilities-fallback.json'), encoding='utf-8'))
    items = data['items']

    # 1) 지역 정하기. 시도가 빠진 주소는 같은 시군구 이름이 하나뿐이면 그 시도로, 아니면 가장 가까운 기관의 시도로.
    known, pend = [], []
    for f in items:
        s, g = area_of(f['a'])
        f['_s'], f['_g'] = s, g
        (known if s and g else pend).append(f)
    name2sido = defaultdict(set)
    for f in known:
        name2sido[f['_g']].add(f['_s'])
    for f in pend:
        if f['_g'] and len(name2sido.get(f['_g'], ())) == 1:
            f['_s'] = next(iter(name2sido[f['_g']]))
            continue
        near = min(known, key=lambda k: (k['lat'] - f['lat']) ** 2 + (k['lng'] - f['lng']) ** 2)
        if not f['_s']:
            f['_s'] = near['_s']
        if not f['_g'] or f['_g'] not in {k['_g'] for k in known if k['_s'] == f['_s']}:
            f['_g'] = near['_g'] if near['_s'] == f['_s'] else f['_g']
    areas = defaultdict(list)
    for f in items:
        if f['_s'] and f['_g']:
            areas[(f['_s'], f['_g'])].append(f)
    # 기본 목록(접힌 기관 제외)이 하나도 없는 지역은 만들지 않는다
    areas = {k: v for k, v in areas.items() if any(not f.get('g') for f in v)}

    def slug(k):
        return k[0] if k[0] == '세종' else '%s-%s' % k

    old_lastmod = {}
    sp = os.path.join(ROOT, 'sitemap.xml')
    if os.path.exists(sp):
        for loc, lm in re.findall(r'<loc>(.*?)</loc>\s*<lastmod>(.*?)</lastmod>', open(sp, encoding='utf-8').read()):
            old_lastmod[loc] = lm

    pages, written, area_list = {}, 0, []
    by_sido = defaultdict(list)
    for k in sorted(areas, key=lambda k: (ORDER.index(k[0]), k[1])):
        by_sido[k[0]].append(k)

    for k, fs in areas.items():
        s, g = k
        place = '세종시' if s == '세종' else '%s %s' % (s, g)
        url = BASE + 'area/' + quote(slug(k)) + '/'
        fs = sorted(fs, key=sort_key)
        sec = defaultdict(list)
        for f in fs:
            sec[section(f)].append(f)
        sec['free'].sort(key=lambda f: (FREE_FIRST.index(f['t']) if f['t'] in FREE_FIRST else 99, sort_key(f)))
        base = [f for f in fs if not f.get('g')]
        n_med, n_free, n_talk = len(sec['med']), len(sec['free']), len(sec['talk'])
        n_sat = sum(1 for f in base if has(f, 'sat'))
        n_night = sum(1 for f in base if is_night(f))
        center = (round(statistics.median(f['lat'] for f in base), 5), round(statistics.median(f['lng'] for f in base), 5))
        maplink = '%s?near=%s,%s&amp;label=%s#map' % (BASE, center[0], center[1], quote(place))

        title = '%s 정신건강의학과·정신건강복지센터·심리상담 찾기 · 마음쉼표' % place
        bits = []
        if n_med: bits.append('정신건강의학과 병원·의원 %d곳' % n_med)
        if n_free: bits.append('무료 정신건강복지센터·공공기관 %d곳' % n_free)
        if n_talk: bits.append('심리상담기관 %d곳' % n_talk)
        desc = '%s의 %s. 토요일 진료 %d곳, 저녁 8시 이후 진료 %d곳. 전화번호와 진료시간을 가입 없이 확인하세요.' % (place, ', '.join(bits), n_sat, n_night)

        crumbs = [('마음쉼표', BASE), ('지역별 찾기', BASE + 'area/'), (place, url)]
        out = [head(title, desc, url, ld(crumbs))]
        out.append('<nav class="crumb" aria-label="위치"><a href="%s">마음쉼표</a> › <a href="%sarea/">지역별</a> › <span>%s</span></nav>' % (BASE, BASE, e(place)))
        out.append('<h1>%s<br><small>정신건강의학과·상담기관</small></h1>' % e(place))
        out.append('<p class="lead">%s 근처에서 마음을 돌볼 수 있는 곳을 모았어요. 처음이라면 무료로 상담받을 수 있는 정신건강복지센터부터 연락해 봐도 괜찮아요.</p>' % e(place))
        stats = [('병원·의원', n_med), ('무료 상담', n_free), ('심리상담', n_talk), ('토요일', n_sat), ('저녁 8시 이후', n_night)]
        out.append('<ul class="sum">%s</ul>' % ''.join('<li><b>%d</b><span>%s</span></li>' % (n, l) for l, n in stats))
        out.append('<div class="cta"><a class="go" href="%s">지도에서 가까운 순서로 보기</a><button class="ghost" id="share" hidden data-text="%s 정신건강의학과·상담기관 목록이에요.">이 목록 보내기</button></div>' % (maplink, e(place)))
        out.append('<p class="meta">지금 여는 곳, 내 위치에서 가까운 곳은 지도에서 볼 수 있어요.</p>')

        for key, h2, note in [
            ('free', '무료로 상담받을 수 있는 곳', '정신건강복지센터는 지역 주민 누구나 무료로 상담받을 수 있는 공공기관이에요.'),
            ('med', '정신건강의학과 병원·의원', '진단과 약 처방을 할 수 있어요. 건강보험이 적용돼요.'),
            ('talk', '심리상담기관', '대화로 마음을 살피는 곳이에요. 진단·처방은 하지 않고, 대부분 건강보험이 적용되지 않아요.'),
        ]:
            if not sec[key]:
                continue
            out.append('<section><h2>%s <small>%d곳</small></h2><p class="note">%s</p><ul class="list">%s</ul></section>' % (
                h2, len(sec[key]), note, ''.join(item_html(f) for f in sec[key])))
        if sec['etc']:
            out.append('<details class="etc"><summary>그 밖의 기관 %d곳 (요양·재활 시설, 진료과목 확인이 필요한 곳 등)</summary><ul class="list">%s</ul></details>' % (
                len(sec['etc']), ''.join(item_html(f) for f in sec['etc'])))

        sib = [x for x in by_sido[s] if x != k]
        if sib:
            out.append('<nav class="sib" aria-label="%s 다른 지역"><h2>%s 다른 지역</h2><p>%s</p></nav>' % (
                e(FULL[s]), e(FULL[s]), ' '.join('<a href="%sarea/%s/"><b>%s</b></a>' % (BASE, quote(slug(x)), e(x[1])) for x in sib)))
        out.append('<p class="guide"><a href="%s#guide">병원이 처음이라 걱정된다면, 비용·기록·준비물 안내 보기 ›</a></p>' % BASE)
        out.append('<p class="guide"><a href="%s#check">내 마음 먼저 살펴보기 (우울·불안 자가검진, 무료) ›</a></p>' % BASE)
        out.append(FOOT)
        pages[url] = ('area/' + slug(k) + '/index.html', ''.join(out))
        area_list.append({'s': s, 'g': '세종시' if s == '세종' else g, 'p': slug(k), 'lat': center[0], 'lng': center[1], 'n': len(base)})

    # 2) 지역 목록 페이지
    url = BASE + 'area/'
    out = [head('지역별 정신건강의학과·정신건강복지센터·심리상담 찾기 · 마음쉼표',
                '전국 시·군·구별 정신건강의학과 병원·의원, 무료 정신건강복지센터, 심리상담기관 목록. 전화번호와 진료시간을 가입 없이 확인하세요.',
                url, ld([('마음쉼표', BASE), ('지역별 찾기', url)]))]
    out.append('<nav class="crumb" aria-label="위치"><a href="%s">마음쉼표</a> › <span>지역별</span></nav>' % BASE)
    out.append('<h1>지역별로 찾기</h1><p class="lead">사는 곳이나 다니는 곳을 골라 보세요. 내 위치에서 가까운 곳은 <a href="%s#map">지도</a>에서 볼 수 있어요.</p>' % BASE)
    for s in ORDER:
        if not by_sido[s]:
            continue
        out.append('<section class="sido"><h2>%s</h2><p>%s</p></section>' % (e(FULL[s]), ' '.join(
            '<a href="%sarea/%s/"><b>%s</b><small>%d곳</small></a>' % (BASE, quote(slug(k)), e('세종시' if s == '세종' else k[1]),
                                                                  sum(1 for f in areas[k] if not f.get('g'))) for k in by_sido[s])))
    out.append(FOOT)
    pages[url] = ('area/index.html', ''.join(out))

    # 3) 쓰기: 바뀐 것만. 사라진 지역 폴더는 지운다.
    keep = {os.path.dirname(p) for p, _ in pages.values()}
    if os.path.isdir(OUT):
        for d in os.listdir(OUT):
            full = os.path.join(OUT, d)
            if os.path.isdir(full) and 'area/' + d not in keep:
                shutil.rmtree(full)
    lastmod = {}
    for u, (p, body) in pages.items():
        fp = os.path.join(ROOT, p)
        same = os.path.exists(fp) and open(fp, encoding='utf-8').read() == body
        if not same:
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            open(fp, 'w', encoding='utf-8').write(body)
            written += 1
        lastmod[u] = old_lastmod.get(u, TODAY) if same else TODAY

    # 앱의 '시·군·구 고르기'용 목록 (시도 순서 → 이름순)
    area_list.sort(key=lambda a: (ORDER.index(a['s']), a['g']))
    aj = json.dumps({'areas': area_list}, ensure_ascii=False, separators=(',', ':'))
    ap = os.path.join(ROOT, 'data/areas.json')
    if not os.path.exists(ap) or open(ap, encoding='utf-8').read() != aj:
        open(ap, 'w', encoding='utf-8').write(aj)

    # 4) sitemap.xml
    urls = [(BASE, old_lastmod.get(BASE, TODAY))] + sorted(lastmod.items(), key=lambda x: (x[0] != url, x[0]))
    sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + ''.join(
        '  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n  </url>\n' % (e(u), lm) for u, lm in urls) + '</urlset>\n'
    if not os.path.exists(sp) or open(sp, encoding='utf-8').read() != sm:
        open(sp, 'w', encoding='utf-8').write(sm)
    print('지역 페이지 %d개 (새로 쓴 파일 %d개), sitemap URL %d개' % (len(pages) - 1, written, len(urls)))


if __name__ == '__main__':
    build()
