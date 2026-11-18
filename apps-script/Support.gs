/**
 * 마음쉼표 · 심리지원 사업 자동 수집 (복지로 / 한국사회보장정보원 오픈API)
 * 붙여 넣는 곳: Apps Script 편집기에 새 파일 'Support.gs'를 만들고 이 내용을 그대로 붙여 넣는다.
 *
 * [준비] 시트 메뉴 '지원사업 > ① 공공데이터포털 인증키 저장'으로 키를 넣는다. 키를 코드·HTML·저장소에 적지 않는다.
 * [흐름] ② 지금 불러오기 → '지원사업' 탭에 후보가 쌓인다 → 사람이 읽고 '노출'에 체크한 것만 사이트에 나간다.
 * [쓰는 API]
 *   중앙부처복지서비스  apis.data.go.kr/B554287/NationalWelfareInformationsV001  (개발계정 하루 100회)
 *   지자체복지서비스    apis.data.go.kr/B554287/LocalGovernmentWelfareInformations (개발계정 하루 1,000회)
 *   두 API 모두 이용허락범위 '제한 없음'. 화면에는 출처(복지로·한국사회보장정보원)와 기준일을 함께 적는다.
 * [고르는 기준]
 *   전국: 관심주제에 '정신건강'이 있거나, 이름·요약에 심리·정신건강 관련 말이 있는 것
 *   지역: 지자체 데이터에는 '정신건강' 주제가 거의 붙어 있지 않아(2026-11 확인) 이름·요약의 말로 고른다
 *   이름에 관련 말이 있으면 추천 '높음', 요약에만 있으면 '검토'. 어느 쪽이든 노출은 꺼진 채로 들어온다.
 * [사람이 쓰는 칸] 쉬운 설명 · 노출 · 메모 — 자동 갱신이 덮어쓰지 않는다.
 */

var SUP = {
  SHEET: '지원사업',
  KEY_PROP: 'BOKJI_KEY',
  NAT: 'https://apis.data.go.kr/B554287/NationalWelfareInformationsV001',
  LOC: 'https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations',
  NAME_RE: /심리|정신건강|정신질환|정신장애|마음건강|마음돌봄|마음이음|마음성장|마음채움|우울|자살|트라우마|중독|정서/,
  DGST_RE: /심리상담|심리치료|심리지원|심리검사|정신건강|우울|자살|트라우마|중독관리/,
  EXCLUDE_RE: /반려|동물|가축/,
  DETAIL_MAX_NAT: 60,   // 한 번 실행에서 받을 상세 수 (중앙 하루 100회 한도 안)
  DETAIL_MAX_LOC: 120,
  TEXT_MAX: 1500,
  HEAD: ['사업ID', '구분', '사업명', '요약', '쉬운 설명', '담당', '시도', '시군구', '생애주기', '가구상황', '관심주제',
         '지원주기', '제공유형', '신청방법', '온라인신청', '대표문의', '상세링크', '최종수정일',
         '지원대상', '선정기준', '지원내용', '신청방법 상세', '문의처', '상세받은날',
         '추천', '노출', '상태', '처음수집일', '마지막확인일', '메모'],
  KEEP: ['쉬운 설명', '노출', '메모', '처음수집일']   // 자동 갱신이 건드리지 않는 칸
};

function addSupportMenu_(ui) {
  ui.createMenu('지원사업')
    .addItem('① 공공데이터포털 인증키 저장', 'setBokjiKey')
    .addItem('② 지금 불러오기', 'refreshSupport')
    .addItem('③ 자동 갱신 켜기 (매주 월요일 새벽)', 'installSupportTrigger')
    .addItem('노출한 것만 상세 다시 받기', 'refetchShownDetails')
    .addToUi();
}

function setBokjiKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('공공데이터포털 인증키 저장', '일반 인증키(Decoding)를 붙여 넣으세요. 코드에는 남지 않고 스크립트 속성에만 저장됩니다.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var k = r.getResponseText().trim();
  if (k.length < 20 || /\s/.test(k)) { ui.alert('키 형식이 올바르지 않습니다.'); return; }
  PropertiesService.getScriptProperties().setProperty(SUP.KEY_PROP, k);
  ui.alert('저장했습니다. 이제 ② 지금 불러오기를 실행하세요.');
}

function installSupportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshSupport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshSupport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(5).create();
  try { SpreadsheetApp.getUi().alert('매주 월요일 새벽 5시쯤 자동으로 불러옵니다.'); } catch (e) {}
}

