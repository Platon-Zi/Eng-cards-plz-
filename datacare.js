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

  function init() {
    wire();
    watchActivation();
    renderStats();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
