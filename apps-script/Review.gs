/**
 * 마음쉼표 · 검수 도우미 (Review.gs)
 * 붙여 넣는 곳: Apps Script 편집기 > 파일 + > 스크립트 > 이름 "Review" (Code.gs와 함께 둔다)
 *
 * 하는 일
 *  ① 검수 탭 만들기: 아직 노출되지 않은 상담기관을 지역 순으로 모으고,
 *     줄마다 네이버지도·카카오맵 검색 링크를 붙인다.
 *  ② 사람이 링크를 열어 확인하고 결과·전화·운영시간을 적는다.
 *  ③ 검수 결과 반영: 적은 내용을 기관_마스터(노출·검수상태·전화)와 진료시간 탭에 옮긴다.
 *
 * 네이버에서 자동으로 가져오지 않는 이유
 *  - 네이버 검색 API(지역 검색)는 이름·주소·전화·분류만 주고 운영시간은 주지 않는다.
 *  - 네이버 지도 화면을 프로그램으로 긁어 오는 것은 네이버 약관에서 금지한다.
 *  - 검색 API 결과도 약관상 시트(DB)에 쌓아 두는 용도로 쓰기 어렵다.
 *  그래서 이 도구는 "링크를 열어 사람이 확인하고, 확인한 사실만 적는" 방식이다.
 */

var RV = {
  SHEET: '검수',
  HOURS: '진료시간',
  HEAD: ['기관ID', '부류', '기관구분', '기관명', '시도', '시군구', '도로명주소', '전화(지금)',
         '네이버지도', '카카오맵', '결과', '전화(확인)', '평일 시작', '평일 종료', '토 시작', '토 종료',
         '점심 시작', '점심 종료', '메모', '반영일'],
  RESULTS: ['운영 중', '폐업·찾을 수 없음', '주소가 다름(이전)', '보류'],
  GROUPS: {
    '1': { label: '공공 센터·보건소', types: ['정신건강복지센터', '정신건강복지센터(광역)', '자살예방센터', '중독관리통합지원센터', '보건소', '기타 정신보건기관'] },
    '2': { label: '마음투자 바우처 민간 상담기관', types: ['민간 상담기관'] },
    '3': { label: '정신재활·요양시설', types: ['정신재활시설', '정신요양시설'] }
  }
};

function addReviewMenu_(ui) {
  ui.createMenu('검수 도우미')
    .addItem('① 검수 탭에 대상 불러오기', 'makeReviewSheet')
    .addItem('② 검수 결과를 기관_마스터에 반영', 'applyReview')
    .addSeparator()
    .addItem('사용법 보기', 'reviewHelp')
    .addToUi();
}