/* ───────── 불러오기 ───────── */
function refreshSupport() {
  var key = PropertiesService.getScriptProperties().getProperty(SUP.KEY_PROP);
  if (!key) { supAlert_('먼저 ① 인증키 저장을 해 주세요.'); return; }
  var started = Date.now(), today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var sh = supSheet_(), H = SUP.HEAD, col = {}; H.forEach(function (h, i) { col[h] = i; });
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, H.length).getValues() : [];
  var at = {}; rows.forEach(function (r, i) { if (r[0]) at[r[0]] = i; });

  var got = { n: fetchNational_(key), l: fetchLocal_(key) }, seen = {}, added = 0, changed = 0;
  ['n', 'l'].forEach(function (k) {
    if (!got[k]) return;                                   // 그 목록을 못 받았으면 건드리지 않는다
    got[k].forEach(function (o) {
      seen[o['사업ID']] = true;
      var i = at[o['사업ID']], r;
      if (i == null) {
        r = H.map(function () { return ''; });
        r[col['노출']] = false; r[col['처음수집일']] = today; r[col['상태']] = '새로 들어옴';
        rows.push(r); at[o['사업ID']] = rows.length - 1; added++;
      } else {
        r = rows[i];
        if (String(r[col['최종수정일']]) !== String(o['최종수정일'])) {
          ['지원대상', '선정기준', '지원내용', '신청방법 상세', '문의처', '상세받은날'].forEach(function (h) { r[col[h]] = ''; });
          r[col['상태']] = r[col['노출']] === true ? '내용 바뀜 (확인)' : r[col['상태']] || '유지';
          changed++;
        } else if (r[col['상태']] === '목록에서 빠짐' || (r[col['상태']] === '새로 들어옴' && r[col['노출']] === true)) r[col['상태']] = '유지';
      }
      H.forEach(function (h, j) { if (o[h] !== undefined && SUP.KEEP.indexOf(h) < 0) r[j] = sv_(o[h]); });
      r[col['마지막확인일']] = today;
    });
  });
  // 이번에 받은 목록에 없는 사업은 끝났을 수 있으니 웹으로 내보내지 않는다
  rows.forEach(function (r) {
    var k = r[col['구분']] === '전국' ? 'n' : 'l';
    if (r[0] && got[k] && !seen[r[0]]) r[col['상태']] = '목록에서 빠짐';
  });

  // 상세: 아직 안 받은 것만, 한도 안에서
  var cnt = { n: 0, l: 0 };
  rows.forEach(function (r) {
    if (Date.now() - started > CFG.TIME_LIMIT_MS) return;
    if (!r[0] || r[col['상세받은날']] || r[col['상태']] === '목록에서 빠짐') return;
    var k = r[col['구분']] === '전국' ? 'n' : 'l';
    if (cnt[k] >= (k === 'n' ? SUP.DETAIL_MAX_NAT : SUP.DETAIL_MAX_LOC)) return;
    var d = k === 'n' ? detailNational_(key, r[0]) : detailLocal_(key, r[0]); cnt[k]++;
    if (!d) return;
    Object.keys(d).forEach(function (h) { if (col[h] != null && d[h] !== undefined) r[col[h]] = sv_(d[h]); });
    r[col['상세받은날']] = today;
  });

  rows.sort(function (a, b) {                              // 노출 → 추천 높음 → 전국 → 이름 순
    var s = function (r) { return (r[col['노출']] === true ? 0 : 4) + (r[col['추천']] === '높음' ? 0 : 2) + (r[col['구분']] === '전국' ? 0 : 1); };
    return s(a) - s(b) || String(a[col['사업명']]).localeCompare(String(b[col['사업명']]), 'ko');
  });
  if (rows.length) {
    sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, rows.length), H.length).clearContent();
    sh.getRange(2, 1, rows.length, H.length).setValues(rows);
    sh.getRange(2, col['노출'] + 1, rows.length, 1).insertCheckboxes();
  }
  CacheService.getScriptCache().remove('support_n');
  var msg = '지원사업: 전국 ' + (got.n ? got.n.length : '실패') + '건, 지역 ' + (got.l ? got.l.length : '실패') + '건 확인. 새로 ' + added + '건, 바뀜 ' + changed + '건. 상세 ' + (cnt.n + cnt.l) + '건 받음.';
  console.log(msg); supAlert_(msg);
}

function refetchShownDetails() {
  var sh = supSheet_(), H = SUP.HEAD, c = H.indexOf('상세받은날'), s = H.indexOf('노출');
  if (sh.getLastRow() < 2) return;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, H.length).getValues();
  v.forEach(function (r) { if (r[s] === true) r[c] = ''; });
  sh.getRange(2, 1, v.length, H.length).setValues(v);
  refreshSupport();
}

