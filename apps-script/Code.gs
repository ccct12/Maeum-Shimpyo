/**
 * 마음쉼표 지도 · 구글 시트 → 웹 데이터(JSON) + 티맵 좌표 채우기
 * 붙여 넣는 곳: 구글 시트 > 확장 프로그램(Extensions) > Apps Script > Code.gs
 *
 * [준비] 시트 메뉴 '마음쉼표 > ① 티맵 키 저장'으로 키를 넣는다. 키를 이 코드나 HTML에 직접 적지 않는다.
 * [주의] 시트 편집 권한이 있는 사람은 스크립트 속성도 볼 수 있다. 시트를 '링크가 있는 모든 사용자 편집'으로 두지 않는다.
 *
 * [티맵 약관 반영] "TMAP Open API로 얻은 데이터는 저장 후 24시간 이상 사용할 수 없음"
 *   → 공공데이터가 준 좌표(HIRA·KHIS)는 그대로 쓰고, 티맵 좌표는 좌표가 없는 행에만 넣는다.
 *   → 티맵 좌표는 '좌표갱신' 시각을 함께 적고, 6시간마다 자동 실행해 16시간이 지난 좌표를 다시 받는다.
 *     (하루 한 번만 돌리면, 오후에 받은 좌표는 새벽엔 아직 새것이라 건너뛰고 그날 오후에 만료돼 지도에서 빠진다)
 *   → 23시간이 지난 티맵 좌표는 웹으로 내보내지 않는다.
 *   → 티맵이 오류(사용량 초과·키 문제 등)를 돌려주면 기존 값을 지우지 않고 다음 실행에서 다시 시도한다.
 */

var CFG = {
  FAC_SHEET: '기관_마스터',
  STAT_SHEET: '통계_지표',
  COPY_SHEET: '홈페이지_카피_문구',
  COL: {                      // 기관_마스터 1행 머리글
    name: '기관명',
    addr: '도로명주소',
    lat: '위도',
    lng: '경도',
    src: '좌표출처',          // 원본 | 직접입력 | 티맵 | 변환실패
    at:  '좌표갱신',          // 티맵 좌표를 받은 시각 (없으면 맨 끝 열에 자동 추가)
    show: '노출'
  },
  HIDE: ['비고', '검수상태', '출처키', '좌표갱신'], // 웹으로 내보내지 않는 내부 열
  TMAP_MAX_AGE_H: 23,         // 이 시간이 지난 티맵 좌표는 웹으로 내보내지 않음 (약관 24시간보다 여유 있게)
  TMAP_REFRESH_H: 16,         // 이 시간이 지나면 다시 받음 (6시간마다 실행 → 늦어도 22시간 안에 갱신)
  TIME_LIMIT_MS: 5 * 60 * 1000, // Apps Script 1회 실행 6분 제한 대비
  CACHE_SEC: 3600
};

/* ───────── 1. 시트 메뉴 ───────── */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  if (typeof addReviewMenu_ === 'function') addReviewMenu_(ui);   // Review.gs의 검수 도우미 메뉴
  if (typeof addSupportMenu_ === 'function') addSupportMenu_(ui); // Support.gs의 지원사업 메뉴
  ui.createMenu('마음쉼표')
    .addItem('① 티맵 키 저장', 'setTmapKey')
    .addItem('② 좌표 비어 있는 행 채우기 (티맵)', 'fillCoords')
    .addItem('③ 자동 갱신 켜기 (6시간마다)', 'installDailyTrigger')
    .addItem('좌표 결과 점검', 'checkCoords')
    .addItem('웹 데이터 새로고침(캐시 비우기)', 'clearWebCache')
    .addToUi();
}

/* 키는 코드에 적지 않고 입력창으로 받아 스크립트 속성에만 저장한다. */
function setTmapKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('티맵 앱키 저장', '티맵 앱키를 붙여 넣으세요. 코드에는 남지 않고 스크립트 속성에만 저장됩니다.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var k = r.getResponseText().trim();
  if (!/^[A-Za-z0-9]{20,}$/.test(k)) { ui.alert('키 형식이 올바르지 않습니다.'); return; }
  PropertiesService.getScriptProperties().setProperty('TMAP_KEY', k);
  ui.alert('저장했습니다. 이제 ② 좌표 채우기를 실행하세요.');
}

