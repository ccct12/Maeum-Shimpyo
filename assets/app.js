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
  filters: { open: false, night: false, sat: false, free: false },
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
  var c = $('cnt'); if (c && state.data.length) c.textContent = '정신건강의학과와 무료 공공 상담기관 ' + state.data.length.toLocaleString() + '곳';
}
// 저장소 사본을 먼저 보여 주고(빠름), 구글 시트 최신본이 오면 바꿔 끼운다.
function loadData(onReady) {
  var shown = false;
  var fb = getJSON(CFG.FALLBACK_URL, 15000).then(function (j) { if (!shown) { useData(j); shown = true; onReady(); } }).catch(function () {});
  if (!CFG.DATA_URL) return fb.then(function () { if (!shown) { state.loadErr = true; state.data = []; onReady(); } });
  var stamp = new Date().toISOString().slice(0, 13);  // 한 시간 단위로만 새로 받기
  return getJSON(CFG.DATA_URL + (CFG.DATA_URL.indexOf('?') < 0 ? '?' : '&') + 'type=facilities&v=' + stamp, 20000)
    .then(function (j) {
      var keep = state.sel; useData(j); shown = true; state.sel = keep && byId(keep) ? keep : null; onReady();
    })
    .catch(function () { return fb.then(function () { if (!shown) { state.loadErr = true; state.data = []; onReady(); } }); });
}

// 예전 Apps Script(한글 열 이름 그대로)로 배포돼 있어도 읽을 수 있게 맞춘다
var SRC_SHORT = { '건강보험심사평가원_병원정보서비스': '건강보험심사평가원', '전국건강증진센터표준데이터': '지자체 공공데이터' };
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
function kindLabel(f) { return f.c === 'p' ? f.t + (isFree(f) ? ', 무료' : f.cost === '바우처' ? ', 마음투자 바우처' : '') : f.t; }

