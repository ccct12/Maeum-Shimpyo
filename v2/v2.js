/* 시제품 v2 첫 화면: 3갈래 안내. app.js의 state·go·drawMap·navPush를 그대로 쓴다. */
(function () {
  var M = window.MAEUM; if (!M) return;
  var state = M.state, go = M.go, drawMap = M.drawMap, navPush = M.navPush, breathe = M.breathe, hit = M.hit, CFG = M.CFG;
  var pick = document.getElementById('tripick');
  var P = { calm: document.getElementById('tri-calm'), find: document.getElementById('tri-find') };
  function show(which) {
    pick.hidden = !!which;
    Object.keys(P).forEach(function (k) { P[k].hidden = k !== which; });
    var v = document.getElementById('v-home'); if (v) v.scrollTop = 0;
    if (which) { var h = P[which].querySelector('h2'); if (h) h.focus(); }
    if (!which && document.getElementById('breathbtn').getAttribute('aria-expanded') === 'true') breathe();   // 숨 고르기 중이면 멈춘다
  }
  var kind = 'all', cond = { open: false, night: false, sat: false, free: false };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tri) { hit('tri:' + b.dataset.tri); navPush({ tri: b.dataset.tri }); show(b.dataset.tri); return; }
    if (b.hasAttribute('data-tri-back')) { if (history.state && history.state.tri) history.back(); else show(null); return; }
    if (b.dataset.tk) { kind = b.dataset.tk; document.querySelectorAll('[data-tk]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
    if (b.dataset.tc) { cond[b.dataset.tc] = !cond[b.dataset.tc]; b.setAttribute('aria-pressed', cond[b.dataset.tc]); return; }
    if (b.id === 'trigo') {
      state.sel = null; state.kind = kind; state.shown = CFG.LIST_STEP || 30;
      state.filters = { open: cond.open, night: cond.night, sat: cond.sat, free: cond.free, more: false };
      go('map'); drawMap(true);
    }
  });
  window.addEventListener('popstate', function (e) {
    var s = e.state || {};
    if ((s.v || 'home') === 'home') show(s.tri || null);
  });
})();