/* ───────── 2. 티맵 좌표 채우기 ─────────
 * 대상: 좌표가 없는 행, 노출 중인 기관의 받은 지 16시간이 지난 티맵 좌표, 이전에 변환 실패한 행
 * (노출하지 않는 기관의 티맵 좌표는 쓰지 않으므로 다시 받지 않는다. 노출로 바꾸면 다음 실행에서 갱신된다)
 * 공공데이터 좌표(좌표출처=원본·직접입력)는 건드리지 않는다.
 * 50건씩 동시에 요청하고, 결과는 열 단위로 한 번에 기록한다. 6분 안에 못 끝나면 다음 실행에서 이어서 한다. */
var SRC_TMAP = '티맵', SRC_FAIL = '변환실패';

function fillCoords() {
  var key = PropertiesService.getScriptProperties().getProperty('TMAP_KEY');
  if (!key) throw new Error('스크립트 속성에 TMAP_KEY가 없습니다.');

  var sh = sheet_(CFG.FAC_SHEET), idx = ensureCols_(sh), last = sh.getLastRow();
  var showCol = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String).indexOf(CFG.COL.show);
  if (last < 2) return;
  var n = last - 1;
  var data = sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
  var lat = data.map(function (r) { return [r[idx.lat]]; }), lng = data.map(function (r) { return [r[idx.lng]]; });
  var src = data.map(function (r) { return [r[idx.src]]; }), at = data.map(function (r) { return [r[idx.at]]; });

  var todo = [];
  data.forEach(function (row, r) {
    var s = String(row[idx.src] || '').trim(), has = isNum_(row[idx.lat]) && isNum_(row[idx.lng]);
    var addr = String(row[idx.addr] || '').trim();
    if (!addr) return;
    if (has && s !== SRC_TMAP) { if (!s) src[r][0] = '원본'; return; }   // 원본 좌표 유지
    var shown = showCol < 0 || String(row[showCol]).toUpperCase() === 'TRUE';
    if (s === SRC_TMAP && has && (!shown || !isStale_(row[idx.at], CFG.TMAP_REFRESH_H))) return;   // 아직 유효하거나 노출 안 함
    todo.push({ r: r, addr: addr });
  });

  var started = Date.now(), now = new Date(), done = 0, fail = 0, err = 0, B = 50;
  for (var i = 0; i < todo.length; i += B) {
    if (Date.now() - started > CFG.TIME_LIMIT_MS) break;   // 남은 행은 다음 실행에서
    var batch = todo.slice(i, i + B);
    var res = UrlFetchApp.fetchAll(batch.map(function (t) { return tmapReq_(t.addr, key); }));
    res.forEach(function (resp, j) {
      var r = batch[j].r, p = parseTmap_(resp);
      if (p && p.err) { err++; return; }        // 티맵 오류: 기존 값 그대로 두고 다음에 다시
      if (p) { lat[r][0] = p.lat; lng[r][0] = p.lng; src[r][0] = SRC_TMAP; at[r][0] = now; done++; }
      else   { lat[r][0] = ''; lng[r][0] = ''; src[r][0] = SRC_FAIL; at[r][0] = ''; fail++; }
    });
    Utilities.sleep(300);
  }
  // 열 단위로 한 번에 기록
  sh.getRange(2, idx.lat + 1, n, 1).setValues(lat);
  sh.getRange(2, idx.lng + 1, n, 1).setValues(lng);
  sh.getRange(2, idx.src + 1, n, 1).setValues(src);
  sh.getRange(2, idx.at + 1, n, 1).setValues(at);
  clearWebCache();
  Logger.log('대상 ' + todo.length + '건 · 입력 ' + done + ' · 주소 못 찾음 ' + fail + ' · 티맵 오류 ' + err + ' · 남음 ' + (todo.length - done - fail - err));
  return { todo: todo.length, done: done, fail: fail, err: err };
}