/* 전국: 목록 1번(최대 500건)이면 전체(2026-11 기준 461건)를 받는다 */
function fetchNational_(key) {
  var out = [];
  for (var p = 1; p <= 3; p++) {
    var x = supGet_(SUP.NAT + '/NationalWelfarelistV001', { serviceKey: key, callTp: 'L', srchKeyCode: '001', pageNo: p, numOfRows: 500 });
    if (!x) return null;
    var list = x.getChildren('servList');
    list.forEach(function (e) {
      var o = kids_(e), name = (o.servNm || '').trim(), dg = o.servDgst || '', th = o.intrsThemaArray || '';
      if (SUP.EXCLUDE_RE.test(name)) return;
      var hiName = SUP.NAME_RE.test(name), hit = hiName || th.indexOf('정신건강') >= 0 || SUP.DGST_RE.test(dg);
      if (!hit) return;
      out.push({ '사업ID': o.servId, '구분': '전국', '사업명': name, '요약': dg, '담당': [o.jurMnofNm, o.jurOrgNm].filter(String).join(' '),
        '시도': '', '시군구': '', '생애주기': o.lifeArray || '', '가구상황': o.trgterIndvdlArray || '', '관심주제': th,
        '지원주기': o.sprtCycNm || '', '제공유형': o.srvPvsnNm || '', '신청방법': '', '온라인신청': o.onapPsbltYn === 'Y' ? '가능' : '',
        '대표문의': o.rprsCtadr || '', '상세링크': o.servDtlLink || '', '최종수정일': o.svcfrstRegTs || '',
        '추천': hiName ? '높음' : '검토' });
    });
    if (list.length < 500) break;
  }
  return out.length ? out : null;                         // 전국 목록이 비면 오류로 보고 기존 행을 그대로 둔다
}

/* 지역: 전체 목록(2026-11 기준 4,828건)을 500건씩 받아 고른다 → 약 10회 호출 */
function fetchLocal_(key) {
  var out = [];
  for (var p = 1; p <= 30; p++) {
    var x = supGet_(SUP.LOC + '/LcgvWelfarelist', { serviceKey: key, pageNo: p, numOfRows: 500 });
    if (!x) return p === 1 ? null : out;
    var list = x.getChildren('servList');
    list.forEach(function (e) {
      var o = kids_(e), name = (o.servNm || '').trim(), dg = o.servDgst || '';
      if (SUP.EXCLUDE_RE.test(name)) return;
      var hiName = SUP.NAME_RE.test(name);
      if (!hiName && !SUP.DGST_RE.test(dg)) return;
      out.push({ '사업ID': o.servId, '구분': '지역', '사업명': name, '요약': dg, '담당': o.bizChrDeptNm || '',
        '시도': (o.ctpvNm || '').trim(), '시군구': (o.sggNm || '').trim(), '생애주기': o.lifeNmArray || '', '가구상황': o.trgterIndvdlNmArray || '',
        '관심주제': o.intrsThemaNmArray || '', '지원주기': o.sprtCycNm || '', '제공유형': o.srvPvsnNm || '', '신청방법': o.aplyMtdNm || '',
        '온라인신청': '', '대표문의': '', '상세링크': o.servDtlLink || '', '최종수정일': o.lastModYmd || '',
        '추천': hiName ? '높음' : '검토' });
    });
    if (list.length < 500) break;
  }
  return out;
}

function detailNational_(key, id) {
  var x = supGet_(SUP.NAT + '/NationalWelfaredetailedV001', { serviceKey: key, callTp: 'D', servId: id });
  if (!x) return null;
  var o = kids_(x);
  return { '지원대상': o.tgtrDtlCn || '', '선정기준': o.slctCritCn || '', '지원내용': o.alwServCn || '',
    '신청방법 상세': listText_(x, 'applmetList'), '문의처': listText_(x, 'inqplCtadrList'), '대표문의': o.rprsCtadr || undefined };
}
function detailLocal_(key, id) {
  var x = supGet_(SUP.LOC + '/LcgvWelfaredetailed', { serviceKey: key, servId: id });
  if (!x) return null;
  var o = kids_(x);
  return { '지원대상': o.sprtTrgtCn || '', '선정기준': o.slctCritCn || '', '지원내용': o.alwServCn || '',
    '신청방법 상세': o.aplyMtdCn || '', '문의처': listText_(x, 'inqplCtadrList') };
}

