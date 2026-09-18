/* ==========================================================================
   DATACARE.JS — the 🛡️ Data & Backup screen's own brain.
   --------------------------------------------------------------------------
   The three buttons that used to clutter the sidebar footer live inside
   #screen-data now, with their ORIGINAL ids, so app.js's own handlers
   (setupBackupRestoreHandlers / btn-copy-english-list binding) keep working
   untouched. This file only adds what the new screen needs:
     · live KPI row (total / rotation / bank / due-today) recomputed whenever
       the screen opens — it reads appState + SRS through the shared global
       lexical scope (classic scripts), never by editing app.js;
     · two extra copy tools: one-word-per-line list and the "word — translation"
       two-column dump that feeds Spelling Studio / Import directly;
     · "open the Guide chapter" jump;
     · clipboard fallback (execCommand) for the rare case navigator.clipboard
       is unavailable.
   Every entry point is typeof-guarded: on any DOM/app.js shape change the
   file degrades to a silent no-op instead of throwing.
   ========================================================================== */
(function () {
  'use strict';

  function cardList() {
    try {
      if (typeof appState !== 'undefined' && appState && Array.isArray(appState.cards)) return appState.cards;
    } catch (e) { /* lexical scope not ready yet */ }
    return null;
  }

  function todayISO() {
    try { if (typeof srsToday === 'function') return srsToday(); } catch (e) {}
    return new Date().toISOString().slice(0, 10);
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  function renderStats() {
    var list = cardList();
    if (!list) return;
    var total = list.length, bank = 0, due = 0, T = todayISO();
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      try {
        if (typeof SRS !== 'undefined' && SRS.isBank(c)) { bank++; continue; }
        if (typeof SRS !== 'undefined' && typeof SRS.isDue === 'function' && SRS.isDue(c, T)) due++;
      } catch (e) { /* one bad card must not blank the row */ }
    }
    setText('data-stat-total', total);
    setText('data-stat-active', total - bank);
    setText('data-stat-bank', bank);
    setText('data-stat-due', due);
  }

  /* ---- clipboard with textarea fallback (file:// can refuse async API) ---- */
  function copyText(text, okToast) {
    if (!text) { notify('Nothing to copy yet — the dictionary is empty.', 'info'); return; }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      ta.remove();
      notify(done ? okToast : 'Copy failed — select the text manually.', done ? 'success' : 'error');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { notify(okToast, 'success'); }, legacy);
    } else legacy();
  }

  function notify(msg, type) {
    try { if (typeof showToast === 'function') showToast(msg, type || 'info'); } catch (e) {}
  }

  function words() {
    var list = cardList() || [];
    return list.map(function (c) { return (c && c.word || '').trim(); }).filter(Boolean);
  }

  function wire() {
    var bLines = document.getElementById('btn-copy-words-lines');
    if (bLines && !bLines._dcBound) {
      bLines._dcBound = true;
      bLines.addEventListener('click', function () {
        var ws = words();
        copyText(ws.join('\n'), '📝 Copied ' + ws.length + ' words, one per line.');
      });
    }
    var bTrans = document.getElementById('btn-copy-words-trans');
    if (bTrans && !bTrans._dcBound) {
      bTrans._dcBound = true;
      bTrans.addEventListener('click', function () {
        var list = cardList() || [];
        var lines = [];
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          var w = (c && c.word || '').trim();
          if (!w) continue;
          var t = (c.translation || '').toString().trim();
          lines.push(t ? w + ' — ' + t : w);
        }
        copyText(lines.join('\n'), '🔤 Copied ' + lines.length + ' “word — translation” lines — paste into Spelling Studio.');
      });
    }
    var bGuide = document.getElementById('btn-data-open-guide');
    if (bGuide && !bGuide._dcBound) {
      bGuide._dcBound = true;
      bGuide.addEventListener('click', function () {
        try { if (typeof switchScreen === 'function') switchScreen('guide'); } catch (e) {}
      });
    }
  }

  /* stats refresh: when the screen opens (class .active) — same passive
     MutationObserver trick as polish.js, scoped to #screen-data only */
  function watchActivation() {
    var sec = document.getElementById('screen-data');
    if (!sec || typeof MutationObserver !== 'function') return;
    var wasActive = sec.classList.contains('active');
    new MutationObserver(function () {
      var now = sec.classList.contains('active');
      if (now && !wasActive) renderStats();
      wasActive = now;
    }).observe(sec, { attributes: true, attributeFilter: ['class'] });
    if (wasActive) renderStats();
  }

  /* ================== STATS SCREEN v2 (18.09) ==================
     «Answer Outcomes» donut + «Direction Strength» bars for #screen-stats.
     Aggregates appState.history ({total, correct, byAnswer, byDirection}
     per day) and reuses app.js globals drawFallbackDonutChart(canvas,
     labels, data, colors, centerWord) + themeRgba(). All typeof-guarded. */
  function histAgg() {
    var out = { again: 0, hard: 0, easy: 0, dirs: { en_ru: { t: 0, c: 0 }, ru_en: { t: 0, c: 0 } } };
    try {
      var h = (typeof appState !== 'undefined' && appState && appState.history) || {};
      Object.keys(h).forEach(function (k) {
        var d = h[k] || {};
        var ba = d.byAnswer || {};
        out.again += ba.again || 0;
        out.hard += ba.hard || 0;
        out.easy += ba.easy || 0;
        var bd = d.byDirection || {};
        ['en_ru', 'ru_en'].forEach(function (dir) {
          var v = bd[dir];
          if (v) { out.dirs[dir].t += v.total || 0; out.dirs[dir].c += v.correct || 0; }
        });
      });
    } catch (e) { /* history shape unexpected → zeroed aggregate */ }
    return out;
  }

  function outcomeColor(token, fallbackTriplet) {
    try {
      if (typeof themeRgba === 'function') return themeRgba(token, fallbackTriplet, 0.85);
    } catch (e) {}
    return 'rgba(' + fallbackTriplet + ', 0.85)';
  }

  function renderOutcomes() {
    var agg = histAgg();
    var grand = agg.again + agg.hard + agg.easy;
    var emptyEl = document.getElementById('chart-outcomes-empty');
    var canvas = document.getElementById('chart-outcomes');
    if (emptyEl) emptyEl.hidden = grand > 0;
    if (canvas && grand > 0 && typeof drawFallbackDonutChart === 'function') {
      drawFallbackDonutChart(canvas,
        ['Easy', 'Hard', 'Again'],
        [agg.easy, agg.hard, agg.again],
        [outcomeColor('--accent-green-rgb', '16, 185, 129'),
         outcomeColor('--accent-amber-rgb', '245, 158, 11'),
         outcomeColor('--accent-red-rgb', '239, 68, 68')],
        'answers');
    }
    var rows = [
      { fill: 'ds-en-ru', pct: 'ds-en-ru-pct', tag: 'ds-en-ru-tag', v: agg.dirs.en_ru },
      { fill: 'ds-ru-en', pct: 'ds-ru-en-pct', tag: 'ds-ru-en-tag', v: agg.dirs.ru_en }
    ];
    var weaker = null;
    if (rows[0].v.t > 0 && rows[1].v.t > 0) {
      var r0 = rows[0].v.c / rows[0].v.t, r1 = rows[1].v.c / rows[1].v.t;
      weaker = r0 < r1 ? 0 : (r1 < r0 ? 1 : null);
    }
    rows.forEach(function (r, i) {
      var f = document.getElementById(r.fill);
      var p = document.getElementById(r.pct);
      var t = document.getElementById(r.tag);
      var share = r.v.t > 0 ? Math.round((r.v.c / r.v.t) * 100) : null;
      if (f) f.style.width = (share === null ? 0 : share) + '%';
      if (p) p.textContent = share === null ? '—' : share + '%';
      if (t) t.textContent = weaker === i ? 'weaker' : '';
    });
  }

  /* ================== STATS SCREEN v3 (18.09, «понты по делу») ==================
     Journey-to-Mastery лента (сегменты = <button>, клик → Dictionary-фильтр),
     Personal Highlights (агрегаты истории) и общий рендер-оркестратор. */
  var RIBBON_ORDER = ['BANK', 'NEW', 'LEARNING', 'FAMILIAR', 'CONFIDENT', 'MASTERED'];
  var RIBBON_NAMES = { BANK: 'Bank', NEW: 'New', LEARNING: 'Learning', FAMILIAR: 'Familiar', CONFIDENT: 'Confident', MASTERED: 'Mastered' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function tripletFor(bucket) {
    try {
      var raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--grp-' + String(bucket).toLowerCase() + '-rgb').trim().replace(/\s+/g, '');
      if (/^\d{1,3},\d{1,3},\d{1,3}$/.test(raw)) return raw;
    } catch (e) {}
    return null;
  }

  function fmtDay(iso) {
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    return MONTHS[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10);
  }

  function renderMasteryRibbon() {
    var host = document.getElementById('mastery-ribbon');
    var legend = document.getElementById('ribbon-legend');
    if (!host) return;
    var groups = {};
    try {
      if (typeof SRS !== 'undefined' && typeof appState !== 'undefined' && appState &&
          Array.isArray(appState.cards) && typeof srsToday === 'function') {
        groups = (SRS.summarize(appState.cards, srsToday()).groups) || {};
      }
    } catch (e) { groups = {}; }
    var total = 0;
    RIBBON_ORDER.forEach(function (g) { total += groups[g] || 0; });

    host.textContent = '';
    if (legend) legend.textContent = '';
    if (!total) {
      var em = document.createElement('span');
      em.className = 'ribbon-empty';
      em.textContent = 'Add words to see your journey';
      host.appendChild(em);
      return;
    }

    RIBBON_ORDER.forEach(function (g) {
      var n = groups[g] || 0;
      var pct = (n / total) * 100;
      var trip = tripletFor(g);

      var seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'mseg grp-' + g.toLowerCase();
      // ноль — нулевая ширина; крошечные группы не схлопываются ниже 1.6%
      seg.style.width = (n > 0 ? Math.max(pct, 1.6) : 0) + '%';
      if (n === 0) { seg.disabled = true; seg.tabIndex = -1; }
      seg.title = RIBBON_NAMES[g] + ': ' + n + ' (' + Math.round(pct) + '%)';
      seg.setAttribute('aria-label', RIBBON_NAMES[g] + ': ' + n + ' words, ' + Math.round(pct) + ' percent. Open group in Dictionary.');
      if (trip) seg.style.background = 'linear-gradient(180deg, rgba(' + trip + ', 0.95), rgba(' + trip + ', 0.55))';
      seg.addEventListener('click', function () {
        try { if (typeof openGroupInDictionary === 'function') openGroupInDictionary(g); } catch (e) {}
      });
      host.appendChild(seg);

      if (legend) {
        var chip = document.createElement('span');
        chip.className = 'rl-chip';
        var dot = document.createElement('span');
        dot.className = 'rl-dot';
        if (trip) dot.style.background = 'rgb(' + trip + ')';
        var nm = document.createElement('b');
        nm.textContent = RIBBON_NAMES[g];
        var ct = document.createElement('span');
        ct.className = 'rl-count';
        ct.textContent = String(n);
        chip.appendChild(dot); chip.appendChild(nm); chip.appendChild(ct);
        legend.appendChild(chip);
      }
    });
  }

  function renderHighlights() {
    var h = {};
    try { h = (typeof appState !== 'undefined' && appState && appState.history) || {}; } catch (e) { h = {}; }
    var keys = Object.keys(h).sort();
    var totalAns = 0, bestVal = 0, bestDay = null, perfect = 0;
    keys.forEach(function (k) {
      var d = h[k] || {};
      var t = d.total || 0;
      totalAns += t;
      if (t > bestVal) { bestVal = t; bestDay = k; }
      var again = (d.byAnswer && d.byAnswer.again) || 0;
      if (t > 0 && again === 0) perfect++;
    });
    // самый длинный непрерывный забег дней с активностью
    var bestRun = 0, run = 0, prev = null;
    keys.forEach(function (k) {
      var t = (h[k] || {}).total || 0;
      if (t <= 0) return;
      if (prev && (new Date(k) - new Date(prev)) === 86400000) run++;
      else run = 1;
      prev = k;
      if (run > bestRun) bestRun = run;
    });
    setText('hl-total-answers', totalAns > 0 ? String(totalAns) : '—');
    setText('hl-best-day', bestDay ? bestVal + ' · ' + fmtDay(bestDay) : '—');
    setText('hl-best-streak', bestRun > 0 ? bestRun + (bestRun === 1 ? ' day' : ' days') : '—');
    setText('hl-perfect-days', perfect > 0 ? String(perfect) : '—');
  }

  function renderStatsExtras() {
    try { renderOutcomes(); } catch (e) {}
    try { renderMasteryRibbon(); } catch (e) {}
    try { renderHighlights(); } catch (e) {}
  }

  function watchStatsActivation() {
    var sec = document.getElementById('screen-stats');
    if (sec && typeof MutationObserver === 'function') {
      var wasActive = sec.classList.contains('active');
      new MutationObserver(function () {
        var now = sec.classList.contains('active');
        if (now && !wasActive) renderStatsExtras();
        wasActive = now;
      }).observe(sec, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('themechange', function () {
      if (sec && sec.classList.contains('active')) renderStatsExtras();
    });
    if (sec && sec.classList.contains('active')) renderStatsExtras();
  }

  function init() {
    wire();
    watchActivation();
    renderStats();
    watchStatsActivation();
    renderStatsExtras();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
