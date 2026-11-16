/**
 * 마음쉼표 지도 · 구글 시트 → 웹 데이터(JSON) + 티맵 좌표 채우기
 * 붙여 넣는 곳: 구글 시트 > 확장 프로그램(Extensions) > Apps Script > Code.gs
 *
 * [준비] 시트 메뉴 '마음쉼표 > ① 티맵 키 저장'으로 키를 넣는다. 키를 이 코드나 HTML에 직접 적지 않는다.
 * [주의] 시트 편집 권한이 있는 사람은 스크립트 속성도 볼 수 있다. 시트를 '링크가 있는 모든 사용자 편집'으로 두지 않는다.
 *
 * [티맵 약관 반영] "TMAP Open API로 얻은 데이터는 저장 후 24시간 이상 사용할 수 없음"
 *   → 공공데이터가 준 좌표(HIRA·KHIS)는 그대로 쓰고, 티맵 좌표는 좌표가 없는 행에만 넣는다.
 *   → 티맵 좌표는 '좌표갱신' 시각을 함께 적고, 매일 자동 실행으로 다시 받아 24시간을 넘기지 않는다.
 *   → 24시간이 지난 티맵 좌표는 웹으로 내보내지 않는다.
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
  TMAP_MAX_AGE_H: 23,         // 이 시간이 지나면 다시 받음 (약관 24시간보다 여유 있게)
  TIME_LIMIT_MS: 5 * 60 * 1000, // Apps Script 1회 실행 6분 제한 대비
  CACHE_SEC: 3600
};

/* ───────── 1. 시트 메뉴 ───────── */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('마음쉼표')
    .addItem('① 티맵 키 저장', 'setTmapKey')
    .addItem('② 좌표 비어 있는 행 채우기 (티맵)', 'fillCoords')
    .addItem('③ 매일 자동 갱신 켜기', 'installDailyTrigger')
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
 * 대상: 좌표가 없는 행, 받은 지 23시간이 지난 티맵 좌표, 이전에 변환 실패한 행
 * 공공데이터 좌표(좌표출처=원본·직접입력)는 건드리지 않는다.
 * 50건씩 동시에 요청하고, 결과는 열 단위로 한 번에 기록한다. 6분 안에 못 끝나면 다음 실행에서 이어서 한다. */
var SRC_TMAP = '티맵', SRC_FAIL = '변환실패';

function fillCoords() {
  var key = PropertiesService.getScriptProperties().getProperty('TMAP_KEY');
  if (!key) throw new Error('스크립트 속성에 TMAP_KEY가 없습니다.');

  var sh = sheet_(CFG.FAC_SHEET), idx = ensureCols_(sh), last = sh.getLastRow();
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
    if (s === SRC_TMAP && has && !isStale_(row[idx.at])) return;          // 아직 유효
    todo.push({ r: r, addr: addr });
  });

  var started = Date.now(), now = new Date(), done = 0, fail = 0, B = 50;
  for (var i = 0; i < todo.length; i += B) {
    if (Date.now() - started > CFG.TIME_LIMIT_MS) break;   // 남은 행은 다음 실행에서
    var batch = todo.slice(i, i + B);
    var res = UrlFetchApp.fetchAll(batch.map(function (t) { return tmapReq_(t.addr, key); }));
    res.forEach(function (resp, j) {
      var r = batch[j].r, p = parseTmap_(resp);
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
  Logger.log('대상 ' + todo.length + '건 · 입력 ' + done + ' · 실패 ' + fail + ' · 남음 ' + (todo.length - done - fail));
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
    if (resp.getResponseCode() !== 200) return null;
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
  ScriptApp.newTrigger('fillCoords').timeBased().everyDays(1).atHour(4).create();
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
 * 응답이 커서 90KB씩 나눠 1시간 캐시한다. 좌표 갱신(fillCoords) 때 캐시를 비운다.
 */
function doGet(e) {
  var type = (e && e.parameter.type) === 'stats' ? 'stats' : 'facilities';
  var body = cacheGet_(type);
  if (!body) {
    body = JSON.stringify(type === 'stats' ? stats_() : facilities_());
    cachePut_(type, body);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

var SRC_SHORT = { '건강보험심사평가원_병원정보서비스': '건강보험심사평가원', '전국건강증진센터표준데이터': '지자체 공공데이터' };

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
    var s = r[col[a]], e = r[col[b]];
    return /^\d{1,2}:\d{2}$/.test(s) && /^\d{1,2}:\d{2}$/.test(e) ? [pad_(s), pad_(e)] : null;
  }
  v.forEach(function (r) {
    var id = r[col['기관ID']]; if (!id) return;
    var o = {}, any = false;
    Object.keys(DAY).forEach(function (d) { o[d] = pair(r, DAY[d] + '_시작', DAY[d] + '_종료'); if (o[d]) any = true; });
    if (!any) return;
    o.lunch = pair(r, '평일점심_시작', '평일점심_종료');
    o.lunchSat = pair(r, '토점심_시작', '토점심_종료');
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
function clearWebCache() { CacheService.getScriptCache().removeAll(['facilities_n', 'stats_n']); }

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
function isStale_(t) {
  var d = t instanceof Date ? t : new Date(t);
  return isNaN(d) || (Date.now() - d.getTime()) > CFG.TMAP_MAX_AGE_H * 3600e3;
}
