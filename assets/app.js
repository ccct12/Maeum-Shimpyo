/* 마음쉼표 · 화면 스크립트
 * - 기관 데이터: 구글 시트(Apps Script 웹 앱) → 실패하면 저장소의 공공데이터 사본
 * - 위치·자가검진 응답은 이 브라우저 밖으로 보내지 않는다(거리·점수 모두 여기서 계산)
 */
(function () {
'use strict';
var CFG = window.MAEUM_CONFIG || {};
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

var SIDO = [
  ['서울', 37.5663, 126.9779, '서울시청'], ['부산', 35.1798, 129.0750, '부산시청'], ['대구', 35.8714, 128.6014, '대구시청'],
  ['인천', 37.4563, 126.7052, '인천시청'], ['광주', 35.1601, 126.8514, '광주시청'], ['대전', 36.3504, 127.3845, '대전시청'],
  ['울산', 35.5384, 129.3114, '울산시청'], ['세종', 36.4800, 127.2890, '세종시청'], ['경기', 37.2752, 127.0095, '경기도청'],
  ['강원', 37.8813, 127.7298, '강원도청'], ['충북', 36.6357, 127.4917, '충북도청'], ['충남', 36.6588, 126.6728, '충남도청'],
  ['전북', 35.8203, 127.1088, '전북도청'], ['전남', 34.8161, 126.4629, '전남도청'], ['경북', 36.5760, 128.5056, '경북도청'],
  ['경남', 35.2383, 128.6924, '경남도청'], ['제주', 33.4890, 126.4983, '제주도청']
];

var state = {
  view: 'home', sel: null, q: '', shown: CFG.LIST_STEP || 30, kind: 'all',
  filters: { open: false, night: false, sat: false, free: false, more: false },
  origin: CFG.DEFAULT_ORIGIN || { lat: 37.5663, lng: 126.9779, label: '서울시청' }, mine: false,
  data: null, dataNote: '', loadErr: false, quiz: null, stats: null
};

/* ───────── 데이터 ───────── */
function getJSON(url, ms) {
  // cache:'no-cache'는 Apps Script 주소 이동과 겹치면 응답이 멈춰서 쓰지 않는다. 대신 시간 제한을 둔다.
  var ctl = window.AbortController ? new AbortController() : null;
  var timer = ctl && setTimeout(function () { ctl.abort(); }, ms || 12000);
  return fetch(url, ctl ? { signal: ctl.signal } : {})
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .finally(function () { if (timer) clearTimeout(timer); });
}
function useData(j) {
  state.data = (j.items || []).map(normalize).filter(function (f) { return f && isFinite(f.lat) && isFinite(f.lng); });
  state.dataNote = j.fallback ? '공공데이터 사본(' + j.asOf + ')' : '구글 시트 ' + String(j.asOf || '').slice(0, 10);
  setDistances();
  if (!j.fallback) setCount();   // 사본 숫자를 먼저 띄웠다가 최신 숫자로 바뀌면 혼란스러워서, 숫자는 최신본이 왔을 때만 쓴다
}
function setCount() {
  var c = $('cnt'); if (c && state.data && state.data.length) c.textContent = '정신건강의학과, 정신건강복지센터, 상담기관 ' + state.data.filter(function (f) { return !f.g; }).length.toLocaleString() + '곳';
}
// 저장소 사본을 먼저 보여 주고(빠름), 구글 시트 최신본이 오면 바꿔 끼운다.
function loadData(onReady) {
  var shown = false; state.pending = !!CFG.DATA_URL;
  var fb = getJSON(CFG.FALLBACK_URL, 15000).then(function (j) { if (!shown) { useData(j); shown = true; onReady(); } }).catch(function () {});
  if (!CFG.DATA_URL) return fb.then(function () { if (!shown) { state.loadErr = true; state.data = []; onReady(); } else { setCount(); onReady(); } });
  var stamp = new Date().toISOString().slice(0, 13);  // 한 시간 단위로만 새로 받기
  return getJSON(CFG.DATA_URL + (CFG.DATA_URL.indexOf('?') < 0 ? '?' : '&') + 'type=facilities&v=' + stamp, 20000)
    .then(function (j) {
      state.pending = false; var keep = state.sel; useData(j); shown = true; state.sel = keep && byId(keep) ? keep : null; onReady();
    })
    .catch(function () { state.pending = false; return fb.then(function () { if (!shown) { state.loadErr = true; state.data = []; onReady(); } else { setCount(); onReady(); } }); });
}

// 예전 Apps Script(한글 열 이름 그대로)로 배포돼 있어도 읽을 수 있게 맞춘다
var SRC_SHORT = { '건강보험심사평가원_병원정보서비스': '건강보험심사평가원', '전국건강증진센터표준데이터': '지자체 공공데이터',
  '국립정신건강센터_정신건강 관련기관 정보': '국립정신건강센터 정신건강 관련기관 정보', '전국민마음투자 바우처 제공기관 목록': '전국민 마음투자 지원사업 제공기관 목록' };
function srcLabel(f) { return SRC_SHORT[f.src] || f.src || ''; }
// 찾아가서 바로 상담받는 곳이 아닌 시설은 상세 화면에서 따로 알려 준다
var STAY = {
  '정신재활시설': '정신질환에서 회복 중인 분이 재활 프로그램을 이용하거나 함께 생활하는 곳이에요.',
  '정신요양시설': '만성 정신질환이 있는 분이 오래 머무르며 요양하는 시설이에요.'
};
function normalize(f) {
  if (!f || f.id) return f;
  if (f['노출'] !== undefined && String(f['노출']).toUpperCase() !== 'TRUE') return null;
  return { id: f['기관ID'], c: f['부류'] === '의료' ? 'm' : 'p', t: f['기관구분'], n: f['기관명'], a: f['도로명주소'],
    lat: parseFloat(f['위도']), lng: parseFloat(f['경도']), tel: f['전화'] || '', web: f['홈페이지'] || '', cost: f['비용구분'] || '',
    src: SRC_SHORT[f['출처']] || f['출처'] || '', d: String(f['데이터기준일'] || '').slice(0, 10) };
}

/* ───────── 시간·상태 (한국 시간) ───────── */
var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var DAYKO = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' };
// 관공서 공휴일 (인사혁신처·우주항공청 월력요항 기준). 해마다 추가한다.
var HOLIDAYS = {
  '2026-01-01':1,'2026-02-16':1,'2026-02-17':1,'2026-02-18':1,'2026-03-01':1,'2026-03-02':1,'2026-05-01':1,'2026-05-05':1,
  '2026-05-24':1,'2026-05-25':1,'2026-06-03':1,'2026-06-06':1,'2026-07-17':1,'2026-08-15':1,'2026-08-17':1,'2026-09-24':1,
  '2026-09-25':1,'2026-09-26':1,'2026-10-03':1,'2026-10-05':1,'2026-10-09':1,'2026-12-25':1,
  '2027-01-01':1,'2027-02-06':1,'2027-02-07':1,'2027-02-08':1,'2027-02-09':1,'2027-03-01':1,'2027-05-01':1,'2027-05-03':1,
  '2027-05-05':1,'2027-05-13':1,'2027-06-06':1,'2027-07-17':1,'2027-07-19':1,'2027-08-15':1,'2027-08-16':1,'2027-09-14':1,
  '2027-09-15':1,'2027-09-16':1,'2027-10-03':1,'2027-10-04':1,'2027-10-09':1,'2027-10-11':1,'2027-12-25':1,'2027-12-27':1
};
function todayKST() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function mins(s) { return +s.slice(0, 2) * 60 + +s.slice(3, 5); }
function now() { var k = new Date(Date.now() + 9 * 3600e3); return [k.getUTCDay(), k.getUTCHours() * 60 + k.getUTCMinutes()]; }
function status(f, n) {
  if (!f.h) return { k: 'unknown', t: '운영시간 정보 없음' };
  var d = DAYS[n[0]], h = f.h[d], t = n[1], word = f.c === 'p' ? '운영' : '진료';
  if (HOLIDAYS[todayKST()]) return f.h.holOff ? { k: 'off', t: '오늘은 공휴일 휴무' } : { k: 'holiday', t: '공휴일이라 운영 여부를 전화로 확인해 주세요' };
  if (h === '?') return { k: 'unknown', t: '오늘 운영시간은 전화로 확인해 주세요' };
  if (!h) return { k: 'off', t: '오늘 쉬는 날' };
  if (h[0] === '00:00' && h[1] === '24:00') return { k: 'open', t: '24시간 ' + word };
  if (t < mins(h[0])) return { k: 'before', t: word + ' 전 · ' + h[0] + ' 시작' };
  if (t >= mins(h[1])) return { k: 'closed', t: '오늘 ' + word + ' 끝' };
  var l = d === 'sat' ? f.h.lunchSat : (d === 'sun' ? null : f.h.lunch);
  if (l && t >= mins(l[0]) && t < mins(l[1])) return { k: 'lunch', t: '점심시간 · ' + l[1] + ' 다시 시작' };
  var left = mins(h[1]) - t;
  if (left <= 30) return { k: 'soon', t: '곧 ' + word + ' 끝나요 · ' + h[1] + '까지' };
  return { k: 'open', t: word + ' 중 · ' + h[1] + '까지' };
}
function isNight(f) { return !!f.h && ['mon', 'tue', 'wed', 'thu', 'fri'].some(function (d) { var h = f.h[d]; return Array.isArray(h) && mins(h[1]) >= 1200; }); }
function isFree(f) { return f.c === 'p' && f.cost === '무료'; }

/* ───────── 거리 ───────── */
function hav(a, b, c, d) {
  var R = 6371000, r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2);
  return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
}
function setDistances() { (state.data || []).forEach(function (f) { f._d = hav(state.origin.lat, state.origin.lng, f.lat, f.lng); }); }
function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + 'm' : m < 100000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m / 1000) + 'km'; }
/* 기본 목록은 정신건강의학과 진료·상담·보건소. 아래 그룹은 '그 밖의 기관도 보기'를 켰을 때만 보인다. */
var GROUP = { care: '요양·재활·생활시설', gen: '일반 병의원·보건기관', unk: '진료과목 확인 필요' };
var GROUP_NOTE = {
  care: '오래 머물며 돌봄이나 재활을 받는 곳이에요.',
  gen: '정신건강의학과 진료가 따로 있는지 확인되지 않은 곳이에요. 가기 전에 전화로 정신과 진료가 있는지 물어봐 주세요.',
  unk: '이름만으로는 정신건강의학과 진료 여부를 알 수 없는 곳이에요. 가기 전에 전화로 정신과 진료가 있는지 물어봐 주세요.'
};
function kindLabel(f) { return (f.g ? GROUP[f.g] + ' · ' : '') + kindLabel0(f); }
function kindLabel0(f) { return f.c === 'p' ? f.t + (isFree(f) ? ', 무료' : f.cost === '바우처' ? ', 마음투자 바우처' : '') : f.t; }

function visible() {
  var n = now(), F = state.filters, q = state.q.replace(/\s/g, '');
  return (state.data || []).filter(function (f) {
    if (!F.more && f.g) return false;
    if (q && (f.n + String(f.a || '')).replace(/\s/g, '').indexOf(q) < 0) return false;
    if (F.open) { var sk = status(f, n).k; if (sk !== 'open' && sk !== 'soon') return false; }
    if (F.night && !isNight(f)) return false;
    if (F.sat && !(f.h && Array.isArray(f.h.sat))) return false;
    if (state.kind === 'm' && f.c !== 'm') return false;
    if (state.kind === 'p' && f.c !== 'p') return false;
    if (F.free && !isFree(f)) return false;
    return true;
  }).sort(function (a, b) { return a._d - b._d; });
}

/* ───────── 카카오맵 ───────── */
var K = { map: null, pins: [], me: null, failed: false };
function loadKakao() {
  if (!CFG.KAKAO_JS_KEY) { mapMsg('지도 키가 아직 설정되지 않았어요. 목록은 그대로 쓸 수 있어요.'); return; }
  var s = document.createElement('script');
  s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&appkey=' + encodeURIComponent(CFG.KAKAO_JS_KEY);
  s.onload = function () { try { window.kakao.maps.load(initMap); } catch (e) { mapMsg(); } };
  s.onerror = function () { mapMsg('지도를 불러오지 못했어요. 목록은 그대로 쓸 수 있어요.'); };
  document.head.appendChild(s);
}
function mapMsg() { K.failed = true; $('v-map').classList.add('nomap'); }
// 지도는 화면에 보일 때 만든다. 숨겨진 상태(크기 0)에서 만들면 범위 계산이 틀어져 전국 지도나 빈 화면이 뜬다.
function mapVisible() { var el = $('kmap'); return el.offsetWidth > 50 && el.offsetHeight > 50; }
function initMap() { K.ready = true; if (mapVisible()) createMap(); }
function createMap() {
  var km = window.kakao.maps;
  K.map = new km.Map($('kmap'), { center: new km.LatLng(state.origin.lat, state.origin.lng), level: 5 });
  if (!isMobile()) K.map.addControl(new km.ZoomControl(), km.ControlPosition.RIGHT);   // 모바일은 두 손가락으로 확대 (구석 목록과 겹치지 않게)
  $('kmap').removeAttribute('aria-hidden');
  km.event.addListener(K.map, 'dragend', function () { $('research').hidden = false; });
  drawMap(true);
}
function drawMap(fit) {
  if (!K.map) {
    if (K.ready && mapVisible()) return createMap();
    if (fit) K.needFit = true;
    return;
  }
  var km = window.kakao.maps, n = now();
  var list = visible().slice(0, state.shown);
  K.pins.forEach(function (o) { o.setMap(null); });
  K.pins = []; K.pinEl = {};
  list.forEach(function (f, i) {
    var sel = state.sel === f.id, b = document.createElement('button');
    var big = i < 10 || sel;                 // 가까운 10곳만 번호 핀, 나머지는 작은 점(겹침 방지)
    b.className = 'pin ' + f.c + (sel ? ' sel' : '') + (big ? '' : ' dot');
    b.setAttribute('aria-label', (i + 1) + '번 ' + f.n);
    b.innerHTML = (big ? '<span class="pn">' + (i + 1) + '</span>' : '<span class="pn"></span>') + (sel ? '<span class="pl">' + esc(f.n) + '</span>' : '');
    b.onclick = function () { var cur = MOB.list[MOB.focus]; if (isMobile() && !state.sel && (!cur || cur.id !== f.id) && mobFocusId(f.id)) return; select(f.id); };
    K.pinEl[f.id] = b;
    var o = new km.CustomOverlay({ position: new km.LatLng(f.lat, f.lng), content: b, xAnchor: 0.5, yAnchor: big ? 1 : 0.5, zIndex: sel ? 50 : big ? 20 + (list.length - i) : 5, clickable: true });
    o.setMap(K.map); K.pins.push(o);
  });
  if (isMobile() && !state.sel) focusPin(MOB.focus, false);
  if (K.me) K.me.setMap(null);
  var me = document.createElement('div'); me.className = 'me'; me.title = state.origin.label;
  K.me = new km.CustomOverlay({ position: new km.LatLng(state.origin.lat, state.origin.lng), content: me, zIndex: 4 });
  K.me.setMap(K.map);
  if (fit || K.needFit) {
    if (!mapVisible()) { K.needFit = true; return; }
    K.needFit = false;
    // 가까운 곳 위주로 화면을 맞춘다: 가까운 3곳은 항상, 나머지는 15km 안쪽만
    var pts = list.slice(0, 8).filter(function (f, i) { return i < 3 || f._d < 15000; });
    if (!pts.length) { K.map.setCenter(new km.LatLng(state.origin.lat, state.origin.lng)); K.map.setLevel(6); return; }
    var bd = new km.LatLngBounds();
    bd.extend(new km.LatLng(state.origin.lat, state.origin.lng));
    pts.forEach(function (f) { bd.extend(new km.LatLng(f.lat, f.lng)); });
    K.map.setBounds(bd, 48, 48, 48, 48);
  }
}
function relayout() { if (K.map) { K.map.relayout(); } }