/* ───────── 웹으로 내보내기: doGet(type=support) ───────── */
function support_() {
  var out = [];
  if (!SpreadsheetApp.getActive().getSheetByName(SUP.SHEET)) return { kind: 'support', asOf: new Date().toISOString(), count: 0, items: [] };
  table_(SUP.SHEET).forEach(function (r) {
    if (r['노출'] !== true && String(r['노출']).toUpperCase() !== 'TRUE') return;
    if (r['상태'] === '목록에서 빠짐') return;
    out.push({ id: r['사업ID'], k: r['구분'] === '전국' ? 'n' : 'l', n: r['사업명'], s: r['쉬운 설명'] || r['요약'],
      org: r['담당'], sd: r['시도'], sg: r['시군구'], life: r['생애주기'], on: r['온라인신청'] === '가능' ? 1 : 0,
      tel: r['대표문의'], url: r['상세링크'], mod: fmtYmd_(r['최종수정일']),
      tgt: r['지원대상'], crit: r['선정기준'], ben: r['지원내용'], how: r['신청방법 상세'] || r['신청방법'], inq: r['문의처'] });
  });
  return { kind: 'support', asOf: new Date().toISOString(), count: out.length, items: out };
}

/* ───────── 도우미 ───────── */
function supGet_(url, q) {
  var qs = Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
  for (var t = 0; t < 2; t++) {
    try {
      var res = UrlFetchApp.fetch(url + '?' + qs, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) { console.warn('HTTP ' + res.getResponseCode() + ' ' + url); Utilities.sleep(800); continue; }
      var root = XmlService.parse(res.getContentText('UTF-8')).getRootElement();
      if (root.getName() === 'OpenAPI_ServiceResponse') {  // 게이트웨이 오류(키 미등록·한도 초과 등)
        console.warn('API 게이트웨이 ' + res.getContentText('UTF-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)); return null;
      }
      var code = text_(root, 'resultCode');
      if (code === '0' || code === '00') return root;
      if (code === '40') return root;                       // NO DATA FOUND: 빈 목록
      console.warn('API ' + code + ' ' + text_(root, 'resultMessage') + ' ' + url);
      return null;                                          // 키 오류·한도 초과 등은 다시 시도하지 않는다
    } catch (e) { console.warn(e); Utilities.sleep(800); }
  }
  return null;
}
function kids_(el) { var o = {}; el.getChildren().forEach(function (c) { if (!c.getChildren().length) o[c.getName()] = c.getText().trim(); }); return o; }
function text_(el, name) { var c = el.getChild(name); return c ? c.getText().trim() : ''; }
function listText_(root, name) {
  return root.getChildren(name).map(function (e) {
    return e.getChildren().map(function (c) { return c.getText().trim(); })
      .filter(function (t) { return t && !/^\d{1,3}$/.test(t); }).join(' : ');
  }).filter(String).join('\n');
}
function sv_(v) {
  if (typeof v !== 'string') return v;
  v = v.replace(/\r/g, '').trim();
  if (v.length > SUP.TEXT_MAX) v = v.slice(0, SUP.TEXT_MAX) + '…';
  return /^[=+\-@]/.test(v) ? "'" + v : v;                  // 수식으로 해석되지 않게
}
function fmtYmd_(v) {
  var s = v instanceof Date ? Utilities.formatDate(v, 'Asia/Seoul', 'yyyyMMdd') : String(v || '').replace(/\D/g, '');
  return s.length >= 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '';
}
function supSheet_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(SUP.SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(SUP.SHEET);
  sh.getRange(1, 1, 1, SUP.HEAD.length).setValues([SUP.HEAD]).setFontWeight('bold').setBackground('#EEF2EC');
  sh.setFrozenRows(1); sh.setFrozenColumns(3);
  sh.getRange('A:AD').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 320); sh.setColumnWidth(5, 260);
  ['쉬운 설명', '노출', '메모'].forEach(function (h) { sh.getRange(1, SUP.HEAD.indexOf(h) + 1).setBackground('#FFF4D6'); });
  sh.getRange(1, SUP.HEAD.indexOf('쉬운 설명') + 1).setNote('비워 두면 사이트에 원문 요약이 나가요. 쉬운 말로 한 줄 바꾸고 싶을 때만 적어 주세요.');
  sh.getRange(1, SUP.HEAD.indexOf('노출') + 1).setNote('체크한 사업만 사이트에 나가요. 처음엔 모두 꺼진 상태로 들어와요.');
  return sh;
}
function supAlert_(m) { try { SpreadsheetApp.getUi().alert(m); } catch (e) {} }