function tmapReq_(addr, key) {
  return {
    url: 'https://apis.openapi.sk.com/tmap/geo/fullAddrGeo?version=1&format=json'
       + '&coordType=WGS84GEO&addressFlag=F00&fullAddr=' + encodeURIComponent(cleanAddr_(addr)),
    headers: { appKey: key }, muteHttpExceptions: true
  };
}
function cleanAddr_(a) {           // 괄호 속 동·건물명과 층·호수는 빼고 보냄
  return a.replace(/\(.*?\)/g, ' ').replace(/\s\d+층.*$|\s\d+호.*$/, '').replace(/\s+/g, ' ').trim();
}
function parseTmap_(resp) {
  try {
    var code = resp.getResponseCode();
    if (code === 204) return null;                                       // 주소를 못 찾음
    if (code !== 200) return { err: code };                              // 사용량 초과·키 오류 등
    var c = JSON.parse(resp.getContentText()).coordinateInfo.coordinate[0];
    var lat = parseFloat(c.newLat || c.lat), lng = parseFloat(c.newLon || c.lon);
    if (!(lat > 33 && lat < 39 && lng > 124 && lng < 132)) return null;  // 대한민국 범위 밖이면 오류로 봄
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  } catch (e) { return null; }
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'fillCoords') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('fillCoords').timeBased().everyHours(6).create();
}

function checkCoords() {
  var sh = sheet_(CFG.FAC_SHEET), idx = ensureCols_(sh);
  var v = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), sh.getLastColumn()).getValues();
  var n = { 원본: 0, 직접입력: 0, 티맵: 0, 변환실패: 0, 비어있음: 0 };
  v.forEach(function (r) { var s = String(r[idx.src] || '') || '비어있음'; n[s] = (n[s] || 0) + 1; });
  SpreadsheetApp.getUi().alert(JSON.stringify(n, null, 1));
}

/* ───────── 3. 웹으로 내보내기 (웹 앱으로 배포 후 사이트가 호출) ─────────
 *   .../exec?type=facilities  → 노출=TRUE 기관 (짧은 키 JSON + 진료시간)
 *   .../exec?type=stats       → 화면사용=TRUE 통계 + 카피 문구
 *   .../exec?type=support     → 지원사업 탭에서 노출=TRUE인 심리지원 사업 (Support.gs)
 * 응답이 커서 90KB씩 나눠 1시간 캐시한다. 좌표 갱신(fillCoords) 때 캐시를 비운다.
 */