function reviewHelp() {
  SpreadsheetApp.getUi().alert('검수 도우미 사용법',
    '1) ① 메뉴로 확인할 기관을 검수 탭에 불러옵니다.\n' +
    '2) 줄마다 [네이버지도] 링크를 열어 같은 기관이 있는지 봅니다.\n' +
    '3) 결과 칸에서 운영 중 / 폐업·찾을 수 없음 / 주소가 다름(이전) / 보류 중 하나를 고릅니다.\n' +
    '4) 운영 중이면 전화와 운영시간을 적습니다. 시간은 09:00처럼 적고, 토요일에 쉬면 토요일 칸은 비워 둡니다.\n' +
    '5) ② 메뉴를 누르면 무엇이 바뀌는지 먼저 보여 주고, 확인을 누르면 반영합니다.\n\n' +
    '네이버지도의 운영시간도 틀릴 수 있어요. 애매하면 전화로 확인하거나 보류로 두세요.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/* ───────── ① 검수 탭 만들기 ───────── */
function makeReviewSheet() {
  var ui = SpreadsheetApp.getUi();
  var ask = ui.prompt('검수할 기관 고르기',
    '아직 지도에 나오지 않는(노출=FALSE) 상담기관 중 어떤 묶음을 불러올까요?\n\n' +
    '1 = 공공 센터·보건소 (추천: 무료, 폐업이 드묾)\n2 = 마음투자 바우처 민간 상담기관\n3 = 정신재활·요양시설\n\n' +
    '숫자를 적고, 특정 지역만 하려면 뒤에 시도를 적으세요. 예) 1 서울',
    ui.ButtonSet.OK_CANCEL);
  if (ask.getSelectedButton() !== ui.Button.OK) return;
  var parts = ask.getResponseText().trim().split(/\s+/), g = RV.GROUPS[parts[0]], sido = parts[1] || '';
  if (!g) { ui.alert('1, 2, 3 중 하나를 적어 주세요.'); return; }

  var ss = SpreadsheetApp.getActive(), rs = ss.getSheetByName(RV.SHEET) || newReviewSheet_(ss);
  var have = {};
  if (rs.getLastRow() > 1) rs.getRange(2, 1, rs.getLastRow() - 1, 1).getValues().forEach(function (r) { have[r[0]] = true; });

  var M = readMaster_(), add = [];
  M.rows.forEach(function (r) {
    if (r['부류'] !== '상담·지원' || isTrue_(r['노출'])) return;
    if (g.types.indexOf(r['기관구분']) < 0) return;
    if (sido && String(r['시도']).indexOf(sido) < 0) return;
    if (r['검수상태'] === '폐업의심' || r['검수상태'] === '제외') return;
    if (have[r['기관ID']]) return;
    add.push(r);
  });
  add.sort(function (a, b) { return (a['시도'] + a['시군구'] + a['기관명']).localeCompare(b['시도'] + b['시군구'] + b['기관명'], 'ko'); });
  if (!add.length) { ui.alert('새로 불러올 기관이 없어요. 이미 검수 탭에 있거나 모두 노출 중이에요.'); return; }

  var start = rs.getLastRow() + 1;
  var vals = add.map(function (r, i) {
    var row = start + i, q = 'D' + row + '&" "&F' + row;
    return [r['기관ID'], r['부류'], r['기관구분'], r['기관명'], r['시도'], r['시군구'], r['도로명주소'], r['전화'] || '',
      '=HYPERLINK("https://map.naver.com/p/search/"&ENCODEURL(' + q + '),"네이버지도")',
      '=HYPERLINK("https://map.kakao.com/?q="&ENCODEURL(' + q + '),"카카오맵")',
      '', '', '', '', '', '', '', '', '', ''];
  });
  rs.getRange(start, 1, vals.length, RV.HEAD.length).setValues(vals);
  ui.alert(g.label + (sido ? ' (' + sido + ')' : '') + ' ' + vals.length + '곳을 검수 탭에 불러왔어요.');
  rs.activate();
}

function newReviewSheet_(ss) {
  var rs = ss.insertSheet(RV.SHEET);
  rs.getRange(1, 1, 1, RV.HEAD.length).setValues([RV.HEAD]).setFontWeight('bold').setBackground('#DCE8E0');
  rs.setFrozenRows(1); rs.setFrozenColumns(4);
  var n = rs.getMaxRows() - 1;
  rs.getRange(2, 11, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(RV.RESULTS, true).setAllowInvalid(false).build());
  rs.getRange(2, 12, n, 7).setNumberFormat('@');            // 전화·시간은 글자로 (09:00이 시각 값으로 바뀌지 않게)
  var w = [70, 60, 110, 220, 90, 90, 260, 110, 80, 70, 130, 110, 70, 70, 70, 70, 70, 70, 200, 90];
  w.forEach(function (px, i) { rs.setColumnWidth(i + 1, px); });
  rs.getRange('A:H').setFontColor('#586861');
  rs.getRange(1, 11, 1, 9).setBackground('#F5E7CB');         // 사람이 적는 칸
  return rs;
}

/* ───────── ② 검수 결과 반영 ───────── */
function applyReview() {
  var ui = SpreadsheetApp.getUi(), ss = SpreadsheetApp.getActive(), rs = ss.getSheetByName(RV.SHEET);
  if (!rs || rs.getLastRow() < 2) { ui.alert('검수 탭이 비어 있어요. ① 메뉴로 먼저 불러오세요.'); return; }
  var data = rs.getRange(2, 1, rs.getLastRow() - 1, RV.HEAD.length).getDisplayValues();
  var C = {}; RV.HEAD.forEach(function (h, i) { C[h] = i; });

  var todo = [], bad = [];
  data.forEach(function (r, i) {
    if (!r[C['결과']] || r[C['반영일']]) return;
    var t = ['평일 시작', '평일 종료', '토 시작', '토 종료', '점심 시작', '점심 종료'].map(function (k) { return normTime_(r[C[k]]); });
    var wrong = t.some(function (x) { return x === false; }) || (!!t[0] !== !!t[1]) || (!!t[2] !== !!t[3]) || (!!t[4] !== !!t[5]);
    if (wrong) { bad.push((i + 2) + '행 ' + r[C['기관명']]); return; }
    todo.push({ row: i + 2, id: r[C['기관ID']], name: r[C['기관명']], res: r[C['결과']], tel: r[C['전화(확인)']].trim(), t: t, memo: r[C['메모']] });
  });
  if (bad.length) { ui.alert('시간을 고쳐 주세요 (09:00 형식, 시작·종료는 둘 다 적기)', bad.slice(0, 15).join('\n') + (bad.length > 15 ? '\n…외 ' + (bad.length - 15) + '곳' : ''), ui.ButtonSet.OK); return; }
  if (!todo.length) { ui.alert('반영할 줄이 없어요. 결과 칸을 고른 줄만 반영해요.'); return; }

  var cnt = {}; todo.forEach(function (x) { cnt[x.res] = (cnt[x.res] || 0) + 1; });
  var withHours = todo.filter(function (x) { return x.res === '운영 중' && x.t[0]; }).length;
  var msg = '아래처럼 바꿉니다.\n\n' +
    '운영 중 ' + (cnt['운영 중'] || 0) + '곳 → 노출 켬, 검수상태 확인' + (withHours ? ' (운영시간 ' + withHours + '곳 기록)' : '') + '\n' +
    '폐업·찾을 수 없음 ' + (cnt['폐업·찾을 수 없음'] || 0) + '곳 → 검수상태 폐업의심, 노출 끔\n' +
    '주소가 다름 ' + (cnt['주소가 다름(이전)'] || 0) + '곳 → 노출 끔, 비고에 메모\n' +
    '보류 ' + (cnt['보류'] || 0) + '곳 → 바꾸지 않음\n\n진행할까요?';
  if (ui.alert('검수 결과 반영', msg, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var M = readMaster_(), idx = {};
  M.rows.forEach(function (r, i) { idx[r['기관ID']] = i; });
  var col = function (k) { return M.head.indexOf(k); };
  var cols = ['검수상태', '노출', '전화', '비고'], arr = {};
  cols.forEach(function (k) { arr[k] = M.sheet.getRange(2, col(k) + 1, M.rows.length, 1).getValues(); });
  var trueVal = typeof arr['노출'][0][0] === 'boolean' ? true : 'TRUE', falseVal = trueVal === true ? false : 'FALSE';
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'), hoursTodo = [], miss = [];

  todo.forEach(function (x) {
    var i = idx[x.id]; if (i === undefined) { miss.push(x.name); return; }
    var note = String(arr['비고'][i][0] || '');
    if (x.res === '운영 중') {
      arr['검수상태'][i][0] = '확인'; arr['노출'][i][0] = trueVal;
      if (x.tel) arr['전화'][i][0] = x.tel;
      arr['비고'][i][0] = (note ? note + ' / ' : '') + today + ' 지도 검색으로 운영 확인' + (x.memo ? ': ' + x.memo : '');
      if (x.t[0]) hoursTodo.push(x);
    } else if (x.res === '폐업·찾을 수 없음') {
      arr['검수상태'][i][0] = '폐업의심'; arr['노출'][i][0] = falseVal;
      arr['비고'][i][0] = (note ? note + ' / ' : '') + today + ' 지도 검색에서 찾을 수 없음' + (x.memo ? ': ' + x.memo : '');
    } else if (x.res === '주소가 다름(이전)') {
      arr['노출'][i][0] = falseVal;
      arr['비고'][i][0] = (note ? note + ' / ' : '') + today + ' 주소가 다름(이전 의심)' + (x.memo ? ': ' + x.memo : '');
    }
  });
  cols.forEach(function (k) { M.sheet.getRange(2, col(k) + 1, M.rows.length, 1).setValues(arr[k]); });
  if (hoursTodo.length) writeHours_(hoursTodo, today);

  todo.forEach(function (x) { if (x.res !== '보류') rs.getRange(x.row, RV.HEAD.length).setValue(today); });
  logChange_(today, todo.length, cnt, hoursTodo.length);
  if (typeof clearWebCache === 'function') clearWebCache();
  ui.alert('반영했어요. ' + (miss.length ? '\n기관_마스터에서 못 찾은 곳: ' + miss.join(', ') : '') + '\n사이트에는 1시간 안에(캐시) 나타나요.');
}

/* 진료시간 탭: 같은 기관ID가 있으면 덮어쓰고, 없으면 아래에 추가 */
function writeHours_(list, today) {
  var hs = SpreadsheetApp.getActive().getSheetByName(RV.HOURS);
  var head = hs.getRange(1, 1, 1, hs.getLastColumn()).getValues()[0];
  var H = {}; head.forEach(function (h, i) { H[h] = i; });
  var ids = hs.getLastRow() > 1 ? hs.getRange(2, 1, hs.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  list.forEach(function (x) {
    var row = head.map(function () { return ''; });
    row[H['기관ID']] = x.id; row[H['기관명']] = x.name;
    ['월', '화', '수', '목', '금'].forEach(function (d) { row[H[d + '_시작']] = x.t[0]; row[H[d + '_종료']] = x.t[1]; });
    row[H['토_시작']] = x.t[2] || '휴진'; row[H['토_종료']] = x.t[3] || '휴진';
    row[H['일_시작']] = '휴진'; row[H['일_종료']] = '휴진';
    if (x.t[4]) { row[H['평일점심_시작']] = x.t[4]; row[H['평일점심_종료']] = x.t[5]; }
    row[H['일요일휴진']] = 'TRUE'; row[H['공휴일휴진']] = 'TRUE';
    row[H['휴무일_원문']] = '지도 검색으로 확인(' + (x.t[2] ? '일·공휴일 휴무로 가정' : '토·일·공휴일 휴무로 가정') + ')';
    row[H['데이터기준일']] = today;
    var at = ids.indexOf(x.id), r = at >= 0 ? at + 2 : hs.getLastRow() + 1;
    hs.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    if (at < 0) ids.push(x.id);
  });
}

/* ───────── 도우미 ───────── */
function readMaster_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('기관_마스터');
  var v = sh.getDataRange().getValues(), head = v.shift().map(String);
  return { sheet: sh, head: head, rows: v.map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; }) };
}
function isTrue_(x) { return x === true || String(x).toUpperCase() === 'TRUE'; }
function normTime_(s) {                         // '' → '', '9:00'·'0900'·'9시' → '09:00', 이상하면 false
  s = String(s || '').trim(); if (!s) return '';
  var m = s.match(/^(\d{1,2})\s*[:시.]?\s*(\d{2})?\s*분?$/);
  if (!m) return false;
  var h = +m[1], mi = m[2] ? +m[2] : 0;
  if (h > 24 || mi > 59) return false;
  return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}
function logChange_(today, n, cnt, nh) {
  var log = SpreadsheetApp.getActive().getSheetByName('변경기록'); if (!log) return;
  log.appendRow([today, '기관_마스터 상담·지원 ' + n + '곳', '검수상태/노출/전화/비고', '미검수/FALSE',
    '운영 중 ' + (cnt['운영 중'] || 0) + ', 폐업 ' + (cnt['폐업·찾을 수 없음'] || 0) + ', 이전 ' + (cnt['주소가 다름(이전)'] || 0),
    '검수 도우미로 지도 검색 확인' + (nh ? '. 운영시간 ' + nh + '곳 진료시간 탭에 기록' : '')]);
}