/* ───────── 모바일 지도: 지도 전체 화면 + 아래 목록 (카드 / 원형 시제품) ─────────
 * 지도는 화면 전체, 기관은 아래 '카드'를 옆으로 넘겨서 고른다. (2026-11-18 원형 시제품과 비교 후 카드로 확정)
 * 고른 기관은 지도 핀이 커지고 지도가 따라간다. 목록·조건·상세는 아래에서 올라오는 시트로 연다. */
var MOB = { focus: 0, list: [] };
function isMobile() { return window.matchMedia('(max-width:899px)').matches; }
function setSheet(open) {
  $('v-map').classList.toggle('sheet', !!open);
  var s = $('sheetclose'); if (s) s.hidden = !open;
}
function openSheet() { if (!$('v-map').classList.contains('sheet')) { navPush({ sheet: 1 }); setSheet(true); $('panel').scrollTop = 0; } }
function closeSheet() { var h = history.state || {}; if (h.sheet || h.sel) history.back(); else { state.sel = null; setSheet(false); renderPanel(); drawMap(false); } }
function mobListData() { return visible().slice(0, 30); }
function renderMob() {
  if (!isMobile() || !state.data) return;
  var list = mobListData(), keepId = MOB.list[MOB.focus] && MOB.list[MOB.focus].id;
  MOB.list = list;
  var i = keepId ? list.map(function (f) { return f.id; }).indexOf(keepId) : -1;
  MOB.focus = i >= 0 ? i : 0;
  renderMchips(); renderStrip();
}
function mobItemHTML(f, i) {
  var s = status(f, now());
  return '<i class="mark ' + f.c + '" aria-hidden="true">' + (i + 1) + '</i><b>' + esc(f.n) + '</b>' +
    '<small>' + esc(kindLabel(f)) + ' · ' + fmtDist(f._d) + '</small>' + (s.k === 'unknown' ? '' : '<span class="st s-' + s.k + '">' + esc(s.t) + '</span>');
}
/* 지도 위 조건 칩: 시트를 열지 않아도 바로 고를 수 있게 */
function renderMchips() {
  // 7개 모두 짧은 이름, 같은 너비로 한 줄에 (자세한 이름은 화면 읽기용 이름에)
  var F = state.filters, k = state.kind;
  var C = [['kind', 'm', '병원', '병원·의원만'], ['kind', 'p', '상담', '상담·지원기관만'], ['f', 'free', '무료', '무료 기관만'], ['f', 'open', '운영중', '지금 여는 곳'],
    ['f', 'night', '20시', '저녁 8시 이후에도 여는 곳'], ['f', 'sat', '토요일', '토요일에 여는 곳'], ['f', 'more', '외 기관', '요양·재활 등 그 밖의 기관도 보기']];
  $('mchips').innerHTML = C.map(function (c) {
    var on = c[0] === 'kind' ? k === c[1] : !!F[c[1]];
    return '<button class="mchip' + (c[0] === 'kind' ? ' k' + c[1] : '') + '" ' + (c[0] === 'kind' ? 'data-kind="' + (on ? 'all' : c[1]) + '"' : 'data-f="' + c[1] + '"') +
      ' aria-pressed="' + on + '" aria-label="' + c[3] + '">' + c[2] + '</button>';
  }).join('');
}
/* 시트는 아래로 끌어내리면 닫힌다 (맨 위까지 스크롤된 상태에서만) */
(function () {
  var y0 = 0, dy = 0, on = false;
  document.addEventListener('touchstart', function (e) {
    var p = e.target.closest && e.target.closest('#v-map.sheet #panel');
    on = !!p && isMobile() && p.scrollTop <= 0; dy = 0; if (on) y0 = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!on) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { $('panel').style.transform = ''; return; }
    e.preventDefault();
    var p = $('panel'); p.style.transition = 'none'; p.style.transform = 'translateY(' + dy + 'px)';
  }, { passive: false });
  document.addEventListener('touchend', function () {
    if (!on) return; on = false;
    var p = $('panel'); p.style.transition = ''; p.style.transform = '';
    if (dy > 90) closeSheet();
  });
})();
/* 카드: 가로로 넘기는 띠 */
function renderStrip() {
  var el = $('mstrip'), list = MOB.list;
  el.innerHTML = list.length ? list.map(function (f, i) { return '<button class="mcard" data-mi="' + i + '" aria-label="' + (i + 1) + '번 ' + esc(f.n) + ', 자세히 보기">' + mobItemHTML(f, i) + '</button>'; }).join('') +
      '<button class="mcard more" id="mlist">목록 전체 보기<small>조건 고르기 · ' + visible().length.toLocaleString() + '곳</small></button>'
    : '<div class="mcard none"><b>이 조건에 맞는 곳이 없어요</b><small>목록에서 조건을 하나 풀어 보세요</small></div>';
  focusPin(MOB.focus, false);
}
var stripT;
document.addEventListener('scroll', function (e) {
  if (e.target.id !== 'mstrip') return;
  clearTimeout(stripT);
  stripT = setTimeout(function () {
    var el = $('mstrip'), mid = el.scrollLeft + el.clientWidth / 2, best = 0, bd = 1e9;
    el.querySelectorAll('.mcard[data-mi]').forEach(function (c) { var d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = +c.dataset.mi; } });
    if (best !== MOB.focus) { MOB.focus = best; focusPin(best, true); }
  }, 90);
}, true);
/* 고른 기관의 핀을 키우고 지도를 그쪽으로 */
function focusPin(i, pan) {
  var f = MOB.list[i];
  Object.keys(K.pinEl || {}).forEach(function (id) { K.pinEl[id].classList.toggle('focus', !!f && id === f.id); });
  if (f && pan && K.map) K.map.panTo(new window.kakao.maps.LatLng(f.lat, f.lng));
}
function mobFocusId(id) {   // 지도 핀을 누르면: 카드/원형을 그 기관으로 돌린다
  var i = MOB.list.map(function (f) { return f.id; }).indexOf(id); if (i < 0) return false;
  MOB.focus = i;
  var c = $('mstrip').querySelector('[data-mi="' + i + '"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); focusPin(i, true);
  return true;
}

/* ───────── 지도 화면 패널 ───────── */
function select(id) {
  if (state.sel !== id) navPush({ sel: id, sheet: (history.state || {}).sheet });
  state.sel = id;
  if (isMobile()) setSheet(true);
  renderPanel();
  var f = byId(id);
  if (K.map && f) { K.map.panTo(new window.kakao.maps.LatLng(f.lat, f.lng)); drawMap(false); }
}
function byId(id) { return (state.data || []).filter(function (f) { return f.id === id; })[0]; }

function renderPanel() {
  var p = $('panel');
  if (!state.data) { p.innerHTML = '<p class="empty">기관 정보를 불러오는 중이에요…</p>'; return; }
  var n = now(), f = state.sel && byId(state.sel);
  if (f) { p.innerHTML = detailHTML(f, n); p.scrollTop = 0; var b = $('back'); if (b) b.focus(); return; }
  renderMob();

  var list = visible(), F = state.filters;
  var seg = [['all', '전체'], ['m', '병원·의원'], ['p', '상담·지원']].map(function (c) {
    return '<button data-kind="' + c[0] + '" aria-pressed="' + (state.kind === c[0]) + '">' + c[1] + '</button>';
  }).join('');
  var chips = [['free', '무료만'], ['open', '지금 여는 곳'], ['night', '저녁 8시 이후'], ['sat', '토요일'], ['more', '그 밖의 기관도 보기']].map(function (c) {
    return '<button class="chip" data-f="' + c[0] + '" aria-pressed="' + F[c[0]] + '">' + c[1] + '</button>';
  }).join('');
  var opts = '<option value="">지역 고르기</option>' + SIDO.map(function (s, i) { return '<option value="' + i + '"' + (state.sido === i ? ' selected' : '') + '>' + s[0] + '</option>'; }).join('');
  var cards = list.slice(0, state.shown).map(function (f, i) {
    var s = status(f, n);
    return '<li><button class="row" data-id="' + esc(f.id) + '"><span class="rn"><i class="mark ' + f.c + '" aria-hidden="true">' + (i + 1) + '</i>' + esc(f.n) + '</span><span class="rd">' + fmtDist(f._d) + '</span>' +
      '<span class="rs">' + esc(kindLabel(f)) + ', ' + esc(shortAddr(f.a)) + '</span>' +
      (s.k === 'unknown' ? '' : '<span class="st s-' + s.k + '">' + esc(s.t) + '</span>') + '</button></li>';
  }).join('');
  var timeOn = F.open || F.night || F.sat || F.free, hint = '';
  var hidden = F.more ? 0 : (state.data || []).filter(function (f) { return f.g; }).length;
  if (!list.length) {
    hint = timeOn
      ? '이 조건에 맞는 곳을 찾지 못했어요. 운영시간 정보가 없는 곳은 시간 조건에서 빠지고, 무료만은 공공기관만 보여줘요. 조건을 하나 풀어 보세요. 급하면 위의 109로 전화해도 괜찮아요.'
      : '찾는 곳이 없어요. 이름을 다르게 적어 보거나 다른 지역을 골라 보세요.';
  }
  p.innerHTML = (isMobile() ? '<div class="sheethead"><span class="grab" aria-hidden="true"></span><button class="textbtn" id="sheetclose">지도로 돌아가기</button></div>' : '') +
    '<p class="here"><b>' + esc(state.origin.label) + '</b>에서 가까운 순서예요' + (!state.mine && state.sido == null && state.origin.label !== '지도 가운데' && !IN_KAKAO ? '<small> · 내 위치를 쓰거나 지역을 고르면 바뀌어요</small>' : '') + '</p>' +
    '<div class="where"><button class="btn solid" id="locate">내 위치에서 찾기</button><select id="sido" aria-label="지역 고르기">' + opts + '</select></div>' +
    (state.locMsg ? '<p class="note locmsg">' + esc(state.locMsg) + (IN_KAKAO ? ' ' + externalLink() : '') + '</p>'
      : IN_KAKAO && !state.mine ? '<p class="meta">카카오톡 안에서는 내 위치가 잡히지 않을 수 있어요. 지금은 ' + esc(state.origin.label) + ' 기준이에요. ' + externalLink() + '</p>'
      : '') +
    '<div class="seg" role="group" aria-label="기관 종류">' + seg + '</div>' +
    '<input class="search" id="q" type="search" placeholder="기관 이름이나 동네로 찾기 (예: 역삼동)" value="' + esc(state.q) + '" aria-label="기관 이름이나 동네로 찾기">' +
    '<div class="filters" role="group" aria-label="조건">' + chips + '</div>' +
    '<p class="meta">' + (state.loadErr ? '기관 정보를 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.' :
      (F.open || F.night || F.sat ? '운영시간 정보가 있는 ' + (state.data || []).filter(function (f) { return f.h; }).length.toLocaleString() + '곳 중 ' : '') + list.length.toLocaleString() + '곳' + (state.pending ? ' · 최신 정보 확인 중…' : '')) + '</p>' +
    (hidden ? '<p class="meta">요양·재활 시설 등 ' + hidden.toLocaleString() + '곳은 접어 뒀어요. 위 \'그 밖의 기관도 보기\'로 볼 수 있어요.</p>' : '') +
    (list.length ? '<ul class="list">' + cards + '</ul>' : '<div class="empty withart">' + EMPTY_ART + '<p>' + hint + '</p></div>') +
    (list.length > state.shown ? '<button class="btn more" id="more">' + Math.min(CFG.LIST_STEP || 30, list.length - state.shown) + '곳 더 보기</button>' : '') +
    (hasSupport() ? '<button class="textbtn" data-go="support">상담 비용이 걱정된다면, 마음 지원 제도 보기 ›</button>' : '') +
    '<p class="caution">공공데이터라 실제와 다를 수 있어요. 가기 전에 전화로 확인해 주세요.</p>' +
    '<button class="textbtn" data-go="guide">병원이 처음이라 걱정된다면 ›</button>' +
    footHTML();
}
var EMPTY_ART = '<svg class="emptyart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" aria-hidden="true"> <circle cx="100" cy="76" r="56" fill="currentColor" fill-opacity="0.06"/> <circle cx="126" cy="52" r="20" fill="#E59A5A" fill-opacity="0.22"/> <circle cx="126" cy="52" r="10" fill="#E59A5A" fill-opacity="0.52"/> <path d="M44 114 C74 96, 126 96, 156 114" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/> <path d="M100 100 C100 82, 100 70, 100 58" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/> <path d="M100 78 C84 77, 74 66, 76 54 C89 54, 99 63, 100 78 Z" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/> <path d="M100 68 C115 66, 125 56, 123 44 C110 45, 101 54, 100 68 Z" fill="currentColor" fill-opacity="0.26" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/> <circle cx="144" cy="116" r="3" fill="#E59A5A" fill-opacity="0.8"/> </svg>';
function shortAddr(a) { var t = String(a || '').split(',')[0].replace(/\(.*?\)/g, '').trim().split(/\s+/); return t.slice(1, 5).join(' '); }
function footHTML() {
  return '<div class="foot"><span>목록은 거리순으로만 보여줘요. 광고·후기·유료 노출은 없어요.</span>' +
    '<span>기관 정보: 건강보험심사평가원 병원정보서비스(2026), 전국건강증진센터표준데이터(각 지자체), 국립정신건강센터 정신건강 관련기관 정보(2022), 전국민 마음투자 지원사업 제공기관 목록(2024). 일부 좌표: TMAP. ' + esc(state.dataNote) + '</span>' +
    '<span>내 위치는 이 기기 안에서 거리 계산에만 쓰고, 어디에도 보내거나 저장하지 않아요. 방문 통계는 날짜·시간대별 횟수와 PC·모바일, 들어온 경로 종류(검색·카카오톡 등)만 세요.</span>' +
    '<button class="textbtn" data-go="ask">정보가 틀렸거나 바라는 점이 있다면 알려 주세요 ›</button></div>';
}
function detailHTML(f, n) {
  var s = status(f, n), rows = '';
  if (f.h) {
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].forEach(function (d) {
      var h = f.h[d], today = DAYS[n[0]] === d;
      rows += '<div' + (today ? ' class="today"' : '') + '><span>' + DAYKO[d] + '요일' + (today ? ' (오늘)' : '') + '</span><span>' + (h === '?' ? '정보 없음' : h ? h[0] + ' – ' + h[1] : '쉬는 날') + '</span></div>';
    });
    if (f.h.lunch) rows += '<div><span>평일 점심</span><span>' + f.h.lunch[0] + ' – ' + f.h.lunch[1] + '</span></div>';
    if (f.h.lunchSat) rows += '<div><span>토요일 점심</span><span>' + f.h.lunchSat[0] + ' – ' + f.h.lunchSat[1] + '</span></div>';
    if (f.h.holOff) rows += '<div><span>공휴일</span><span>쉬는 날</span></div>';
    if (f.h.note) rows += '<div><span>접수 안내</span><span>' + esc(f.h.note) + '</span></div>';
  } else rows = '<div><span>운영시간</span><span>아직 정보가 없어요. 전화로 확인해 주세요</span></div>';
  var tel = String(f.tel || '').replace(/[^0-9]/g, '');
  var kakao = 'https://map.kakao.com/link/to/' + encodeURIComponent(f.n) + ',' + f.lat + ',' + f.lng;
  var naver = 'https://map.naver.com/p/search/' + encodeURIComponent(f.n);
  var web = f.web ? (/^https?:\/\//.test(f.web) ? f.web : 'http://' + f.web) : '';
  var yr = +String(f.d || '').slice(0, 4), old = yr && yr < new Date().getFullYear() - 1 ? yr : 0;
  var fromList = (history.state || {}).sheet;
  return '<div class="detail"><button class="textbtn back" id="back">' + (isMobile() && !fromList ? '‹ 지도로' : '‹ 목록으로') + '</button>' +
    '<div><p class="kind">' + esc(kindLabel(f)) + ', ' + fmtDist(f._d) + '</p><h2>' + esc(f.n) + '</h2></div>' +
    (STAY[f.t] ? '<p class="note">' + STAY[f.t] + ' 처음 상담이 필요하다면 정신건강복지센터나 가까운 의원이 더 잘 맞을 수 있어요.</p>'
      : f.g ? '<p class="note">' + GROUP_NOTE[f.g] + (f.g === 'care' ? ' 처음 상담이 필요하다면 정신건강복지센터나 가까운 의원이 더 잘 맞을 수 있어요.' : '') + '</p>' : '') +
    (s.k === 'unknown' ? '' : '<span class="st s-' + s.k + '">' + esc(s.t) + '</span>') +
    '<div class="actions">' + (tel ? '<a class="call" href="tel:' + tel + '">전화하기 ' + esc(f.tel) + '</a>' : '') +
      '<div class="pair"><a href="' + kakao + '" target="_blank" rel="noopener">카카오맵 길찾기</a><a href="' + naver + '" target="_blank" rel="noopener">네이버지도에서 보기</a></div></div>' +
    (tel ? '<p class="note">전화가 부담스러우면 이렇게만 말해도 돼요. "처음인데요, 상담 예약하고 싶어요."</p>' : '') +
    '<div class="rows">' + rows + '</div>' +
    '<div class="rows"><div><span>주소</span><span>' + esc(f.a) + ' <button class="textbtn" id="copy" data-copy="' + esc(f.a) + '">복사</button></span></div>' +
      (web ? '<div><span>홈페이지</span><span><a href="' + esc(web) + '" target="_blank" rel="noopener nofollow">열기</a></span></div>' : '') +
      '<div><span>정보 출처</span><span>' + esc(srcLabel(f)) + (f.d ? ', ' + esc(f.d) + ' 기준' : '') + '</span></div></div>' +
    (old ? '<p class="note">' + old + '년 자료라 지금은 옮겼거나 운영하지 않을 수 있어요. 가기 전에 꼭 전화로 확인해 주세요.</p>' : '') +
    '<p class="caution">공공데이터 기준이라 실제와 다를 수 있어요. 첫 방문은 예약이 필요한 곳이 많으니 가기 전에 전화로 확인해 주세요.</p>' +
    '<button class="textbtn" data-go="guide">병원이 처음이라 걱정된다면 ›</button>' + reportHTML(f) + '</div>';
}

// 카카오톡 안 브라우저는 위치 권한을 막는 경우가 많아, 기본 브라우저로 여는 길을 함께 보여 준다
var IN_KAKAO = /KAKAOTALK/i.test(navigator.userAgent);
function externalLink() { return '<a class="textbtn" href="kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href.split('#')[0] + '#map') + '">다른 브라우저로 열기 ›</a>'; }
function locMsg(t) { state.locMsg = t; renderPanel(); }
function useMyLocation() {
  if (!navigator.geolocation) { locMsg('이 브라우저에서는 위치를 쓸 수 없어요. 지역을 골라 주세요.'); return; }
  var b = $('locate'); if (b) b.textContent = '위치 찾는 중…';
  navigator.geolocation.getCurrentPosition(function (pos) {
    state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: '내 위치' }; state.mine = true; state.sido = null; state.locMsg = '';
    afterOrigin();
  }, function () {
    locMsg(IN_KAKAO ? '카카오톡 안에서는 내 위치를 가져오지 못할 때가 많아요. 다른 브라우저로 열거나, 지역을 골라 주세요.'
      : '위치를 가져오지 못했어요. 브라우저의 위치 권한을 허용하거나, 지역을 골라 주세요.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}
function afterOrigin(fit) { $('research').hidden = true; state.sel = null; state.shown = CFG.LIST_STEP || 30; setDistances(); renderPanel(); drawMap(fit !== false); }

/* ───────── 자가검진 (PHQ-9 · GAD-7 공식 한국어판) ───────── */
// 문항·보기·질문 문장: PHQ-9, GAD-7 공식 한국어판(Korean for Korea) 원문 그대로.
// Pfizer Inc.로부터 교육용 지원금을 받아 Robert L. Spitzer 박사, Janet B.W. Williams 박사, Kurt Kroenke 박사와 동료들에 의해 개발. 복제·번역·전시·배포에 허가가 필요하지 않음.
var TESTS = {
  phq: { name: '우울 살펴보기', sub: 'PHQ-9 · 9문항 · 1~2분 소요',
    stem: '지난 2주일 동안 당신은 다음의 문제들로 인해서 얼마나 자주 방해를 받았습니까?',
    opt: ['전혀 방해 받지 않았다', '며칠 동안 방해 받았다', '7일 이상 방해 받았다', '거의 매일 방해 받았다'],
    q: ['일 또는 여가 활동을 하는 데 흥미나 즐거움을 느끼지 못함', '기분이 가라앉거나, 우울하거나, 희망이 없음', '잠이 들거나 계속 잠을 자는 것이 어려움, 또는 잠을 너무 많이 잠', '피곤하다고 느끼거나 기운이 거의 없음', '입맛이 없거나 과식을 함', '자신을 부정적으로 봄 - 혹은 자신이 실패자라고 느끼거나 자신 또는 가족을 실망시킴', '신문을 읽거나 텔레비전 보는 것과 같은 일에 집중하는 것이 어려움', '다른 사람들이 주목할 정도로 너무 느리게 움직이거나 말을 함. 또는 반대로 평상시보다 많이 움직여서, 너무 안절부절 못하거나 들떠 있음', '자신이 죽는 것이 더 낫다고 생각하거나 어떤 식으로든 자신을 해칠 것이라고 생각함'],
    bands: [[0, '우울 증상이 거의 없는 범위예요'], [5, '가벼운 우울 증상 범위예요'], [10, '중간 정도의 우울 증상 범위예요'], [15, '우울 증상이 꽤 있는 범위예요'], [20, '우울 증상이 많은 범위예요']] },
  gad: { name: '불안 살펴보기', sub: 'GAD-7 · 7문항 · 1분 소요',
    stem: '지난 2주 동안 당신은 다음의 문제들로 인해서 얼마나 자주 방해를 받았습니까?',
    opt: ['전혀 방해 받지 않았다', '며칠 동안 방해 받았다', '2주 중 절반 이상 방해 받았다', '거의 매일 방해 받았다'],
    q: ['초조하거나 불안하거나 조마조마하게 느낀다', '걱정하는 것을 멈추거나 조절할 수가 없다', '여러 가지 것들에 대해 걱정을 너무 많이 한다', '편하게 있기가 어렵다', '너무 안절부절못해서 가만히 있기가 힘들다', '쉽게 짜증이 나거나 쉽게 성을 내게 된다', '마치 끔찍한 일이 생길 것처럼 두렵게 느껴진다'],
    bands: [[0, '불안 증상이 거의 없는 범위예요'], [5, '가벼운 불안 증상 범위예요'], [10, '중간 정도의 불안 증상 범위예요'], [15, '불안 증상이 많은 범위예요']] }
};
var TEST_SRC = '문항 출처: PHQ-9·GAD-7 공식 한국어판 (Pfizer Inc.)';
/* 점수 구간표: 공개된 PHQ-9·GAD-7 구간 기준. 내 점수가 속한 줄만 굵게 */
function bandTable(t, score) {
  var max = t.q.length * 3, rows = t.bands.map(function (b, i) {
    var hi = i < t.bands.length - 1 ? t.bands[i + 1][0] - 1 : max, on = score >= b[0] && score <= hi;
    return '<tr' + (on ? ' class="on"' : '') + '><td>' + b[0] + '–' + hi + '점</td><td>' + b[1].replace(/ 범위예요$/, ' 범위') + (on ? ' (지금)' : '') + '</td></tr>';
  }).join('');
  return '<details class="tbl bands"><summary>점수 구간 기준 보기</summary><table><thead><tr><th scope="col">점수</th><th scope="col">구간</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<p class="meta">구간은 증상이 얼마나 자주 있었는지를 나눈 기준일 뿐, 병명을 뜻하지 않아요.</p></details>';
}
/* 병원·상담기관에 보여 줄 요약: 점수와 구간만 담는다. 문항별 답은 넣지 않는다. 저장하지 않고 복사만 한다 */
function sumHTML(t, score) {
  var d = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  var txt = '[자가검진 요약] ' + t.sub.split(' · ')[0] + ' ' + t.name + ' · ' + (t.q.length * 3) + '점 중 ' + score + '점 (' + band(t, score).replace(/ 범위예요$/, ' 범위') + ') · ' + d + ' · 진단이 아닌 참고용';
  return '<div class="sum"><button class="ghost" id="copysum" data-copy="' + esc(txt) + '">상담할 때 보여 줄 요약 복사하기</button>' +
    '<p class="meta">점수와 구간만 복사돼요. 어떤 문항에 어떻게 답했는지는 담기지 않고, 어디에도 저장되지 않아요.</p></div>';
}
function copyText(t, ok) {
  function legacy() { var a = document.createElement('textarea'); a.value = t; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select(); var r = false; try { r = document.execCommand('copy'); } catch (e) {} a.remove(); if (r) ok(); }
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(ok, legacy); else legacy();
}
function band(t, score) { var b = t.bands[0]; t.bands.forEach(function (x) { if (score >= x[0]) b = x; }); return b[1]; }
function renderCheck() {
  var el = $('checkbox'), z = state.quiz;
  if (!z) {
    el.innerHTML = '<h2>요즘 마음, 잠깐 살펴볼까요</h2><p class="lead">지난 2주를 떠올리며 답하면 돼요. 정답은 없어요. 무료이고 가입도 필요 없어요.</p>' +
      '<div class="pick">' + Object.keys(TESTS).map(function (k) { return '<button data-test="' + k + '"><b>' + TESTS[k].name + '</b><small>' + TESTS[k].sub + '</small><i aria-hidden="true">›</i></button>'; }).join('') + '</div>' +
      '<p class="note">답한 내용은 이 기기 밖으로 보내지 않고 저장하지도 않아요. 결과는 진단이 아니에요.</p>' +
      '<p class="caution">' + TEST_SRC + '</p>';
    return;
  }
  var t = TESTS[z.test];
  if (z.ans.length < t.q.length) {
    var i = z.ans.length;
    el.innerHTML = '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + t.q.length + '" aria-valuenow="' + i + '"><i style="width:' + (i / t.q.length * 100) + '%"></i></div>' +
      '<p class="lead">' + t.q.length + '개 중 ' + (i + 1) + '번째</p><p class="stem">' + t.stem + '</p><p class="q" id="qtext" tabindex="-1">' + t.q[i] + '</p>' +
      '<div class="opts fresh" id="opts">' + t.opt.map(function (o, v) { return '<button class="opt" data-ans="' + v + '">' + o + '</button>'; }).join('') + '</div>' +
      (z.test === 'phq' && i === 8 ? '<p class="note">답하기 버겁다면 잠시 멈춰도 괜찮아요. 지금 누군가와 이야기하고 싶다면 <a href="tel:109">109</a>에 전화할 수 있어요. 24시간 받아요.</p>' : '') +
      '<div class="qnav">' + (i ? '<button class="textbtn" id="prevq">‹ 이전 문항으로</button>' : '') + '<button class="textbtn" id="quit">그만두기</button></div>';
    var q = $('qtext'); if (q) q.focus();
    // 방금 누른 자리에 새 보기가 그려지면 마우스가 올라가 있는 것처럼 보이므로, 마우스를 움직이기 전까지는 강조하지 않는다
    var os = $('opts'); if (os) os.addEventListener('mousemove', function () { os.classList.remove('fresh'); }, { once: true });
    return;
  }
  var score = z.ans.reduce(function (a, b) { return a + b; }, 0), max = t.q.length * 3, risk = z.test === 'phq' && z.ans[8] > 0;
  var tier = risk || score >= 15 ? 3 : score >= 10 ? 2 : score >= 5 ? 1 : 0;
  var GUIDE = [
    { p: '지금 답한 내용으로는 증상이 많지 않아요. 그래도 힘들다고 느끼면 그 느낌이 먼저예요.',
      b: [['tobreath', '마음 쉬기', 'ghost'], ['tofacts', '나만 이런 걸까요? 숫자로 보기', 'ghost']] },
    { p: '가벼운 신호가 보여요. 잠, 끼니, 짧은 산책처럼 하루의 기본부터 챙겨 보세요. 이런 상태가 2주 넘게 이어지면 상담을 받아 보는 것도 좋은 방법이에요.',
      b: [['tofree', '무료 공공 상담기관 보기', 'primary'], ['tobreath', '마음 쉬기', 'ghost']] },
    { p: '전문가와 이야기해 보면 도움이 될 수 있는 신호예요. 정신건강복지센터에서는 비용 부담 없이 첫 상담을 받을 수 있고, 가까운 의원에 예약해도 돼요.',
      b: [['tomap', '가까운 기관 보기', 'primary'], ['tofree', '무료 공공 상담기관만 보기', 'ghost'], ['toguide', '병원이 처음이라 걱정된다면', 'ghost']] },
    { p: '혼자 감당하기에 무거운 상태일 수 있어요. 이번 주 안에 전문가와 이야기해 보길 권해요. 혼자 가기 어렵다면 가족이나 친구에게 같이 가 달라고 하거나, 전화 상담부터 시작해도 괜찮아요.',
      b: [['tomap', '가까운 기관 보기', 'primary'], ['tofree', '무료 공공 상담기관만 보기', 'ghost'], ['toguide', '병원이 처음이라 걱정된다면', 'ghost']] }
  ][tier];
  el.innerHTML = (tier === 3 ? '<div class="help"><p>' + (risk ? '스스로를 해치고 싶은 생각이 들었다고 답해 주셨어요. ' : '') + '혼자 견디지 않아도 돼요. 지금 전화하면 24시간 이야기할 수 있어요.</p><a href="tel:109">109 자살예방 상담전화</a><a href="tel:15770199">1577-0199 정신건강 위기상담</a></div>' : '') +
    '<div class="score"><strong>' + band(t, score) + '</strong><p>' + GUIDE.p + '</p>' +
    '<span class="num">' + t.name + ' · ' + max + '점 중 ' + score + '점. 점수는 상태를 판정하는 게 아니라, 도움을 요청해 볼 만한지 알려 주는 신호예요.</span></div>' +
    // 큰 버튼은 하나만, 나머지는 한 줄 링크로 (결과 화면에 버튼이 줄줄이 쌓이지 않게)
    '<button class="' + GUIDE.b[0][2] + '" id="' + GUIDE.b[0][0] + '">' + GUIDE.b[0][1] + '</button>' +
    '<div class="rlinks">' + GUIDE.b.slice(1).map(function (x) { return '<button class="textbtn" id="' + x[0] + '">' + x[1] + ' ›</button>'; }).join('') + '</div>' +
    supRecHTML(tier) +
    '<details class="rmore"><summary>점수 기준 · 상담할 때 보여 줄 요약</summary>' + bandTable(t, score) + sumHTML(t, score) + '</details>' +
    '<p class="note">이 결과는 진단이 아니에요. 정확한 상태는 전문가와 만나야 알 수 있어요.</p>' +
    '<button class="textbtn" id="again">다른 검진 해 보기</button>' +
    '<p class="caution">' + TEST_SRC + '</p>';
}

/* ───────── 마음 지원 제도 (복지로 공공데이터 · 시트에서 사람이 고른 것만) ─────────
 * 처음 오는 사람이 행정 문장에 지치지 않게: 조건 없이 바로 쓸 수 있는 곳 → 나라 지원 → 우리 지역 순서로,
 * 카드에는 이름과 한 줄만 두고 조건·신청 방법은 접어 둔다. */
// 특정 상황·대상을 위한 사업은 '이런 상황이라면'으로 따로 묶어, 처음 보는 사람에게 일반 지원이 먼저 보이게 한다
var SUP_SPECIAL = /노숙|보훈|산재|입양|위탁|발달장애|가정폭력|성폭력|여성긴급|북한|범죄|학대|디지털미디어|알코올/;
var SUP_FIRST = [/바우처/, /정신건강복지센터/, /자살예방/, /치료비/, /1388/, /청소년/, /가족/, /중독/];
function supOrder(a, b) {
  var r = function (x) { for (var i = 0; i < SUP_FIRST.length; i++) if (SUP_FIRST[i].test(x.n)) return i; return 99; };
  return r(a) - r(b) || String(a.n).localeCompare(String(b.n), 'ko');
}
var SUP_LIFE = [['all', '누구나'], ['아동|청소년', '아동·청소년'], ['청년', '청년'], ['중장년', '중장년'], ['노년', '어르신']];
// 무엇이 필요한지: 이름·요약·지원내용의 말로 나눈다 (한 사업이 여러 갈래에 들 수 있음)
var SUP_NEED = [['all', '전체'], ['talk', '상담받고 싶어요', /상담|심리|치유|마음/], ['cost', '치료비가 걱정돼요', /치료비|의료비|치료관리비|진료비|검진|바우처|본인부담/],
  ['phone', '전화·온라인으로', /전화|1388|1366|온라인/], ['family', '가족·보호자', /가족|부모|자녀|보호자|양육/], ['crisis', '위기·피해를 겪었어요', /자살|폭력|피해|학대|위기|노숙|중독|알코올|재난/]];
function supNeedOf(x) { var t = [x.n, x.s, x.ben].join(' '); return SUP_NEED.slice(1).filter(function (c) { return c[2].test(t); }).map(function (c) { return c[0]; }); }
function supDday(d) { return d == null ? '' : d <= 0 ? '오늘 마감' : 'D-' + d; }
function supDays(end) { var t = Date.parse(end + 'T23:59:59+09:00'); return isNaN(t) ? null : Math.ceil((t - Date.now()) / 864e5); }
function supPeriod(x) {
  if (x.end) {
    var d = supDays(x.end), soon = d != null && d <= 30;
    return '<p class="speriod' + (soon ? ' soon' : '') + '"><b class="dday">' + supDday(d) + '</b> ' + (x.start ? esc(x.start) + ' ~ ' : '') + esc(x.end) + '까지</p>';
  }
  if (x.start) return '<p class="speriod">' + esc(x.start) + '부터</p>';
  if (x.yr) return '<p class="speriod">' + esc(x.yr) + '년 기준 · 해마다 다시 열리는 사업이에요</p>';
  return '';
}
function loadSupport() {
  var use = function (j) { if (j && j.kind === 'support' && Array.isArray(j.items)) { state.support = j.items; supportReady(); return true; } return false; };
  var fb = getJSON(CFG.SUPPORT_FALLBACK_URL || 'data/support-fallback.json', 15000).then(use).catch(function () { return false; });
  if (!CFG.DATA_URL) return;
  getJSON(CFG.DATA_URL + (CFG.DATA_URL.indexOf('?') < 0 ? '?' : '&') + 'type=support&v=' + new Date().toISOString().slice(0, 13), 20000)
    .then(function (j) { if (!use(j)) return fb; }).catch(function () { return fb; });
}
function hasSupport() { return !!(state.support && state.support.length); }
// 데이터가 있을 때만 다른 화면에서 이 화면으로 오는 길을 보여 준다
function supportReady() {
  document.querySelectorAll('.supgate').forEach(function (el) { el.hidden = !hasSupport(); });
  if (state.view === 'support') renderSupport();
  if (state.view === 'map' && !state.sel) renderPanel();
  if (state.view === 'check' && state.quiz) renderCheck();
}
// 복지로 시도명 → 사이트 지역 이름 (2026년 전남·광주는 '전남광주통합특별시' 하나로 나온다)
function sidoKeys(n) {
  n = String(n || '');
  if (/전남광주|전라남도.*광주/.test(n)) return ['전남', '광주'];
  var M = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'],
    ['경기', '경기'], ['강원', '강원'], ['충청북|충북', '충북'], ['충청남|충남', '충남'], ['전라북|전북', '전북'], ['전라남|전남', '전남'],
    ['경상북|경북', '경북'], ['경상남|경남', '경남'], ['제주', '제주']];
  for (var i = 0; i < M.length; i++) if (new RegExp('^(' + M[i][0] + ')').test(n)) return [M[i][1]];
  return [];
}
function nearestSido() {
  if (state.sido != null) return SIDO[state.sido][0];
  var o = state.origin, best = 0, bd = 1e12;
  SIDO.forEach(function (s, i) { var d = hav(o.lat, o.lng, s[1], s[2]); if (d < bd) { bd = d; best = i; } });
  return SIDO[best][0];
}
function supText(t) { return esc(String(t || '').trim()).replace(/\n+/g, '<br>'); }
function supTel(t) {   // 문의처 문장 안의 전화번호에 바로 걸기 링크를 붙인다
  return supText(t).replace(/(\b0\d{1,2}-\d{3,4}-\d{4}\b|\b1\d{3}-\d{4}\b)/g, function (m) { return '<a href="tel:' + m.replace(/-/g, '') + '">' + m + '</a>'; });
}
function supShort(x, n) { var s = String(x.s || '').trim(); return s.length > n ? s.slice(0, n - 2).replace(/\s+\S*$/, '') + '…' : s; }
// 목록은 한 줄씩 접어 두고, 누르면 그 자리에서 펼친다 (글이 한꺼번에 쏟아지지 않게)
function supCard(x, open) {
  var tel = /^[\d-]{3,14}$/.test(String(x.tel || '').trim()) ? String(x.tel).trim() : '';
  var where = x.k === 'l' ? [x.sd, x.sg].filter(Boolean).join(' ') : '';
  var d = x.end ? supDays(x.end) : null, soon = d != null && d <= 30;
  var meta = [x.end ? '<span' + (soon ? ' class="soon"' : '') + '><b class="dday">' + supDday(d) + '</b> ' + esc(x.end.slice(5).replace('-', '.')) + '까지</span>' : '',
    x.on ? '<span>온라인 신청</span>' : '', where && x.k === 'l' ? '<span>' + esc(x.sg || x.sd) + '</span>' : ''].filter(Boolean).join('');
  var rows = [['누가 받을 수 있나요', x.tgt], ['무엇을 지원하나요', x.ben], ['어떻게 신청하나요', x.how]]
    .filter(function (r) { return r[1]; }).map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + supText(r[1]) + '</dd>'; }).join('') +
    (x.inq ? '<dt>문의</dt><dd>' + supTel(x.inq) + '</dd>' : '');
  return '<details class="srow" id="sup-' + esc(x.id) + '"' + (open ? ' open' : '') + '><summary>' +
      '<span class="sn">' + esc(x.n) + '</span><span class="ss">' + esc(supRecLine(x, 46)) + '</span>' + (meta ? '<span class="sm">' + meta + '</span>' : '') + '</summary>' +
    '<div class="sbody">' + supPeriod(x) + (x.s ? '<p>' + esc(String(x.s).trim()) + '</p>' : '') +
      (x.org || x.life ? '<p class="stags">' + [x.org, x.life ? '대상: ' + x.life.replace(/,\s*/g, ', ') : ''].filter(Boolean).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</p>' : '') +
      (rows ? '<dl>' + rows + '</dl>' : '') +
      (x.crit ? '<details class="sdet"><summary>선정 기준 자세히</summary><p>' + supText(x.crit) + '</p></details>' : '') +
      '<div class="sact">' + (tel ? '<a href="tel:' + tel.replace(/-/g, '') + '">문의 ' + esc(tel) + '</a>' : '') +
        (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">복지로에서 보기</a>' : '') + '</div>' +
      (x.mod ? '<p class="meta">복지로에서 확인한 날 ' + esc(x.mod) + '</p>' : '') + '</div></details>';
}
function supState() {
  var z = state.sup || (state.sup = { tab: 'n', life: 'all', need: 'all', online: false, area: null, focus: null });
  if (!z.area) z.area = nearestSido();
  return z;
}
function supFilter(list, z) {
  return list.filter(function (x) {
    if (z.life !== 'all' && x.life && !new RegExp(z.life).test(x.life)) return false;
    if (z.need !== 'all' && supNeedOf(x).indexOf(z.need) < 0) return false;
    if (z.online && !x.on) return false;
    return true;
  });
}
function renderSupport() {
  var el = $('supbox'), all = state.support || [], z = supState();
  var natAll = all.filter(function (x) { return x.k === 'n'; }).sort(supOrder);
  var locAll = all.filter(function (x) { return x.k === 'l' && sidoKeys(x.sd).indexOf(z.area) >= 0; });
  var list = supFilter(z.tab === 'n' ? natAll : locAll, z);
  var common = list.filter(function (x) { return z.tab === 'l' || !SUP_SPECIAL.test(x.n); }), special = z.tab === 'n' ? list.filter(function (x) { return SUP_SPECIAL.test(x.n); }) : [];
  var areas = SIDO.map(function (s) { return '<option' + (s[0] === z.area ? ' selected' : '') + '>' + s[0] + '</option>'; }).join('');
  var chips = function (arr, key, label) {
    return '<div class="sfrow"><span class="sflabel">' + label + '</span><div class="filters" role="group" aria-label="' + label + '">' +
      arr.map(function (c) { return '<button class="chip" data-sf="' + key + '" data-v="' + c[0] + '" aria-pressed="' + (z[key] === c[0]) + '">' + c[1] + '</button>'; }).join('') + '</div></div>';
  };
  var on = z.life !== 'all' || z.need !== 'all' || z.online;
  var card = function (x) { return supCard(x, z.focus === x.id); };
  el.innerHTML =
    '<h2>마음 지원 제도</h2>' +
    '<p class="lead">비용이 마음에 걸릴 때 기댈 수 있는 제도예요. 눌러서 펼쳐 보세요.</p>' +
    '<div class="snow"><button id="tofree"><b>정신건강복지센터</b><span>조건 없이 무료 상담</span></button><a href="tel:109"><b>109</b><span>24시간 상담전화</span></a></div>' +
    '<div class="seg stab" role="tablist" aria-label="지원 범위">' +
      '<button role="tab" data-stab="n" aria-selected="' + (z.tab === 'n') + '" aria-pressed="' + (z.tab === 'n') + '">나라 지원 <small>' + natAll.length + '</small></button>' +
      '<button role="tab" data-stab="l" aria-selected="' + (z.tab === 'l') + '" aria-pressed="' + (z.tab === 'l') + '">우리 지역 <small>' + locAll.length + '</small></button></div>' +
    (z.tab === 'l' ? '<label class="sarea">지역 <select id="suparea" aria-label="지역 고르기">' + areas + '</select></label>' : '') +
    '<details class="sfilter"' + (on || z.fopen ? ' open' : '') + '><summary>조건 골라 보기' + (on ? ' · 적용 중' : '') + '</summary>' +
      chips(SUP_NEED, 'need', '필요한 것') + chips(SUP_LIFE, 'life', '누구') +
      '<div class="sfrow"><span class="sflabel">신청</span><div class="filters"><button class="chip" data-sf="online" aria-pressed="' + z.online + '">온라인으로 신청할 수 있는 것만</button>' +
      (on ? '<button class="textbtn" id="sfreset">조건 지우기</button>' : '') + '</div></div></details>' +
    '<div class="slist" id="slist">' +
    (common.length ? common.map(card).join('')
      : '<p class="note">' + (z.tab === 'l' && !locAll.length ? esc(z.area) + '에서 따로 올라온 마음 지원 사업은 아직 찾지 못했어요. 나라 지원과 정신건강복지센터는 어느 지역에서나 이용할 수 있어요.'
        : '이 조건에 맞는 지원이 없어요. 조건을 하나 풀어 보세요.') + '</p>') +
    (special.length ? '<h3 class="ssub">이런 상황이라면</h3><p class="meta">특정한 일을 겪었거나 가족을 돌보는 분을 위한 지원이에요.</p>' + special.map(card).join('') : '') +
    '</div>' +
    '<p class="caution">출처: 복지로(한국사회보장정보원). 조건·일정은 바뀔 수 있어 신청 전에 문의처로 확인해 주세요.</p>' +
    '<div class="sbtns"><button class="ghost" id="tomap">가까운 기관 보기</button><button class="ghost" data-go="guide">병원이 처음이라 걱정된다면</button></div>';
  if (z.focus) { var f = $('sup-' + z.focus); z.focus = null; if (f) setTimeout(function () { f.scrollIntoView({ block: 'center', behavior: 'smooth' }); f.classList.add('hl'); }, 60); }
}
// 목록을 옆으로 밀면 나라 ↔ 지역이 바뀐다 (세로 스크롤과 헷갈리지 않게 가로로 충분히 밀었을 때만)
(function () {
  var sx = 0, sy = 0, on = false;
  document.addEventListener('touchstart', function (e) { var l = e.target.closest && e.target.closest('#slist'); on = !!l; if (on) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!on || !state.sup) return; on = false;
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    var t = dx < 0 ? 'l' : 'n'; if (t === state.sup.tab) return;
    state.sup.tab = t; renderSupport(); $('v-support').scrollTop = 0;
  }, { passive: true });
})();
/* 검진 점수에 맞춰 이어 볼 지원 (자격 판단이 아니라 '열어 볼 만한 것' 안내) */
var SUP_REC = [[], [/정신건강복지센터/, /바우처/], [/바우처/, /정신건강복지센터/, /치료비/], [/자살예방/, /바우처/, /치료비/]];
// 추천 칸에서는 행정 문장 대신 쉬운 한 줄을 쓴다
var SUP_REC_LINE = [[/정신건강복지센터/, '조건 없이 무료로 상담을 시작하고, 필요한 지원도 이어 줘요'], [/바우처/, '전문 심리상담을 바우처로 받을 수 있어요. 소득에 따라 본인부담이 달라요'],
  [/자살예방/, '죽고 싶은 마음이 들 때 상담과 위기 지원을 받을 수 있는 곳이에요'], [/치료비/, '정신건강의학과 치료비 부담을 덜어 주는 지원이에요']];
function supRecLine(x, n) { for (var i = 0; i < SUP_REC_LINE.length; i++) if (SUP_REC_LINE[i][0].test(x.n)) return SUP_REC_LINE[i][1]; return supShort(x, n || 60); }
function supRecHTML(tier) {
  if (!hasSupport() || !SUP_REC[tier] || !SUP_REC[tier].length) return '';
  var nat = state.support.filter(function (x) { return x.k === 'n'; }), pick = [];
  SUP_REC[tier].forEach(function (re) { var x = nat.filter(function (y) { return re.test(y.n) && pick.indexOf(y) < 0; })[0]; if (x) pick.push(x); });
  if (!pick.length) return '';
  return '<div class="srec"><h3>이어서 열어 볼 만한 지원</h3>' +
    pick.map(function (x) { return '<button class="srecb" data-supid="' + esc(x.id) + '"><b>' + esc(x.n) + '</b><small>' + esc(supRecLine(x)) + '</small><i aria-hidden="true">›</i></button>'; }).join('') +
    '<p class="meta">자가검진 점수만으로 신청 자격이 정해지지는 않아요. 바우처처럼 기관의 의뢰서가 필요한 지원도 있어서, 정신건강복지센터에 먼저 물어보면 길을 안내받을 수 있어요.</p>' +
    '<button class="textbtn" data-go="support">지원 제도 전체 보기 ›</button></div>';
}

/* ───────── 마음 통계 ───────── */
function man(v) { return (v / 10000).toFixed(v >= 1e6 ? 0 : 1).replace(/\.0$/, '') + '만'; }
function man1(v) { return (v / 10000).toFixed(1) + '만'; }
function renderFacts() {
  var el = $('factsbox'), S = state.stats;
  if (!S) { el.innerHTML = '<p class="empty">통계를 불러오는 중이에요…</p>'; return; }
  var T = S.trend, last = T.years.length - 1;
  var up = function (a) { return Math.round((a[last] / a[0] - 1) * 100); };
  var tile = function (x) { return '<div class="tile"><strong>' + esc(x.v) + '</strong><span class="l">' + esc(x.l) + '</span><span class="s">' + esc(x.s) + '</span><span class="src">' + esc(x.src) + '</span></div>'; };
  el.innerHTML =
    '<div class="fsec"><h2>우울과 불안은 생각보다 가까이 있어요</h2>' +
      '<p class="lead">누구에게나 찾아올 수 있을 만큼 흔하지만, 저절로 지나가길 기다리기보다 전문가와 함께 살펴보면 좋은 일이에요. 숫자로 먼저 살펴볼게요.</p></div>' +

    '<div class="fsec"><h2>우울·불안으로 병원을 찾는 사람이 11년 새 크게 늘었어요</h2>' +
      '<div class="fig" id="fig-trend"><h3>우울·불안 관련 진료 인원 (' + T.years[0] + '–' + T.years[last] + ')</h3>' +
        '<div class="lgd"><span><i style="background:var(--s1)"></i>기분장애(우울·조울) +' + up(T.mood) + '%</span><span><i style="background:var(--s2)"></i>불안·스트레스 관련 장애 +' + up(T.anx) + '%</span></div>' +
        '<svg class="chart" id="c-trend" role="img" aria-label="연도별 진료 인원 선 그래프"></svg><div class="tip" id="tip-trend"></div>' +
        '<p class="sub">' + esc(T.note) + '</p><p class="src">출처: ' + esc(T.src) + '</p>' +
        tableHTML(['연도', '기분장애', '불안·스트레스'], T.years.map(function (y, i) { return [y, T.mood[i].toLocaleString() + '명', T.anx[i].toLocaleString() + '명']; })) + '</div>' +
      '<div class="callout"><p>"마음의 감기"라는 말은 그만큼 흔하다는 뜻이에요. 며칠 쉬면 저절로 낫는다는 뜻은 아니에요. 일찍 상담하고 필요한 치료를 받는 게 도움이 돼요.</p></div></div>' +

    '<div class="fsec"><h2>성인 5명 중 1명은 일상에서 스트레스를 많이 느껴요</h2>' +
      '<div class="tiles">' + S.tiles.around.map(tile).join('') + '</div>' +
      '<details class="fmore" id="sidomore"><summary>우리 지역은 어떤지 보기 (시·도별)</summary><div class="fig" id="fig-sido"><h3>시·도별 우울증상 유병률 (2025)</h3><p class="sub">우울증 선별도구(PHQ-9) 10점 이상인 성인 비율</p>' +
        '<svg class="chart" id="c-sido" role="img" aria-label="시도별 우울증상 유병률 막대 그래프"></svg><div class="tip" id="tip-sido"></div>' +
        '<p class="sub">' + esc(S.sido.note) + '</p><p class="src">출처: ' + esc(S.sido.src) + '</p>' +
        tableHTML(S.sido.cols, S.sido.rows.slice().sort(function (a, b) { return b[1] - a[1]; })) + '</div></details></div>' +

    '<div class="fsec"><h2>많은 사람이 이미 도움을 청하고 있어요</h2>' +
      '<div class="tiles">' + S.tiles.help.map(tile).join('') + '</div>' +
      '<div class="callout"><p>지금 이야기할 곳이 필요하다면</p><div class="actions trio"><a href="tel:109">109 자살예방 상담전화</a><a href="tel:15770199">1577-0199 위기상담</a><a href="tel:1388">1388 청소년 상담</a></div></div></div>' +

    '<div class="fsec"><h2>도움을 받는 사람은 아직 많지 않아요</h2>' +
      '<div class="tiles">' + (S.tiles.svc ? tile(S.tiles.svc) : '') + tile(S.tiles.door) + '</div>' +
      '<p class="lead">혼자 버티는 사람이 그만큼 많다는 뜻이기도 해요. 가까운 무료 상담기관이 있는 줄 몰라서 못 가는 경우도 많아요.</p>' +
      '<p class="lead">정신건강복지센터 같은 공공기관에서는 비용 부담 없이 상담을 시작할 수 있어요.</p>' +
      '<button class="primary" id="factsfree">가까운 무료 공공 상담기관 보기</button></div>' +
    '<p class="caution">통계는 조사마다 대상·연도·지역이 달라요. 각 수치 아래의 출처와 기준을 함께 봐 주세요.</p>';
  lineChart();
  var sm = $('sidomore'); if (sm) sm.addEventListener('toggle', function () { if (sm.open) barChart(); });
}
function tableHTML(head, rows) {
  return '<details class="tbl"><summary>표로 보기</summary><table><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></details>';
}
var NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }

function lineChart() {
  var T = state.stats.trend, svg = $('c-trend'), tip = $('tip-trend'), fig = $('fig-trend');
  var narrow = fig.clientWidth < 520;
  var W = narrow ? 360 : 680, H = narrow ? 230 : 260, L = 40, R = narrow ? 64 : 92, Tp = 14, B = 26;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.innerHTML = '';
  var n = T.years.length, ymax = 1400000, step = 400000;
  var x = function (i) { return L + (W - L - R) * i / (n - 1); }, y = function (v) { return Tp + (H - Tp - B) * (1 - v / ymax); };
  for (var v = 0; v <= ymax; v += step) {
    svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v ? man(v) : '0';
  }
  T.years.forEach(function (yr, i) { if (i % 3 === 0 || i === n - 1) svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = yr; });
  var series = [['mood', 'var(--s1)', '기분장애'], ['anx', 'var(--s2)', '불안·스트레스']];
  series.forEach(function (s) {
    var d = T[s[0]].map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join('');
    svgEl('path', { d: d, fill: 'none', stroke: s[1], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  });
  // 끝값 표시 (두 선이 가까워 위아래로 띄움)
  var ends = series.map(function (s) { return { y: y(T[s[0]][n - 1]), v: T[s[0]][n - 1], c: s[1] }; }).sort(function (a, b) { return a.y - b.y; });
  if (ends[1].y - ends[0].y < 14) { ends[0].ly = ends[0].y - 7; ends[1].ly = ends[1].y + 9; } else { ends[0].ly = ends[0].y + 4; ends[1].ly = ends[1].y + 4; }
  ends.forEach(function (e) {
    svgEl('circle', { cx: x(n - 1), cy: e.y, r: 4, fill: e.c, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    svgEl('text', { x: x(n - 1) + 9, y: e.ly, class: 'val' }, svg).textContent = man1(e.v) + '명';
  });
  // 마우스·터치 안내선
  var cross = svgEl('line', { y1: Tp, y2: H - B, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0 }, svg);
  var dots = series.map(function (s) { return svgEl('circle', { r: 4, fill: s[1], stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 }, svg); });
  var hit = svgEl('rect', { x: L, y: Tp, width: W - L - R, height: H - Tp - B, fill: 'transparent' }, svg);
  function move(ev) {
    var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
    var i = Math.max(0, Math.min(n - 1, Math.round((px - L) / ((W - L - R) / (n - 1)))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', .5);
    series.forEach(function (s, k) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(T[s[0]][i])); dots[k].setAttribute('opacity', 1); });
    tip.innerHTML = T.years[i] + '년<br>기분장애 ' + T.mood[i].toLocaleString() + '명<br>불안·스트레스 ' + T.anx[i].toLocaleString() + '명';
    var fr = fig.getBoundingClientRect();
    tip.style.left = (r.left - fr.left + x(i) * r.width / W) + 'px';
    tip.style.top = (r.top - fr.top + y(Math.max(T.mood[i], T.anx[i])) * r.height / H) + 'px';
    tip.classList.add('on');
  }
  function out() { tip.classList.remove('on'); cross.setAttribute('opacity', 0); dots.forEach(function (d) { d.setAttribute('opacity', 0); }); }
  hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move); hit.addEventListener('pointerleave', out);
}

function barChart() {
  var S = state.stats.sido, svg = $('c-sido'), tip = $('tip-sido'), fig = $('fig-sido');
  var rows = S.rows.slice().sort(function (a, b) { return b[1] - a[1]; });
  var narrow = fig.clientWidth < 520;
  var W = narrow ? 360 : 680, rowH = 24, bh = 14, L = 44, R = 44, Tp = 4, H = Tp + rows.length * rowH + 22;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.innerHTML = '';
  var xmax = 5, x = function (v) { return L + (W - L - R) * v / xmax; };
  for (var t = 0; t <= xmax; t++) {
    svgEl('line', { x1: x(t), x2: x(t), y1: Tp, y2: H - 20, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = t + '%';
  }
  rows.forEach(function (r, i) {
    var y0 = Tp + i * rowH + (rowH - bh) / 2, x0 = x(0), x1 = x(r[1]), rad = Math.min(4, x1 - x0);
    svgEl('text', { x: L - 8, y: y0 + bh - 3, 'text-anchor': 'end' }, svg).textContent = r[0];
    var d = 'M' + x0 + ',' + y0 + 'H' + (x1 - rad) + 'Q' + x1 + ',' + y0 + ' ' + x1 + ',' + (y0 + rad) + 'V' + (y0 + bh - rad) + 'Q' + x1 + ',' + (y0 + bh) + ' ' + (x1 - rad) + ',' + (y0 + bh) + 'H' + x0 + 'Z';
    var bar = svgEl('path', { d: d, fill: 'var(--s1)' }, svg);
    svgEl('text', { x: x1 + 6, y: y0 + bh - 3, class: i === 0 || i === rows.length - 1 ? 'val' : '' }, svg).textContent = r[1] + '%';
    var hit = svgEl('rect', { x: 0, y: Tp + i * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
    function show() {
      bar.setAttribute('opacity', .8);
      tip.innerHTML = r[0] + '<br>우울증상 유병률 ' + r[1] + '%<br>스트레스 인지율 ' + r[2] + '%<br>우울감 경험률 ' + r[3] + '%';
      var sr = svg.getBoundingClientRect(), fr = fig.getBoundingClientRect();
      tip.style.left = (sr.left - fr.left + x1 * sr.width / W) + 'px';
      tip.style.top = (sr.top - fr.top + y0 * sr.height / H) + 'px';
      tip.classList.add('on');
    }
    hit.addEventListener('pointerenter', show); hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', function () { bar.setAttribute('opacity', 1); tip.classList.remove('on'); });
  });
}

/* ───────── 숨 고르기: 4초 들이쉬고 6초 내쉬기 (숨 참기 없음) ───────── */
// 원 안에는 박자 숫자(4→1, 6→1)만 조용히 보여 준다. 남은 시간은 재촉처럼 느껴질 수 있어 보여 주지 않고, 마지막 한 번만 알려 준다.
function runBreath(lung, txt, cycles, timers, done) {
  lung.className = 'lung'; lung.innerHTML = '<span class="cnt">준비</span>';
  var c = lung.firstChild, t = 1500;
  txt.textContent = '어깨 힘을 빼고 편하게 앉아요. 곧 시작해요';
  function phase(cls, msg, sec) {
    timers.push(setTimeout(function () { lung.className = 'lung ' + cls; txt.textContent = msg; }, t));
    for (var s = 0; s < sec; s++) (function (n, at) { timers.push(setTimeout(function () { c.textContent = n; }, at)); })(sec - s, t + s * 1000);
    t += sec * 1000;
  }
  for (var i = 0; i < cycles; i++) {
    var last = i === cycles - 1 && cycles > 1;
    phase('in', '코로 천천히 들이쉬어요' + (last ? ' · 마지막 한 번이에요' : ''), 4);
    phase('out', '입으로 길게 내쉬어요', 6);
  }
  timers.push(setTimeout(function () { c.textContent = ''; done(); }, t));
}
var breathT = [];
function breathe() {
  var box = $('breathbox'), lung = $('lung'), txt = $('breathtext'), btn = $('breathbtn');
  breathT.forEach(clearTimeout); breathT = [];
  if (btn.getAttribute('aria-expanded') === 'true') { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.textContent = '30초 숨 고르기'; lung.className = 'lung'; return; }
  box.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.textContent = '그만하기';
  runBreath(lung, txt, 3, breathT, function () { txt.textContent = '잘했어요. 필요하면 한 번 더 해도 돼요.'; btn.textContent = '닫기'; });
}

/* ───────── 마음 쉬기: 호흡·감각·몸·문구 중 지금 맞는 것 하나 ─────────
 * 고른 것과 "지금은 어떤가요" 답은 저장하지도, 보내지도 않는다. */
var REST = {
  breath: { t: '숨 고르기', s: '4초 들이쉬고 6초 내쉬기 · 30초~2분' },
  belly:  { t: '배로 숨쉬기', s: '배에 손을 얹고 편한 속도로 · 1분' },
  ground: { t: '감각으로 돌아오기', s: '생각이 멈추지 않을 때 · 보이는 것, 들리는 것 세어 보기 · 2~3분' },
  body:   { t: '몸 풀기', s: '어깨와 손에 힘 줬다 빼기 · 1분' },
  words:  { t: '안심 문구', s: '천천히 한 장씩 넘겨 보기' }
};
var REST_NEXT = { breath: 'ground', belly: 'ground', ground: 'body', body: 'words', words: 'breath' };
var GROUND = [
  [5, '보이는 것', '주변을 둘러보며 눈에 보이는 것 다섯 가지를 찾아보세요. 마음속으로 이름만 불러도 돼요.'],
  [4, '만져지는 것', '옷감, 의자, 바닥처럼 몸에 닿는 것 네 가지를 느껴 보세요.'],
  [3, '들리는 것', '가까운 소리와 먼 소리, 세 가지에 귀 기울여 보세요.'],
  [2, '냄새', '냄새 두 가지를 찾아보세요. 잘 모르겠으면 좋아하는 냄새를 떠올려도 돼요.'],
  [1, '맛', '지금 입안에 느껴지는 맛 하나, 또는 좋아하는 맛 하나를 떠올려 보세요.']
];
var BODY = [
  ['어깨를 귀 쪽으로 천천히 올려요', 5], ['툭 내려놓아요. 힘이 빠지는 느낌을 느껴 보세요', 10],
  ['한 번 더, 어깨를 천천히 올려요', 5], ['내려놓아요. 어깨가 가벼워지는 걸 느껴 보세요', 10],
  ['두 손을 꽉 쥐어요', 5], ['천천히 펴요. 손가락 사이로 힘이 풀려요', 10],
  ['한 번 더, 두 손을 쥐어요', 5], ['펴요. 손바닥을 무릎 위에 편하게 두세요', 10],
  ['마지막으로 숨을 길게 한 번 내쉬어요', 6]
];
var BELLY = ['숨을 들이쉬면 배가 살짝 부풀어요', '내쉬면 배가 천천히 가라앉아요', '숫자는 세지 않아도 돼요. 편한 속도면 충분해요', '다른 생각이 떠오르면, 다시 손에 닿는 느낌으로 돌아와요'];
var WORDS = [
  '여기까지 온 것만으로도 충분해요.',
  '힘든 마음이 드는 건 이상한 일이 아니에요.',
  '오늘은 아무것도 해결하지 않아도 괜찮아요.',
  '한 번에 하나씩, 천천히 해도 돼요.',
  '마음은 파도처럼 올라왔다 내려가기도 해요.',
  '도움을 청하는 것도 나를 챙기는 방법이에요.',
  '지금 할 수 있는 만큼만 해도 돼요.',
  '오늘 하루를 지나온 나에게, 수고했다고 말해 줘요.'
];
var restT = [];
function stopRest() { restT.forEach(clearTimeout); restT.forEach(clearInterval); restT = []; }
function restSafe(k) {
  return '<ul class="safe">' + (k !== 'words' && k !== 'ground' ? '<li>어지럽거나 더 불편해지면 바로 멈추고 평소처럼 숨 쉬세요.</li>' : '') +
    '<li>눈은 떠도 괜찮아요. 언제든 그만둬도 돼요.</li><li>마음을 잠깐 가라앉히는 방법이에요. 치료를 대신하지는 않아요.</li></ul>';
}
function restHead(z) { return '<button class="textbtn" id="restmenu">‹ 다른 방법 고르기</button><h2>' + REST[z.k].t + '</h2>' + soundHTML(); }
function renderRest() {
  var el = $('restbox'), z = state.rest;
  stopRest();
  if (!z) {
    el.innerHTML = '<h2>마음 쉬기</h2><p class="lead">지금 맞을 것 같은 것 하나만 골라 보세요. 숨에 집중하는 게 불편하면 다른 방법도 있어요.</p>' +
      '<div class="pick">' + Object.keys(REST).map(function (k) { return '<button data-rest="' + k + '"><b>' + REST[k].t + '</b><small>' + REST[k].s + '</small><i aria-hidden="true">›</i></button>'; }).join('') + '</div>' +
      soundHTML() + '<p class="note">여기서 고르거나 답한 것은 이 기기 밖으로 보내지 않고 저장하지도 않아요. 배경 소리는 기본으로 꺼져 있어요.</p>' + restSafe();
    return;
  }
  if (z.feel) return renderFeel(el, z);
  if (z.check) {
    el.innerHTML = '<h2>지금은 어떤가요</h2><p class="lead">' + (z.stopped ? '중간에 멈춰도 괜찮아요. ' : '') + '가장 가까운 걸 골라 주세요.</p>' +
      '<div class="feel"><button data-feel="better">조금 나아졌어요</button><button data-feel="same">비슷해요</button><button data-feel="hard">아직 많이 힘들어요</button></div>';
    return;
  }
  var k = z.k;
  if (k === 'breath') {
    if (!z.len) {
      el.innerHTML = restHead(z) + '<p class="lead">4초 동안 코로 들이쉬고, 6초 동안 입으로 길게 내쉬어요. 숨을 참는 구간은 없어요.</p>' +
        '<div class="lens">' + [[3, '30초'], [6, '1분'], [12, '2분']].map(function (x) { return '<button class="ghost" data-len="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' + restSafe(k);
      return;
    }
    el.innerHTML = restHead(z) + '<div class="run"><div class="lung" id="rlung" aria-hidden="true"></div><p id="rtext" aria-live="polite"></p></div>' +
      '<button class="ghost" id="reststop">그만하기</button>' + restSafe(k);
    runBreath($('rlung'), $('rtext'), z.len, restT, function () { z.check = true; renderRest(); });
    return;
  }
  if (k === 'belly') {
    if (!z.go) {
      el.innerHTML = restHead(z) + '<p class="lead">한 손은 가슴에, 다른 손은 배에 올려요. 앉아도, 누워도 괜찮아요.</p>' +
        '<button class="primary" id="restgo">시작할게요 (1분)</button>' + restSafe(k);
      return;
    }
    el.innerHTML = restHead(z) + '<div class="run"><div class="bar wide" aria-hidden="true"><i id="rbar" style="width:0"></i></div><p id="rtext" aria-live="polite">' + BELLY[0] + '</p></div>' +
      '<button class="ghost" id="reststop">그만하기</button>' + restSafe(k);
    var sec = 0;
    restT.push(setInterval(function () {
      sec++; var b = $('rbar'), t = $('rtext'); if (!b) return;
      b.style.width = Math.min(100, sec / 60 * 100) + '%';
      if (sec % 8 === 0) t.textContent = BELLY[(sec / 8) % BELLY.length];
      if (sec >= 60) { z.check = true; renderRest(); }
    }, 1000));
    return;
  }
  if (k === 'ground') {
    var i = z.i || 0;
    if (z.i == null) {
      el.innerHTML = restHead(z) + '<p class="lead">지금 여기 있는 것에 주의를 옮겨 보는 방법이에요. 눈은 떠 둔 채로 해요. 다 못 찾아도 괜찮아요.</p>' +
        '<button class="primary" id="restgo">시작할게요</button>' + restSafe(k);
      return;
    }
    var g = GROUND[i];
    el.innerHTML = restHead(z) + '<div class="bar" aria-hidden="true"><i style="width:' + ((i + 1) / GROUND.length * 100) + '%"></i></div>' +
      '<div class="step"><strong class="big">' + g[0] + '</strong><h3>' + g[1] + '</h3><p>' + g[2] + '</p></div>' +
      '<div class="two"><button class="ghost" id="restprev">' + (i ? '이전' : '처음 설명') + '</button><button class="primary" id="restnext">' + (i < GROUND.length - 1 ? '다음' : '다 했어요') + '</button></div>' + restSafe(k);
    return;
  }
  if (k === 'body') {
    if (!z.go) {
      el.innerHTML = restHead(z) + '<p class="lead">앉은 자리에서 할 수 있어요. 아프거나 불편한 곳이 있으면 그 동작은 건너뛰어요.</p>' +
        '<button class="primary" id="restgo">시작할게요 (1분)</button>' + restSafe(k);
      return;
    }
    el.innerHTML = restHead(z) + '<div class="run"><strong class="big" id="rsec" aria-hidden="true"></strong><p id="rtext" aria-live="polite"></p></div>' +
      '<button class="ghost" id="reststop">그만하기</button>' + restSafe(k);
    var s = 0, left = 0;
    var nextBody = function () {
      if (s >= BODY.length) { z.check = true; return renderRest(); }
      $('rtext').textContent = BODY[s][0]; left = BODY[s][1]; $('rsec').textContent = left; s++;
    };
    nextBody();
    restT.push(setInterval(function () { if (!$('rsec')) return; left--; if (left <= 0) nextBody(); else $('rsec').textContent = left; }, 1000));
    return;
  }
  if (k === 'words') {
    var w = z.i || 0;
    el.innerHTML = restHead(z) + '<p class="lead">마음에 닿는 문장이 있으면 잠깐 머물러도 돼요.</p>' +
      '<div class="phrase" aria-live="polite"><p>' + WORDS[w] + '</p><span>' + (w + 1) + ' / ' + WORDS.length + '</span></div>' +
      '<div class="two"><button class="ghost" id="restprev"' + (w ? '' : ' disabled') + '>이전</button><button class="primary" id="restnext">' + (w < WORDS.length - 1 ? '다음' : '다 봤어요') + '</button></div>' +
      '<button class="textbtn" id="reststop">이제 그만 볼래요</button>' + restSafe(k);
  }
}
/* 배경 소리: 파일 없이 이 기기에서 만든 잡음(빗소리·바람). 기본은 끔, 원할 때만 켠다. */
var SND = { ctx: null, kind: 'off', nodes: [], out: null };
function noise(ctx, brown) {
  var n = ctx.sampleRate * 4, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0), last = 0;
  for (var i = 0; i < n; i++) { var w = Math.random() * 2 - 1; if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
  var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; return src;
}
function stopSound(fast) {
  var c = SND.ctx, nodes = SND.nodes, out = SND.out;
  SND.kind = 'off'; SND.nodes = []; SND.out = null;
  if (!c || !out) return;
  var t = c.currentTime; out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + (fast ? 0.05 : 0.8));
  setTimeout(function () { nodes.forEach(function (n) { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} }); }, fast ? 100 : 900);
}
function startSound(kind) {
  stopSound(true);
  if (kind === 'off') return;
  var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  var c = SND.ctx || (SND.ctx = new AC()); if (c.resume) c.resume();
  var out = c.createGain(); out.gain.value = 0; out.connect(c.destination);
  var nodes = [], t = c.currentTime;
  if (kind === 'rain') {
    var r = noise(c, false), hp = c.createBiquadFilter(), lp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 400; lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.4;
    r.connect(hp); hp.connect(lp); lp.connect(out); r.start(); nodes.push(r);
    out.gain.linearRampToValueAtTime(0.09, t + 2.5);
  } else {
    var w = noise(c, true), bp = c.createBiquadFilter(), lfo = c.createOscillator(), depth = c.createGain(), amp = c.createGain(), lfo2 = c.createOscillator(), d2 = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 0.7;
    lfo.frequency.value = 0.07; depth.gain.value = 180; lfo.connect(depth); depth.connect(bp.frequency);
    amp.gain.value = 1; lfo2.frequency.value = 0.045; d2.gain.value = 0.35; lfo2.connect(d2); d2.connect(amp.gain);
    w.connect(bp); bp.connect(amp); amp.connect(out); w.start(); lfo.start(); lfo2.start(); nodes.push(w, lfo, lfo2);
    out.gain.linearRampToValueAtTime(0.22, t + 3);
  }
  SND.kind = kind; SND.nodes = nodes; SND.out = out;
}
function soundHTML() {
  if (!(window.AudioContext || window.webkitAudioContext)) return '';
  return '<div class="sound" role="group" aria-label="배경 소리"><span>배경 소리</span>' +
    [['off', '끔'], ['rain', '빗소리'], ['wind', '바람']].map(function (x) { return '<button data-snd="' + x[0] + '" aria-pressed="' + (SND.kind === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>';
}
document.addEventListener('visibilitychange', function () { if (document.hidden && SND.kind !== 'off') { stopSound(true); var g = document.querySelectorAll('[data-snd]'); g.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.snd === 'off'); }); } });

/* 처음 화면의 작은 새싹: 누를 때만 살짝 흔들리고 짧은 문장을 보여 준다. 저절로 움직이지 않는다. */
var SPROUT = ['천천히 와도 괜찮아요.', '여기 잠깐 머물러도 돼요.', '오늘도 여기까지 왔네요.', '숨 한 번, 길게 내쉬어 볼까요.', '서두르지 않아도 돼요.'];
var sproutN = 0, sproutT;
function petSprout() {
  var b = $('sprout'), say = $('sproutsay');
  b.classList.remove('sway'); void b.offsetWidth; b.classList.add('sway');
  say.innerHTML = '<span>' + esc(SPROUT[sproutN++ % SPROUT.length]) + '</span><button class="textbtn" data-go="rest">잠깐 쉬어 가기 ›</button><button class="textbtn" id="sprouthard">지금 많이 힘들어요 ›</button>';
  $('sprouthint').hidden = true;
  say.hidden = false; clearTimeout(sproutT); sproutT = setTimeout(function () { say.hidden = true; $('sprouthint').hidden = false; }, 10000);
}

function renderFeel(el, z) {
  var nx = REST_NEXT[z.k];
  if (z.feel === 'better') {
    el.innerHTML = '<h2>다행이에요</h2><p class="lead">필요할 때 언제든 다시 와도 돼요.</p>' +
      '<button class="ghost" id="restmenu">다른 방법도 둘러보기</button><button class="ghost" data-go="home">처음으로</button>';
  } else if (z.feel === 'same') {
    el.innerHTML = '<h2>그럴 수 있어요</h2><p class="lead">한 번에 달라지지 않는 날도 있어요. 다른 방법이 더 맞을 수도 있어요.</p>' +
      '<button class="primary" data-rest="' + nx + '">' + REST[nx].t + ' 해 보기</button><button class="ghost" id="restmenu">다른 방법 고르기</button>' +
      '<button class="ghost" id="tomap">가까운 상담기관 보기</button>';
  } else {
    el.innerHTML = '<div class="help"><p>많이 힘들다면 혼자 견디지 않아도 돼요. 지금 전화하면 24시간 이야기할 수 있어요.</p><a href="tel:109">109 자살예방 상담전화</a><a href="tel:15770199">1577-0199 정신건강 위기상담</a></div>' +
      '<p class="lead">전화가 부담스러우면, 가까운 곳에서 직접 이야기할 수 있는 기관도 있어요.</p>' +
      '<button class="primary" id="tomap">가까운 기관 보기</button><button class="ghost" id="tofree">무료 공공 상담기관만 보기</button>' +
      '<p class="note">청소년이라면 <a href="tel:1388">1388 청소년 상담전화</a>에서도 이야기할 수 있어요.</p>' +
      '<button class="textbtn" id="restmenu">‹ 다른 방법 고르기</button>';
  }
}

/* ───────── PC에서 전화 버튼: 바로 걸리지 않으니 번호를 복사하고 알려 준다 ───────── */
var canCall = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
function toast(msg) {
  var t = $('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('on'); }, 4000);
}
document.addEventListener('click', function (e) {
  var a = e.target.closest('a[href^="tel:"]'); if (!a || canCall) return;
  var num = a.getAttribute('href').slice(4), shown = (a.textContent.match(/[\d-]{3,}/) || [num])[0];
  e.preventDefault();
  var done = function () { toast(shown + ' 번호를 복사했어요. 휴대폰으로 걸어 주세요.'); };
  if (navigator.clipboard) navigator.clipboard.writeText(shown).then(done, function () { toast('휴대폰으로 ' + shown + '에 걸어 주세요.'); });
  else toast('휴대폰으로 ' + shown + '에 걸어 주세요.');
});

/* ───────── 방문 집계: 날짜별·시간대별 횟수만 ─────────
 * 보내는 것은 이벤트 이름과 분류 이름뿐이다(처음/다시, PC/모바일, 들어온 경로 종류).
 * 누구인지 알 수 있는 값(IP를 따로 모으거나, 기기 ID, 위치, 검색어, 자가검진 응답)은 보내지 않는다. */
function hit(ev, extra) {
  if (!CFG.DATA_URL || /^(localhost|127\.)/.test(location.hostname)) return;
  var q = '?type=hit&e=' + encodeURIComponent(ev);
  if (extra) Object.keys(extra).forEach(function (k) { q += '&' + k + '=' + encodeURIComponent(extra[k]); });
  try { fetch(CFG.DATA_URL + q, { mode: 'no-cors', keepalive: true }); } catch (e) {}
}
function srcKind() {
  if (IN_KAKAO) return 'kakao';
  var r = ''; try { r = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
  if (!r || r === location.hostname) return 'direct';
  if (/kakao/.test(r)) return 'kakao';
  if (/instagram|facebook|(^|\.)t\.co$|twitter|(^|\.)x\.com$|threads|band\.us|youtube|tiktok|blog\.naver|cafe\.naver|blog\.daum|cafe\.daum|tistory/.test(r)) return 'sns';
  if (/google|naver|daum|bing|zum|yahoo|duckduckgo|ecosia/.test(r)) return 'search';
  return 'etc';
}
function hitVisit() {
  hit('open');                                         // 페이지를 연 횟수
  var d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), seen = null;
  try { if (localStorage.getItem('ms_day') === d) return; localStorage.setItem('ms_day', d); seen = localStorage.getItem('ms_seen'); localStorage.setItem('ms_seen', '1'); } catch (e) {}
  var mob = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  hit('visit', { nw: seen ? '0' : '1', dv: mob ? 'm' : 'pc', src: srcKind() });   // 이 기기의 하루 첫 접속
}
document.addEventListener('click', function (e) {
  var a = e.target.closest('a[href]'); if (!a) return;
  var h = a.getAttribute('href');
  if (/^tel:(109|15770199|1388)$/.test(h)) hit('crisis');
  else if (h.indexOf('tel:') === 0) hit('tel');
  else if (/map\.kakao\.com\/link\/to|map\.naver\.com/.test(h)) hit('route');
}, true);

/* ───────── 의견 보내기: 시트 '의견_접수' 탭으로. 이메일은 선택 ───────── */
var FB_ERR = { email: '이메일 주소를 다시 확인해 주세요.', empty: '내용을 적어 주세요.', busy: '지금 의견이 많이 몰렸어요. 잠시 뒤 다시 보내 주세요.' };
function sendFeedback(payload, done) {
  if (!CFG.DATA_URL) return done('net');
  var ctl = window.AbortController ? new AbortController() : null, t = ctl && setTimeout(function () { ctl.abort(); }, 15000);
  // 본문을 글자(text/plain)로 보내 사전 요청(CORS preflight) 없이 Apps Script로 바로 간다
  fetch(CFG.DATA_URL, ctl ? { method: 'POST', body: JSON.stringify(payload), signal: ctl.signal } : { method: 'POST', body: JSON.stringify(payload) })
    .then(function (r) { return r.json(); })
    .then(function (j) { done(j && j.ok ? null : (j && j.e) || 'net'); })
    .catch(function () { done('net'); })
    .finally(function () { if (t) clearTimeout(t); });
}
function errText(e) { return FB_ERR[e] || '보내지 못했어요. 잠시 뒤 다시 해 주세요.'; }
var HP = '<input class="hp" name="website" id="hp" tabindex="-1" autocomplete="off" aria-hidden="true">';

// 기관 상세: 이 기관 정보가 달라요
var FIX_ITEMS = ['전화번호가 달라요', '운영시간이 달라요', '문을 닫았어요', '다른 곳으로 옮겼어요', '기타'];
function reportHTML(f) {
  var r = state.report;
  if (!r || r.id !== f.id) return '<button class="textbtn" id="reportopen">이 기관 정보가 달라요</button>';
  if (r.sent) return '<p class="note" id="reportbox">알려 주셔서 고마워요. 확인해서 고칠게요.</p>';
  return '<div class="report" id="reportbox"><h3>어떤 점이 다른가요?</h3>' +
    '<div class="filters wrap" role="group" aria-label="다른 점">' + FIX_ITEMS.map(function (x) { return '<button class="chip" data-ritem="' + x + '" aria-pressed="' + (r.item === x) + '">' + x + '</button>'; }).join('') + '</div>' +
    '<textarea id="rtext" class="field" rows="3" maxlength="300" placeholder="알고 계신 내용을 적어 주세요 (선택)">' + esc(r.text || '') + '</textarea>' + HP +
    (r.err ? '<p class="err" role="alert">' + esc(r.err) + '</p>' : '') +
    '<div class="two"><button class="ghost" id="reportcancel">닫기</button><button class="primary" id="reportsend"' + (r.busy ? ' disabled' : '') + '>' + (r.busy ? '보내는 중…' : '보내기') + '</button></div>' +
    '<p class="caution">이름이나 연락처는 적지 않아도 돼요. 보낸 내용은 기관 정보를 고치는 데만 써요.</p></div>';
}
function redrawReport() { renderPanel(); var b = $('reportbox'); if (b) b.scrollIntoView({ block: 'center' }); }

// 알려 주세요
var ASK_TYPES = [['idea', '사이트 개선 의견'], ['fix', '기관 정보가 달라요'], ['pro', '전문가·기관 담당자예요']];
var ASK_LEAD = {
  idea: '불편했던 점, 있으면 좋겠는 것, 문구가 마음에 걸렸던 곳까지 무엇이든 괜찮아요.',
  fix: '기관 화면에서 바로 알리려면 기관 상세의 "이 기관 정보가 달라요"를 눌러도 돼요.',
  pro: '정신건강 전문가, 상담사, 기관 담당자분의 의견과 연락을 기다려요. 답장받을 이메일을 남겨 주세요.'
};
function keepAsk() { var a = state.ask, t = $('atext'), e = $('aemail'), n = $('aname'); if (t) a.text = t.value; if (e) a.email = e.value; if (n) a.name = n.value; }
function renderAsk() {
  var el = $('askbox'), a = state.ask || (state.ask = { type: 'idea' });
  var top = '<h2>알려 주세요</h2><div class="help small"><p>여기 남긴 글에는 바로 답하지 못해요. 지금 많이 힘들다면 전화로 이야기해 주세요. 24시간 받아요.</p><a href="tel:109">109 자살예방 상담전화</a><a href="tel:15770199">1577-0199 정신건강 위기상담</a></div>';
  if (a.sent) {
    el.innerHTML = top + '<p class="lead">보내 주셔서 고마워요. 꼼꼼히 읽어 볼게요.' + (a.sentEmail ? ' 답장이 필요하면 남겨 주신 이메일로 연락드릴게요.' : '') + '</p>' +
      '<button class="ghost" id="askagain">하나 더 보내기</button><button class="ghost" data-go="home">처음으로</button>';
    return;
  }
  el.innerHTML = top +
    '<div class="seg" role="group" aria-label="무엇을 알려 주실까요">' + ASK_TYPES.map(function (t) { return '<button data-atype="' + t[0] + '" aria-pressed="' + (a.type === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div>' +
    '<p class="lead">' + ASK_LEAD[a.type] + '</p>' +
    (a.type === 'fix' ? '<label class="lbl" for="aname">기관 이름</label><input id="aname" class="field" maxlength="80" value="' + esc(a.name || '') + '">' : '') +
    '<label class="lbl" for="atext">내용</label><textarea id="atext" class="field" rows="6" maxlength="1000">' + esc(a.text || '') + '</textarea>' +
    '<label class="lbl" for="aemail">이메일 <span>(선택)</span></label><input id="aemail" class="field" type="email" inputmode="email" autocomplete="email" maxlength="100" value="' + esc(a.email || '') + '">' +
    '<p class="caution">답장이 필요할 때만 적어 주세요. 이메일은 답장하는 데에만 쓰고, 처리가 끝나면 지워요.</p>' + HP +
    '<p class="note">이름, 연락처, 병력처럼 나를 알아볼 수 있는 내용은 적지 말아 주세요.</p>' +
    (a.err ? '<p class="err" role="alert">' + esc(a.err) + '</p>' : '') +
    '<button class="primary" id="asksend"' + (a.busy ? ' disabled' : '') + '>' + (a.busy ? '보내는 중…' : '보내기') + '</button>';
}

/* ───────── 화면 전환 ───────── */
var VIEWS = ['home', 'map', 'check', 'rest', 'facts', 'guide', 'ask', 'support'];
function go(v) {
  if (state.view !== v || !go.done) hit('view:' + v); go.done = true;
  if (state.view === 'rest' && v !== 'rest') { stopRest(); stopSound(); state.rest = null; }
  state.view = v;
  VIEWS.forEach(function (k) { $('v-' + k).classList.toggle('on', k === v); });
  document.querySelectorAll('[data-go]').forEach(function (b) { if (b.tagName === 'BUTTON') { if (b.dataset.go === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); } });
  if (v === 'map') {
    renderPanel();
    setTimeout(function () { if (!K.map && K.ready) createMap(); else if (K.map) { K.map.relayout(); if (K.needFit) drawMap(true); } }, 30);
  }
  if (v === 'check') renderCheck();
  if (v === 'rest') { renderRest(); $('v-rest').scrollTop = 0; }
  if (v === 'ask') { renderAsk(); $('v-ask').scrollTop = 0; }
  if (v === 'support') { var fz = state.sup && state.sup.focus; renderSupport(); if (!fz) $('v-support').scrollTop = 0; }
  if (v === 'facts') {
    if (!state.stats) getJSON(CFG.STATS_URL).then(function (j) { state.stats = j; if (state.view === 'facts') renderFacts(); }).catch(function () { $('factsbox').innerHTML = '<p class="empty">통계를 불러오지 못했어요.</p>'; });
    renderFacts();
  }
  if (!NAV.pop) { try { var hs = history.state || {}; if (hs.v !== v || hs.sel || hs.sheet || hs.q || hs.r) history.pushState({ v: v }, '', '#' + v); } catch (e) {} }
  if (v !== 'map') setSheet(false);
}
/* 뒤로가기: 화면을 옮기거나 상세·시트·검진·쉬기 안으로 들어갈 때마다 기록을 남기고, 뒤로 가면 한 단계씩 돌아온다 */
var NAV = { pop: false };
function navPush(extra) { try { var o = { v: state.view }; for (var k in extra) if (extra[k]) o[k] = extra[k]; history.pushState(o, '', '#' + state.view); } catch (e) {} }
window.addEventListener('popstate', function (e) {
  var h = location.hash.slice(1), s = e.state || { v: VIEWS.indexOf(h) >= 0 ? h : 'home' };
  NAV.pop = true;
  try {
    if (s.v !== state.view) go(s.v);
    if (state.view === 'map') {
      var ns = s.sel || null;
      if (state.sel !== ns) { state.sel = ns; state.report = null; renderPanel(); drawMap(false); }
      setSheet(isMobile() && !!(s.sheet || s.sel));
    }
    if (state.view === 'check' && !s.q && state.quiz) { state.quiz = null; renderCheck(); }
    if (state.view === 'rest' && !s.r && state.rest) { stopRest(); stopSound(); state.rest = null; renderRest(); }
  } finally { NAV.pop = false; }
});
function showFreeOnMap() { state.sel = null; state.kind = 'p'; state.filters = { open: false, night: false, sat: false, free: true, more: false }; go('map'); drawMap(true); }

document.addEventListener('click', function (e) {
  var b = e.target.closest('button, a[data-go]'); if (!b) return;
  if (b.dataset.go) { e.preventDefault(); return go(b.dataset.go); }
  if (b.dataset.id) return select(b.dataset.id);
  if (b.dataset.kind) { state.kind = b.dataset.kind; state.shown = CFG.LIST_STEP || 30; renderPanel(); return drawMap(true); }
  if (b.id === 'research') { var c = K.map.getCenter(); state.origin = { lat: c.getLat(), lng: c.getLng(), label: '지도 가운데' }; state.mine = false; state.sido = null; return afterOrigin(false); }
  if (b.id === 'copy' || b.id === 'copysum') { copyText(b.dataset.copy, function () { b.textContent = '복사했어요'; }); return; }
  if (b.id === 'breathbtn') return breathe();
  if (b.dataset.f) { state.filters[b.dataset.f] = !state.filters[b.dataset.f]; state.shown = CFG.LIST_STEP || 30; renderPanel(); return drawMap(true); }
  if (b.id === 'back') { if ((history.state || {}).sel) return history.back(); state.sel = null; state.report = null; if (isMobile()) setSheet(false); renderPanel(); return drawMap(false); }
  if (b.id === 'sheetclose') return closeSheet();
  if (b.id === 'msearch') { openSheet(); setTimeout(function () { var q = $('q'); if (q) q.focus(); }, 320); return; }
  if (b.id === 'mlist') return openSheet();
  if (b.id === 'mloc') return useMyLocation();
  if (b.dataset.mi != null) { var mi = +b.dataset.mi; if (mi === MOB.focus) return select(MOB.list[mi].id); return mobFocusId(MOB.list[mi].id); }
  // 이 기관 정보가 달라요
  if (b.id === 'reportopen') { state.report = { id: state.sel }; return redrawReport(); }
  if (b.id === 'reportcancel') { state.report = null; return renderPanel(); }
  if (b.dataset.ritem) { state.report.item = b.dataset.ritem; document.querySelectorAll('[data-ritem]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
  if (b.id === 'reportsend') {
    var r = state.report, rf = byId(r.id); r.text = ($('rtext') || {}).value || '';
    if (!r.item && !r.text.trim()) { r.err = '다른 점을 하나 골라 주세요.'; return redrawReport(); }
    r.busy = true; r.err = ''; redrawReport();
    return sendFeedback({ type: 'fix', id: r.id, name: rf ? rf.n : '', item: r.item || '', text: r.text, hp: ($('hp') || {}).value || '' }, function (e) {
      r.busy = false; if (e) r.err = errText(e); else r.sent = true; if (state.sel === r.id) redrawReport();
    });
  }
  // 알려 주세요
  if (b.dataset.atype) { keepAsk(); state.ask.type = b.dataset.atype; state.ask.err = ''; return renderAsk(); }
  if (b.id === 'askagain') { state.ask = { type: state.ask.type }; return renderAsk(); }
  if (b.id === 'asksend') {
    keepAsk(); var a = state.ask;
    if (!String(a.text || '').trim()) { a.err = '내용을 적어 주세요.'; renderAsk(); return $('atext').focus(); }
    a.busy = true; a.err = ''; renderAsk();
    return sendFeedback({ type: a.type, name: a.type === 'fix' ? a.name || '' : '', text: a.text, email: String(a.email || '').trim(), hp: ($('hp') || {}).value || '' }, function (e) {
      a.busy = false; if (e) a.err = errText(e); else { a.sent = true; a.sentEmail = !!String(a.email || '').trim(); }
      if (state.view === 'ask') { renderAsk(); var h = $('askbox').querySelector(e ? '.err' : 'h2'); if (h) h.scrollIntoView({ block: 'center' }); }
    });
  }
  if (b.id === 'more') { state.shown += CFG.LIST_STEP || 30; renderPanel(); return drawMap(false); }
  if (b.id === 'locate') return useMyLocation();
  if (b.id === 'mapsize') {
    var big = $('v-map').classList.toggle('big'); b.setAttribute('aria-pressed', big); b.textContent = big ? '목록 크게' : '지도 크게';
    setTimeout(function () { relayout(); drawMap(false); }, 260); return;
  }
  if (b.dataset.test) { navPush({ q: 1 }); state.quiz = { test: b.dataset.test, ans: [] }; return renderCheck(); }
  if (b.dataset.ans) { state.quiz.ans.push(+b.dataset.ans); renderCheck(); $('v-check').scrollTop = 0; return; }
  if (b.id === 'prevq') { state.quiz.ans.pop(); return renderCheck(); }
  if (b.id === 'quit') { if ((history.state || {}).q) return history.back(); state.quiz = null; return renderCheck(); }
  if (b.id === 'again') { state.quiz = null; return renderCheck(); }
  if (b.id === 'tomap') { state.sel = null; go('map'); return drawMap(true); }
  if (b.id === 'tofree' || b.id === 'factsfree') return showFreeOnMap();
  if (b.id === 'tofacts') return go('facts');
  if (b.id === 'toguide') return go('guide');
  if (b.id === 'tosupport') return go('support');
  if (b.dataset.stab) { supState().tab = b.dataset.stab; return renderSupport(); }
  if (b.dataset.sf) { var z = supState(); z.fopen = true; if (b.dataset.sf === 'online') z.online = !z.online; else z[b.dataset.sf] = z[b.dataset.sf] === b.dataset.v ? 'all' : b.dataset.v; return renderSupport(); }
  if (b.id === 'sfreset') { var z2 = supState(); z2.life = 'all'; z2.need = 'all'; z2.online = false; return renderSupport(); }
  if (b.dataset.supid) { var z3 = supState(), x = (state.support || []).filter(function (y) { return y.id === b.dataset.supid; })[0]; z3.tab = x && x.k === 'l' ? 'l' : 'n'; z3.life = 'all'; z3.need = 'all'; z3.online = false; z3.focus = b.dataset.supid; return go('support'); }
  if (b.id === 'tobreath') { go('rest'); return; }
  if (b.id === 'sprout') return petSprout();
  if (b.id === 'sprouthard') { go('rest'); state.rest = { k: 'words', feel: 'hard' }; renderRest(); return; }
  if (b.dataset.snd) { startSound(b.dataset.snd); document.querySelectorAll('[data-snd]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.snd === SND.kind); }); return; }
  // 마음 쉬기
  var rz = state.rest, restDraw = function () { renderRest(); var r = $('restbox'); var f = r && r.querySelector('h2'); if (f) { f.setAttribute('tabindex', '-1'); f.focus(); } $('v-rest').scrollTop = 0; };
  if (b.dataset.rest) { if (state.view !== 'rest') go('rest'); if (!(history.state || {}).r) navPush({ r: 1 }); state.rest = { k: b.dataset.rest }; return restDraw(); }
  if (b.id === 'restmenu') { if ((history.state || {}).r) return history.back(); state.rest = null; return restDraw(); }
  if (!rz) return;
  if (b.dataset.len) { rz.len = +b.dataset.len; return restDraw(); }
  if (b.id === 'restgo') { if (rz.k === 'ground') rz.i = 0; else rz.go = true; return restDraw(); }
  if (b.id === 'reststop') { rz.check = true; rz.stopped = rz.k !== 'words'; return restDraw(); }
  if (b.id === 'restnext') {
    var lim = rz.k === 'ground' ? GROUND.length : WORDS.length;
    if ((rz.i || 0) < lim - 1) rz.i = (rz.i || 0) + 1; else rz.check = true;
    return restDraw();
  }
  if (b.id === 'restprev') { if (rz.k === 'ground' && !rz.i) rz.i = null; else rz.i = Math.max(0, (rz.i || 0) - 1); return restDraw(); }
  if (b.dataset.feel) { rz.feel = b.dataset.feel; return restDraw(); }
});
document.addEventListener('change', function (e) {
  if (e.target.id === 'suparea') { supState().area = e.target.value; return renderSupport(); }
  if (e.target.id === 'sido' && e.target.value !== '') {
    state.sido = +e.target.value; var s = SIDO[state.sido]; state.origin = { lat: s[1], lng: s[2], label: s[3] }; state.mine = false; afterOrigin();
  }
});
var qTimer;
document.addEventListener('input', function (e) {
  if (e.target.id !== 'q') return;
  clearTimeout(qTimer);
  qTimer = setTimeout(function () {
    state.q = e.target.value.trim(); state.shown = CFG.LIST_STEP || 30;
    var pos = e.target.selectionStart; renderPanel(); drawMap(true);
    var q = $('q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (er) {} }
  }, 250);
});
window.addEventListener('hashchange', function () { var v = location.hash.slice(1); if (!NAV.pop && VIEWS.indexOf(v) >= 0 && v !== state.view) go(v); });
var rT; window.addEventListener('resize', function () { clearTimeout(rT); rT = setTimeout(function () { relayout(); if (state.view === 'map' && !state.sel) renderMob(); if (state.view === 'facts' && state.stats) { lineChart(); if ($('sidomore') && $('sidomore').open) barChart(); } }, 200); });
setInterval(function () { if (state.view === 'map' && !state.sel) renderPanelKeepFocus(); }, 60000); // 1분마다 진료 상태 갱신
function renderPanelKeepFocus() { if (document.activeElement && document.activeElement.id === 'q') return; renderPanel(); drawMap(false); }

(function start() {
  var v = location.hash.slice(1);
  try { history.replaceState({ v: 'home' }, '', '#home'); } catch (e) {}   // 바로 들어온 화면에서 뒤로 가면 처음 화면으로
  go(VIEWS.indexOf(v) >= 0 ? v : 'home');
  hitVisit();
  loadKakao();
  var first = true;
  loadData(function () { if (state.view === 'map' && !state.sel) renderPanel(); drawMap(first); first = false; });
  loadSupport();
})();
})();