function doGet(e) {
  if (e && e.parameter.type === 'hit') return hit_(e.parameter);
  var t = e && e.parameter.type, type = t === 'stats' || t === 'support' ? t : 'facilities';
  var body = cacheGet_(type);
  if (!body) {
    body = JSON.stringify(type === 'stats' ? stats_() : type === 'support' ? support_() : facilities_());
    cachePut_(type, body);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

var SRC_SHORT = { '건강보험심사평가원_병원정보서비스': '건강보험심사평가원', '전국건강증진센터표준데이터': '지자체 공공데이터' };

/* 이용자분류 → 짧은 키. 정신건강의학과 진료·상담·보건소는 기본 노출이라 키를 붙이지 않는다. */
var GROUP_SHORT = { '요양·재활·생활시설': 'care', '일반 병의원·보건기관': 'gen', '진료과목 확인 필요': 'unk' };

function facilities_() {
  var C = CFG.COL, hours = hours_(), out = [];
  table_(CFG.FAC_SHEET).forEach(function (r) {
    if (String(r[C.show]).toUpperCase() !== 'TRUE') return;          // 노출=TRUE만
    if (!isNum_(r[C.lat]) || !isNum_(r[C.lng])) return;
    if (r[C.src] === SRC_FAIL) return;
    if (r[C.src] === SRC_TMAP && isStale_(r[C.at])) return;          // 24시간 지난 티맵 좌표 제외
    var o = {
      id: r['기관ID'], c: r['부류'] === '의료' ? 'm' : 'p', t: r['기관구분'], n: r[C.name],
      a: r[C.addr], lat: +(+r[C.lat]).toFixed(6), lng: +(+r[C.lng]).toFixed(6),
      tel: r['전화'] || '', web: r['홈페이지'] || '', cost: r['비용구분'] || '',
      src: SRC_SHORT[r['출처']] || r['출처'] || '', d: String(r['데이터기준일'] || '').slice(0, 10)
    };
    if (hours[o.id]) o.h = hours[o.id];
    var g = GROUP_SHORT[String(r['이용자분류'] || '').trim()];
    if (g) o.g = g;                                                  // 기본 노출 외 그룹만 표시 (비어 있으면 기본)
    out.push(o);
  });
  return { asOf: new Date().toISOString(), count: out.length, items: out };
}

/* 진료시간 탭 → { 기관ID: {mon:["09:00","18:00"], ..., lunch:[..], lunchSat:[..], holOff:true, note:"" } } */
function hours_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('진료시간');
  if (!sh || sh.getLastRow() < 2) return {};
  var v = sh.getDataRange().getDisplayValues(), h = v.shift(), col = {};
  h.forEach(function (k, i) { col[k] = i; });
  var DAY = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' }, out = {};
  function pair(r, a, b) {
    var s = String(r[col[a]] || '').trim(), e = String(r[col[b]] || '').trim();
    if (/^\d{1,2}:\d{2}$/.test(s) && /^\d{1,2}:\d{2}$/.test(e)) return [pad_(s), pad_(e)];
    return (!s && !e) ? '?' : null;            // 둘 다 비어 있으면 '모름', '휴진' 등은 쉬는 날
  }
  v.forEach(function (r) {
    var id = r[col['기관ID']]; if (!id) return;
    var o = {}, any = false;
    Object.keys(DAY).forEach(function (d) { o[d] = pair(r, DAY[d] + '_시작', DAY[d] + '_종료'); if (Array.isArray(o[d])) any = true; });
    if (!any) return;
    o.lunch = pair(r, '평일점심_시작', '평일점심_종료'); if (!Array.isArray(o.lunch)) o.lunch = null;
    o.lunchSat = pair(r, '토점심_시작', '토점심_종료'); if (!Array.isArray(o.lunchSat)) o.lunchSat = null;
    o.holOff = String(r[col['공휴일휴진']]).toUpperCase() === 'TRUE';
    if (r[col['접수안내']]) o.note = r[col['접수안내']];
    out[id] = o;
  });
  return out;
}
function pad_(t) { return t.length === 4 ? '0' + t : t; }

function stats_() {
  var s = table_(CFG.STAT_SHEET).filter(function (r) {
    return r['화면사용'] === true || String(r['화면사용']).toUpperCase() === 'TRUE';
  });
  var copy = SpreadsheetApp.getActive().getSheetByName(CFG.COPY_SHEET) ? table_(CFG.COPY_SHEET) : [];
  return { asOf: new Date().toISOString(), indicators: s, copy: copy };
}

function cachePut_(key, body) {
  var c = CacheService.getScriptCache(), n = Math.ceil(body.length / 90000), m = {};
  if (n > 90) return;                                   // 8MB 넘으면 캐시하지 않음
  for (var i = 0; i < n; i++) m[key + '_' + i] = body.substr(i * 90000, 90000);
  m[key + '_n'] = String(n);
  c.putAll(m, CFG.CACHE_SEC);
}
function cacheGet_(key) {
  var c = CacheService.getScriptCache(), n = +c.get(key + '_n');
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = c.getAll(keys), parts = [];
  for (var j = 0; j < n; j++) { if (got[keys[j]] == null) return null; parts.push(got[keys[j]]); }
  return parts.join('');
}
function clearWebCache() { CacheService.getScriptCache().removeAll(['facilities_n', 'stats_n', 'support_n']); }

/* ───────── 의견 받기 ─────────
 * 사이트의 '이 기관 정보가 달라요'와 '알려 주세요'가 POST로 보낸다. '의견_접수' 탭에 한 줄씩 쌓는다.
 * - 이메일은 선택. 답장에만 쓰고 처리가 끝나면 지운다(사이트 안내 문구와 같게 운영).
 * - 봇이 채우는 숨은 칸(hp)이 차 있으면 저장하지 않는다. 시간당 FB_MAX_PER_HOUR건까지만 받는다.
 * - 셀이 수식으로 실행되지 않게 =,+,-,@로 시작하는 값은 글자로 저장한다.
 */
var FB_SHEET = '의견_접수', FB_MAX_PER_HOUR = 60;
var FB_TYPES = { fix: '기관 정보 오류', idea: '사이트 개선 의견', pro: '전문가·기관 연락' };
var FB_HEAD = ['접수일시', '종류', '기관ID', '기관명', '항목', '내용', '이메일(선택)', '처리상태', '메모'];

function doPost(e) {
  var out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  var d;
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out({ ok: false, e: 'bad' }); }
  if (d.hp) return out({ ok: true });                                  // 봇: 저장하지 않고 성공처럼 응답
  if (!FB_TYPES[d.type]) return out({ ok: false, e: 'type' });
  var text = clip_(d.text, 1000), email = clip_(d.email, 100), item = clip_(d.item, 30), id = clip_(d.id, 12), name = clip_(d.name, 80);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return out({ ok: false, e: 'email' });
  if (d.type === 'fix' ? !(item || text) : !text) return out({ ok: false, e: 'empty' });
  if (id && !/^[A-Z]-\d{3,6}$/.test(id)) id = '';
  var cache = CacheService.getScriptCache(), hk = 'fb_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMddHH'), n = +(cache.get(hk) || 0);
  if (n >= FB_MAX_PER_HOUR) return out({ ok: false, e: 'busy' });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return out({ ok: false, e: 'busy' });
  try {
    var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(FB_SHEET);
    if (!sh) { sh = ss.insertSheet(FB_SHEET); sh.appendRow(FB_HEAD); sh.setFrozenRows(1); }
    sh.appendRow([new Date(), FB_TYPES[d.type], id, safe_(name), safe_(item), safe_(text), safe_(email), '접수', '']);
    cache.put(hk, String(n + 1), 3700);
  } finally { lock.releaseLock(); }
  return out({ ok: true });
}
function clip_(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim().slice(0, n); }
function safe_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