function visible() {
  var n = now(), F = state.filters, q = state.q.replace(/\s/g, '');
  return (state.data || []).filter(function (f) {
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
function initMap() {
  var km = window.kakao.maps;
  K.map = new km.Map($('kmap'), { center: new km.LatLng(state.origin.lat, state.origin.lng), level: 6 });
  K.map.addControl(new km.ZoomControl(), km.ControlPosition.RIGHT);
  $('kmap').removeAttribute('aria-hidden');
  km.event.addListener(K.map, 'dragend', function () { $('research').hidden = false; });
  drawMap(true);
}
function drawMap(fit) {
  if (!K.map) return;
  var km = window.kakao.maps, n = now();
  K.pins.forEach(function (o) { o.setMap(null); });
  K.pins = [];
  var list = visible().slice(0, state.shown);
  list.forEach(function (f, i) {
    var sel = state.sel === f.id, b = document.createElement('button');
    b.className = 'pin ' + f.c + (sel ? ' sel' : '');
    b.setAttribute('aria-label', (i + 1) + '번 ' + f.n);
    b.innerHTML = '<span class="pn">' + (i + 1) + '</span>' + (sel ? '<span class="pl">' + esc(f.n) + '</span>' : '');
    b.onclick = function () { select(f.id); };
    var o = new km.CustomOverlay({ position: new km.LatLng(f.lat, f.lng), content: b, yAnchor: 1, xAnchor: 0.5, zIndex: sel ? 50 : 10 + (list.length - i), clickable: true });
    o.setMap(K.map); K.pins.push(o);
  });
  if (K.me) K.me.setMap(null);
  var me = document.createElement('div'); me.className = 'me'; me.title = state.origin.label;
  K.me = new km.CustomOverlay({ position: new km.LatLng(state.origin.lat, state.origin.lng), content: me, zIndex: 4 });
  K.me.setMap(K.map);
  if (fit) {
    var bd = new km.LatLngBounds();
    bd.extend(new km.LatLng(state.origin.lat, state.origin.lng));
    list.slice(0, 8).forEach(function (f) { bd.extend(new km.LatLng(f.lat, f.lng)); });
    K.map.setBounds(bd, 40, 40, 40, 40);
  }
}
function relayout() { if (K.map) { K.map.relayout(); } }

/* ───────── 지도 화면 패널 ───────── */
function select(id) {
  state.sel = id;
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

  var list = visible(), F = state.filters;
  var seg = [['all', '전체'], ['m', '병원·의원'], ['p', '상담기관']].map(function (c) {
    return '<button data-kind="' + c[0] + '" aria-pressed="' + (state.kind === c[0]) + '">' + c[1] + '</button>';
  }).join('');
  var chips = [['free', '무료만'], ['open', '지금 여는 곳'], ['night', '저녁 8시 이후'], ['sat', '토요일']].map(function (c) {
    return '<button class="chip" data-f="' + c[0] + '" aria-pressed="' + F[c[0]] + '">' + c[1] + '</button>';
  }).join('');
  var opts = '<option value="">지역 고르기</option>' + SIDO.map(function (s, i) { return '<option value="' + i + '">' + s[0] + '</option>'; }).join('');
  var cards = list.slice(0, state.shown).map(function (f, i) {
    var s = status(f, n);
    return '<li><button class="row" data-id="' + esc(f.id) + '"><span class="rn"><i class="mark ' + f.c + '" aria-hidden="true">' + (i + 1) + '</i>' + esc(f.n) + '</span><span class="rd">' + fmtDist(f._d) + '</span>' +
      '<span class="rs">' + esc(kindLabel(f)) + ', ' + esc(shortAddr(f.a)) + '</span>' +
      (s.k === 'unknown' ? '' : '<span class="st s-' + s.k + '">' + esc(s.t) + '</span>') + '</button></li>';
  }).join('');
  var timeOn = F.open || F.night || F.sat || F.free, hint = '';
  if (!list.length) {
    hint = timeOn
      ? '이 조건에 맞는 곳을 찾지 못했어요. 병원·의원은 아직 진료시간·비용 정보가 없어서 시간 조건과 무료만에서는 빠져요. 조건을 하나 풀어 보세요. 급하면 위의 109로 전화해도 괜찮아요.'
      : '찾는 곳이 없어요. 이름을 다르게 적어 보거나 다른 지역을 골라 보세요.';
  }
  p.innerHTML =
    '<p class="here"><b>' + esc(state.origin.label) + '</b>에서 가까운 순서예요</p>' +
    '<div class="where"><button class="btn solid" id="locate">내 위치에서 찾기</button><select id="sido" aria-label="지역 고르기">' + opts + '</select></div>' +
    '<div class="seg" role="group" aria-label="기관 종류">' + seg + '</div>' +
    '<input class="search" id="q" type="search" placeholder="기관 이름이나 동네로 찾기 (예: 역삼동)" value="' + esc(state.q) + '" aria-label="기관 이름이나 동네로 찾기">' +
    '<div class="filters" role="group" aria-label="조건">' + chips + '</div>' +
    '<p class="meta">' + (state.loadErr ? '기관 정보를 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.' :
      (F.open || F.night || F.sat ? '운영시간 정보가 있는 ' + (state.data || []).filter(function (f) { return f.h; }).length.toLocaleString() + '곳 중 ' : '') + list.length.toLocaleString() + '곳') + '</p>' +
    (list.length ? '<ul class="list">' + cards + '</ul>' : '<p class="empty">' + hint + '</p>') +
    (list.length > state.shown ? '<button class="btn more" id="more">' + Math.min(CFG.LIST_STEP || 30, list.length - state.shown) + '곳 더 보기</button>' : '') +
    '<p class="caution">운영시간은 공공데이터 기준이라 실제와 다를 수 있고, 공휴일은 반영되지 않았어요. 시간이 안 적힌 곳은 가기 전에 전화로 확인해 주세요.</p>' +
    footHTML();
}
function shortAddr(a) { var t = String(a || '').split(',')[0].replace(/\(.*?\)/g, '').trim().split(/\s+/); return t.slice(1, 5).join(' '); }
function footHTML() {
  return '<div class="foot"><span>목록은 거리순으로만 보여줘요. 광고·후기·유료 노출은 없어요.</span>' +
    '<span>기관 정보: 건강보험심사평가원 병원정보서비스, 전국건강증진센터표준데이터(각 지자체). 일부 좌표: TMAP. ' + esc(state.dataNote) + '</span>' +
    '<span>내 위치는 이 기기 안에서 거리 계산에만 쓰고, 어디에도 보내거나 저장하지 않아요. 방문 통계는 날짜별 횟수만 세요.</span></div>';
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
  return '<div class="detail"><button class="textbtn back" id="back">‹ 목록으로</button>' +
    '<div><p class="kind">' + esc(kindLabel(f)) + ', ' + fmtDist(f._d) + '</p><h2>' + esc(f.n) + '</h2></div>' +
    (s.k === 'unknown' ? '' : '<span class="st s-' + s.k + '">' + esc(s.t) + '</span>') +
    '<div class="actions">' + (tel ? '<a class="call" href="tel:' + tel + '">전화하기 ' + esc(f.tel) + '</a>' : '') +
      '<div class="pair"><a href="' + kakao + '" target="_blank" rel="noopener">카카오맵 길찾기</a><a href="' + naver + '" target="_blank" rel="noopener">네이버지도에서 보기</a></div></div>' +
    (tel ? '<p class="note">전화가 부담스러우면 이렇게만 말해도 돼요. "처음인데요, 상담 예약하고 싶어요."</p>' : '') +
    '<div class="rows">' + rows + '</div>' +
    '<div class="rows"><div><span>주소</span><span>' + esc(f.a) + ' <button class="textbtn" id="copy" data-copy="' + esc(f.a) + '">복사</button></span></div>' +
      (web ? '<div><span>홈페이지</span><span><a href="' + esc(web) + '" target="_blank" rel="noopener nofollow">열기</a></span></div>' : '') +
      '<div><span>정보 출처</span><span>' + esc(f.src) + (f.d ? ', ' + esc(f.d) + ' 기준' : '') + '</span></div></div>' +
    '<p class="caution">공공데이터 기준이라 실제와 다를 수 있어요. 첫 방문은 예약이 필요한 곳이 많으니 가기 전에 전화로 확인해 주세요.</p></div>';
}

function useMyLocation() {
  if (!navigator.geolocation) { alert('이 브라우저에서는 위치를 쓸 수 없어요. 지역을 골라 주세요.'); return; }
  var b = $('locate'); if (b) b.textContent = '위치 찾는 중…';
  navigator.geolocation.getCurrentPosition(function (pos) {
    state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: '내 위치' }; state.mine = true;
    afterOrigin();
  }, function () {
    if (b) b.textContent = '내 위치로 찾기';
    alert('위치를 가져오지 못했어요. 위치 권한을 허용하거나, 지역을 골라 주세요.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}
function afterOrigin(fit) { $('research').hidden = true; state.sel = null; state.shown = CFG.LIST_STEP || 30; setDistances(); renderPanel(); drawMap(fit !== false); }

/* ───────── 자가검진 (PHQ-9 · GAD-7 공식 한국어판) ───────── */
// 문항·보기·질문 문장: PHQ-9, GAD-7 공식 한국어판(Korean for Korea) 원문 그대로.
// Pfizer Inc.로부터 교육용 지원금을 받아 Robert L. Spitzer 박사, Janet B.W. Williams 박사, Kurt Kroenke 박사와 동료들에 의해 개발. 복제·번역·전시·배포에 허가가 필요하지 않음.
var TESTS = {
  phq: { name: '우울 살펴보기', sub: 'PHQ-9 · 9문항 · 1~2분쯤',
    stem: '지난 2주일 동안 당신은 다음의 문제들로 인해서 얼마나 자주 방해를 받았습니까?',
    opt: ['전혀 방해 받지 않았다', '며칠 동안 방해 받았다', '7일 이상 방해 받았다', '거의 매일 방해 받았다'],
    q: ['일 또는 여가 활동을 하는 데 흥미나 즐거움을 느끼지 못함', '기분이 가라앉거나, 우울하거나, 희망이 없음', '잠이 들거나 계속 잠을 자는 것이 어려움, 또는 잠을 너무 많이 잠', '피곤하다고 느끼거나 기운이 거의 없음', '입맛이 없거나 과식을 함', '자신을 부정적으로 봄 - 혹은 자신이 실패자라고 느끼거나 자신 또는 가족을 실망시킴', '신문을 읽거나 텔레비전 보는 것과 같은 일에 집중하는 것이 어려움', '다른 사람들이 주목할 정도로 너무 느리게 움직이거나 말을 함. 또는 반대로 평상시보다 많이 움직여서, 너무 안절부절 못하거나 들떠 있음', '자신이 죽는 것이 더 낫다고 생각하거나 어떤 식으로든 자신을 해칠 것이라고 생각함'],
    bands: [[0, '우울 증상이 거의 없는 범위예요'], [5, '가벼운 우울 증상 범위예요'], [10, '중간 정도의 우울 증상 범위예요'], [15, '우울 증상이 꽤 있는 범위예요'], [20, '우울 증상이 많은 범위예요']] },
  gad: { name: '불안 살펴보기', sub: 'GAD-7 · 7문항 · 1분쯤',
    stem: '지난 2주 동안 당신은 다음의 문제들로 인해서 얼마나 자주 방해를 받았습니까?',
    opt: ['전혀 방해 받지 않았다', '며칠 동안 방해 받았다', '2주 중 절반 이상 방해 받았다', '거의 매일 방해 받았다'],
    q: ['초조하거나 불안하거나 조마조마하게 느낀다', '걱정하는 것을 멈추거나 조절할 수가 없다', '여러 가지 것들에 대해 걱정을 너무 많이 한다', '편하게 있기가 어렵다', '너무 안절부절못해서 가만히 있기가 힘들다', '쉽게 짜증이 나거나 쉽게 성을 내게 된다', '마치 끔찍한 일이 생길 것처럼 두렵게 느껴진다'],
    bands: [[0, '불안 증상이 거의 없는 범위예요'], [5, '가벼운 불안 증상 범위예요'], [10, '중간 정도의 불안 증상 범위예요'], [15, '불안 증상이 많은 범위예요']] }
};
var TEST_SRC = '문항: PHQ-9·GAD-7 공식 한국어판. Pfizer Inc.의 교육용 지원금으로 Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke 박사와 동료들이 개발했으며, 복제·번역·전시·배포에 허가가 필요하지 않아요.';
function band(t, score) { var b = t.bands[0]; t.bands.forEach(function (x) { if (score >= x[0]) b = x; }); return b[1]; }
function renderCheck() {
  var el = $('check'), z = state.quiz;
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
      '<div class="opts">' + t.opt.map(function (o, v) { return '<button class="opt" data-ans="' + v + '">' + o + '</button>'; }).join('') + '</div>' +
      (z.test === 'phq' && i === 8 ? '<p class="note">답하기 버겁다면 잠시 멈춰도 괜찮아요. 지금 누군가와 이야기하고 싶다면 <a href="tel:109">109</a>에 전화할 수 있어요. 24시간 받아요.</p>' : '') +
      '<button class="textbtn" id="quit">' + (i ? '‹ 이전 문항으로' : '그만두기') + '</button>';
    var q = $('qtext'); if (q) q.focus();
    return;
  }
  var score = z.ans.reduce(function (a, b) { return a + b; }, 0), max = t.q.length * 3, risk = z.test === 'phq' && z.ans[8] > 0;
  var tier = risk || score >= 15 ? 3 : score >= 10 ? 2 : score >= 5 ? 1 : 0;
  var GUIDE = [
    { p: '지금 답한 내용으로는 증상이 많지 않아요. 그래도 힘들다고 느끼면 그 느낌이 먼저예요.',
      b: [['tobreath', '30초 숨 고르기', 'ghost'], ['tofacts', '나만 이런 걸까요? 숫자로 보기', 'ghost']] },
    { p: '가벼운 신호가 보여요. 잠, 끼니, 짧은 산책처럼 하루의 기본부터 챙겨 보세요. 이런 상태가 2주 넘게 이어지면 상담을 받아 보는 것도 좋은 방법이에요.',
      b: [['tofree', '무료 공공 상담기관 보기', 'primary'], ['tobreath', '30초 숨 고르기', 'ghost']] },
    { p: '전문가와 이야기해 보면 도움이 될 수 있는 신호예요. 정신건강복지센터에서는 비용 부담 없이 첫 상담을 받을 수 있고, 가까운 의원에 예약해도 돼요.',
      b: [['tomap', '가까운 기관 보기', 'primary'], ['tofree', '무료 공공 상담기관만 보기', 'ghost'], ['toguide', '병원이 처음이라 걱정된다면', 'ghost']] },
    { p: '혼자 감당하기에 무거운 상태일 수 있어요. 이번 주 안에 전문가와 이야기해 보길 권해요. 혼자 가기 어렵다면 가족이나 친구에게 같이 가 달라고 하거나, 전화 상담부터 시작해도 괜찮아요.',
      b: [['tomap', '가까운 기관 보기', 'primary'], ['tofree', '무료 공공 상담기관만 보기', 'ghost'], ['toguide', '병원이 처음이라 걱정된다면', 'ghost']] }
  ][tier];
  el.innerHTML = (tier === 3 ? '<div class="help"><p>' + (risk ? '스스로를 해치고 싶은 생각이 들었다고 답해 주셨어요. ' : '') + '혼자 견디지 않아도 돼요. 지금 전화하면 24시간 이야기할 수 있어요.</p><a href="tel:109">109 자살예방 상담전화</a><a href="tel:15770199">1577-0199 정신건강 위기상담</a></div>' : '') +
    '<div class="score"><strong>' + band(t, score) + '</strong><p>' + GUIDE.p + '</p>' +
    '<span class="num">' + t.name + ' · ' + max + '점 중 ' + score + '점. 점수는 상태를 판정하는 게 아니라, 도움을 요청해 볼 만한지 알려 주는 신호예요.</span></div>' +
    GUIDE.b.map(function (x) { return '<button class="' + x[2] + '" id="' + x[0] + '">' + x[1] + '</button>'; }).join('') +
    '<p class="note">이 결과는 진단이 아니에요. 정확한 상태는 전문가와 만나야 알 수 있어요.</p>' +
    '<button class="textbtn" id="again">다른 검진 해 보기</button>' +
    '<p class="caution">' + TEST_SRC + '</p>';
}

/* ───────── 마음 통계 ───────── */
function man(v) { return (v / 10000).toFixed(v >= 1e6 ? 0 : 1).replace(/\.0$/, '') + '만'; }
function man1(v) { return (v / 10000).toFixed(1) + '만'; }
function renderFacts() {
  var el = $('facts'), S = state.stats;
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
      '<div class="fig" id="fig-sido"><h3>시·도별 우울증상 유병률 (2025)</h3><p class="sub">우울증 선별도구(PHQ-9) 10점 이상인 성인 비율</p>' +
        '<svg class="chart" id="c-sido" role="img" aria-label="시도별 우울증상 유병률 막대 그래프"></svg><div class="tip" id="tip-sido"></div>' +
        '<p class="sub">' + esc(S.sido.note) + '</p><p class="src">출처: ' + esc(S.sido.src) + '</p>' +
        tableHTML(S.sido.cols, S.sido.rows.slice().sort(function (a, b) { return b[1] - a[1]; })) + '</div></div>' +

    '<div class="fsec"><h2>많은 사람이 이미 도움을 청하고 있어요</h2>' +
      '<div class="tiles">' + S.tiles.help.map(tile).join('') + '</div>' +
      '<div class="callout"><p>지금 이야기할 곳이 필요하다면</p><div class="actions"><a class="call" href="tel:109">109 자살예방 상담전화</a><div class="pair"><a href="tel:15770199">1577-0199 위기상담</a><a href="tel:1388">1388 청소년 상담</a></div></div></div></div>' +

    '<div class="fsec"><h2>가까운 무료 상담기관, 몰라서 못 가는 경우가 많아요</h2>' +
      '<div class="tiles">' + tile(S.tiles.door) + '</div>' +
      '<p class="lead">정신건강복지센터 같은 공공기관에서는 비용 부담 없이 상담을 시작할 수 있어요.</p>' +
      '<button class="primary" id="factsfree">가까운 무료 공공 상담기관 보기</button></div>' +
    '<p class="caution">통계는 조사마다 대상·연도·지역이 달라요. 각 수치 아래의 출처와 기준을 함께 봐 주세요.</p>';
  lineChart();
  barChart();
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

/* ───────── 숨 고르기: 4초 들이쉬고 6초 내쉬기를 세 번 ───────── */
var breathT = [];
function breathe() {
  var box = $('breathbox'), lung = $('lung'), txt = $('breathtext'), btn = $('breathbtn');
  breathT.forEach(clearTimeout); breathT = [];
  if (btn.getAttribute('aria-expanded') === 'true') { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.textContent = '30초 숨 고르기'; lung.className = 'lung'; return; }
  box.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.textContent = '그만하기';
  var t = 100;
  for (var i = 0; i < 3; i++) {
    breathT.push(setTimeout(function () { lung.className = 'lung in'; txt.textContent = '코로 천천히 들이쉬어요'; }, t)); t += 4000;
    breathT.push(setTimeout(function () { lung.className = 'lung out'; txt.textContent = '입으로 길게 내쉬어요'; }, t)); t += 6000;
  }
  breathT.push(setTimeout(function () { txt.textContent = '잘했어요. 필요하면 한 번 더 해도 돼요.'; btn.textContent = '닫기'; }, t));
}

/* ───────── 방문 집계: 날짜별 횟수만. 누가·어디서 왔는지는 보내지 않는다 ───────── */
function hit(ev) {
  if (!CFG.DATA_URL || /^(localhost|127\.)/.test(location.hostname)) return;
  try { fetch(CFG.DATA_URL + '?type=hit&e=' + encodeURIComponent(ev), { mode: 'no-cors', keepalive: true }); } catch (e) {}
}
function hitVisit() {
  var d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), k = 'ms_day';
  try { if (localStorage.getItem(k) === d) return; localStorage.setItem(k, d); } catch (e) {}
  hit('visit');
}
document.addEventListener('click', function (e) {
  var a = e.target.closest('a[href]'); if (!a) return;
  var h = a.getAttribute('href');
  if (/^tel:(109|15770199|1388)$/.test(h)) hit('crisis');
  else if (h.indexOf('tel:') === 0) hit('tel');
  else if (/map\.kakao\.com\/link\/to|map\.naver\.com/.test(h)) hit('route');
}, true);

/* ───────── 화면 전환 ───────── */
var VIEWS = ['home', 'map', 'check', 'facts', 'guide'];
function go(v) {
  if (state.view !== v || !go.done) hit('view:' + v); go.done = true;
  state.view = v;
  VIEWS.forEach(function (k) { $('v-' + k).classList.toggle('on', k === v); });
  document.querySelectorAll('[data-go]').forEach(function (b) { if (b.tagName === 'BUTTON') { if (b.dataset.go === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); } });
  if (v === 'map') { renderPanel(); setTimeout(relayout, 0); }
  if (v === 'check') renderCheck();
  if (v === 'facts') {
    if (!state.stats) getJSON(CFG.STATS_URL).then(function (j) { state.stats = j; if (state.view === 'facts') renderFacts(); }).catch(function () { $('facts').innerHTML = '<p class="empty">통계를 불러오지 못했어요.</p>'; });
    renderFacts();
  }
  try { if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v); } catch (e) {}
}
function showFreeOnMap() { state.sel = null; state.kind = 'p'; state.filters = { open: false, night: false, sat: false, free: true }; go('map'); drawMap(true); }

document.addEventListener('click', function (e) {
  var b = e.target.closest('button, a[data-go]'); if (!b) return;
  if (b.dataset.go) { e.preventDefault(); return go(b.dataset.go); }
  if (b.dataset.id) return select(b.dataset.id);
  if (b.dataset.kind) { state.kind = b.dataset.kind; state.shown = CFG.LIST_STEP || 30; renderPanel(); return drawMap(true); }
  if (b.id === 'research') { var c = K.map.getCenter(); state.origin = { lat: c.getLat(), lng: c.getLng(), label: '지도 가운데' }; state.mine = false; return afterOrigin(false); }
  if (b.id === 'copy') { var t = b.dataset.copy; if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { b.textContent = '복사했어요'; }); return; }
  if (b.id === 'breathbtn') return breathe();
  if (b.dataset.f) { state.filters[b.dataset.f] = !state.filters[b.dataset.f]; state.shown = CFG.LIST_STEP || 30; renderPanel(); return drawMap(true); }
  if (b.id === 'back') { state.sel = null; renderPanel(); return drawMap(false); }
  if (b.id === 'more') { state.shown += CFG.LIST_STEP || 30; renderPanel(); return drawMap(false); }
  if (b.id === 'locate') return useMyLocation();
  if (b.dataset.test) { state.quiz = { test: b.dataset.test, ans: [] }; return renderCheck(); }
  if (b.dataset.ans) { state.quiz.ans.push(+b.dataset.ans); renderCheck(); $('v-check').scrollTop = 0; return; }
  if (b.id === 'quit') { if (state.quiz.ans.length) state.quiz.ans.pop(); else state.quiz = null; return renderCheck(); }
  if (b.id === 'again') { state.quiz = null; return renderCheck(); }
  if (b.id === 'tomap') { state.sel = null; go('map'); return drawMap(true); }
  if (b.id === 'tofree' || b.id === 'factsfree') return showFreeOnMap();
  if (b.id === 'tofacts') return go('facts');
  if (b.id === 'toguide') return go('guide');
  if (b.id === 'tobreath') { go('home'); var bb = $('breathbtn'); if (bb.getAttribute('aria-expanded') !== 'true') breathe(); setTimeout(function () { bb.scrollIntoView({ block: 'center' }); }, 50); return; }
});
document.addEventListener('change', function (e) {
  if (e.target.id === 'sido' && e.target.value !== '') {
    var s = SIDO[+e.target.value]; state.origin = { lat: s[1], lng: s[2], label: s[3] }; state.mine = false; afterOrigin();
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
window.addEventListener('hashchange', function () { var v = location.hash.slice(1); if (VIEWS.indexOf(v) >= 0 && v !== state.view) go(v); });
var rT; window.addEventListener('resize', function () { clearTimeout(rT); rT = setTimeout(function () { relayout(); if (state.view === 'facts' && state.stats) { lineChart(); barChart(); } }, 200); });
setInterval(function () { if (state.view === 'map' && !state.sel) renderPanelKeepFocus(); }, 60000); // 1분마다 진료 상태 갱신
function renderPanelKeepFocus() { if (document.activeElement && document.activeElement.id === 'q') return; renderPanel(); drawMap(false); }

(function start() {
  var v = location.hash.slice(1);
  go(VIEWS.indexOf(v) >= 0 ? v : 'home');
  hitVisit();
  loadKakao();
  var first = true;
  loadData(function () { if (state.view === 'map' && !state.sel) renderPanel(); drawMap(first); first = false; });
})();
})();