/* ───────── 방문자 집계 ─────────
 * 사이트가 ?type=hit&e=<이벤트> 로 부른다. 모두 '날짜별·시간대별 횟수'로만 센다.
 * IP·기기 정보·위치·자가검진 응답은 받지도 저장하지도 않는다.
 * - open  : 페이지를 연 횟수(접속). 시간대별로도 센다(방문_시간대 탭)
 * - visit : 기기별 하루 첫 접속(순 방문자). 함께 오는 값은 분류 이름뿐이다
 *           nw=1/0 (이 기기에서 처음/다시), dv=pc/m (PC/모바일), src=direct/kakao/search/sns/etc (들어온 경로)
 * 열이 없으면 '방문_기록' 1행 끝에 자동으로 추가한다.
 */
var HIT_COL = {
  visit: '방문', open: '접속', 'view:home': '처음', 'view:map': '기관 찾기', 'view:check': '마음 살펴보기',
  'view:rest': '마음 쉬기', 'view:ask': '알려 주세요', 'view:facts': '마음 통계', 'view:guide': '병원이 처음이라면',
  'view:support': '지원 제도', tel: '기관 전화', route: '길찾기', crisis: '위기상담 전화',
  'tri:calm': '3갈래_버거워요', 'tri:find': '3갈래_찾기'
};
var HIT_DV = { pc: 'PC', m: '모바일' };
var HIT_SRC = { direct: '유입_직접', kakao: '유입_카카오톡', search: '유입_검색', sns: '유입_SNS', etc: '유입_기타' };

function hit_(p) {
  p = p || {};
  var ev = String(p.e || ''), add = {}, pre = '';
  // 시제품 첫 화면(v2)은 'v2:<이벤트>'로 온다. 같은 이름 앞에 'v2 '를 붙인 열에 따로 센다(본 사이트 숫자와 섞지 않음)
  var vm = ev.match(/^(v2):(.+)$/); if (vm) { pre = vm[1] + ' '; ev = vm[2]; }
  var name = HIT_COL[ev];
  if (!name) return ContentService.createTextOutput('ok');
  add[pre + name] = 1;
  if (ev.indexOf('view:') === 0) add[pre + '화면 보기'] = 1;
  if (!pre && ev === 'visit') {
    if (p.nw === '1') add['신규'] = 1; else if (p.nw === '0') add['재방문'] = 1;
    if (HIT_DV[p.dv]) add[HIT_DV[p.dv]] = 1;
    if (HIT_SRC[p.src]) add[HIT_SRC[p.src]] = 1;
  }
  var lock = LockService.getScriptLock();
  if (lock.tryLock(3000)) {
    try {
      var now = new Date(), today = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
      bumpRow_('방문_기록', today, add);
      if (!pre && ev === 'open') { var h = {}; h[Utilities.formatDate(now, 'Asia/Seoul', 'H') + '시'] = 1; bumpRow_('방문_시간대', today, h); }
    } finally { lock.releaseLock(); }
  }
  return ContentService.createTextOutput('ok');
}
// 날짜 행을 찾아(없으면 만들어) 지정한 열들을 한 번에 올린다. 열이 없으면 머리글 끝에 추가.
function bumpRow_(tab, day, add) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tab);
  if (!sh) return;
  var lastCol = sh.getLastColumn(), head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  Object.keys(add).forEach(function (k) {
    if (head.indexOf(k) < 0) {
      if (head.length >= sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
      sh.getRange(1, head.length + 1).setValue(k); head.push(k);
    }
  });
  var n = Math.max(sh.getLastRow() - 1, 1), dates = sh.getRange(2, 1, n, 1).getDisplayValues().map(function (r) { return r[0]; });
  var row = dates.indexOf(day) + 2, vals;
  if (row < 2) {
    row = dates.indexOf('') + 2; if (row < 2) row = dates.length + 2;
    vals = head.map(function (h, i) { return i ? 0 : day; });
    sh.getRange(row, 1).setNumberFormat('@');
  } else vals = sh.getRange(row, 1, 1, head.length).getValues()[0];
  Object.keys(add).forEach(function (k) { var c = head.indexOf(k); vals[c] = (+vals[c] || 0) + add[k]; });
  sh.getRange(row, 1, 1, head.length).setValues([vals]);
}

/* ───────── 도우미 ───────── */
function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('"' + name + '" 탭이 없습니다. CFG 이름을 확인하세요.');
  return sh;
}
function ensureCols_(sh) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String), idx = {};
  ['name', 'addr', 'lat', 'lng', 'src', 'at'].forEach(function (k) {
    var i = head.indexOf(CFG.COL[k]);
    if (i < 0) {
      if (k === 'name' || k === 'addr') throw new Error('머리글 "' + CFG.COL[k] + '"이 없습니다.');
      sh.getRange(1, head.length + 1).setValue(CFG.COL[k]);   // 위도·경도·좌표출처·좌표갱신만 끝에 추가
      head.push(CFG.COL[k]); i = head.length - 1;
    }
    idx[k] = i;
  });
  return idx;
}
function table_(name) {
  var v = sheet_(name).getDataRange().getValues(), h = v.shift();
  return v.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {}; h.forEach(function (k, i) { if (k !== '') o[k] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
    return o;
  });
}
function isNum_(x) { return x !== '' && x !== null && !isNaN(parseFloat(x)); }
function isStale_(t, h) {
  var d = t instanceof Date ? t : new Date(t);
  return isNaN(d) || (Date.now() - d.getTime()) > (h || CFG.TMAP_MAX_AGE_H) * 3600e3;
}
