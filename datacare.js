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

  /* ============ STATS v4: UPCOMING LOAD — прогноз повторений на 14 дней ============
     Сколько записей (слово × направление) созревает в каждый из ближайших дней.
     Красная колонка «now» — всё, что должно сегодня/просрочено; клик по ней
     запускает обычную Practice-сессию. После введения честных guard'ов
     (same-day + early) этому прогнозу можно доверять. */
  function forecastAgg() {
    var cards = (typeof appState !== 'undefined' && appState && Object.prototype.toString.call(appState.cards) === '[object Array]')
      ? appState.cards
      : ((window.LEITNER_DATA && LEITNER_DATA.cards) || []);
    var today = (typeof srsToday === 'function') ? srsToday() : new Date().toISOString().slice(0, 10);
    var buckets = [];
    for (var i = 0; i < 14; i++) buckets.push(0);
    cards.forEach(function (c) {
      if (!c || String(c.status || '').toUpperCase() !== 'ACTIVE') return;
      ['en_ru', 'ru_en'].forEach(function (dir) {
        var due = c['next_review_' + dir];
        if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return;
        var delta = Math.round((Date.parse(due) - Date.parse(today)) / 86400000);
        if (delta <= 0) buckets[0]++;
        else if (delta <= 13) buckets[delta]++;
      });
    });
    return { buckets: buckets, today: today };
  }

  function forecastLabels(today) {
    var labels = ['now'];
    for (var i = 1; i < 14; i++) {
      var iso = new Date(Date.parse(today) + i * 86400000).toISOString().slice(0, 10);
      labels.push(fmtDay(iso));
    }
    return labels;
  }

  function forecastColor(idx) {
    if (idx === 0) return outcomeColor('--accent-red-rgb', '239, 68, 68');
    if (idx <= 3) return outcomeColor('--accent-amber-rgb', '245, 158, 11');
    return outcomeColor('--accent-blue-rgb', '99, 102, 241');
  }

  function renderForecast() {
    var agg = forecastAgg();
    var sum = agg.buckets.reduce(function (a, b) { return a + b; }, 0);
    var emptyEl = document.getElementById('chart-forecast-empty');
    var canvas = document.getElementById('chart-forecast');
    if (emptyEl) emptyEl.hidden = sum > 0;
    if (!canvas || sum === 0 || typeof drawFallbackBarChart !== 'function') return;
    var colors = agg.buckets.map(function (v, i) { return forecastColor(i); });
    drawFallbackBarChart(canvas, forecastLabels(agg.today), agg.buckets, -1, colors);
    if (agg.buckets[0] > 0 && typeof startTrainingSession === 'function') {
      canvas._chart.click = function (i) { if (i === 0) startTrainingSession('system'); };
    }
  }

  /* ============ TODAY'S MISSION (19.09): дневной минимум на главном экране ============
     Идея пользователя: под большими кнопками всегда видны ДВА обязательных
     объёма дня — 🌱 минимум новых слов (настраиваемая цель, localStorage
     'vocaba_daily_goal', дефолт 15) и 🔥 адаптивный минимум повторений
     (всё, что созрело к данному моменту = длина SRS review-очереди; «без
     этого не ложиться спать»). Плитки кликабельны: learn → Bank, review →
     system Practice. Данные: history[today].newWords пишет app.js submitAnswer
     при активации из Банка (result.activated). */
  var DM_GOAL_KEY = 'vocaba_daily_goal';

  /* ---- Отбор «супер-важного» повторения (идея пользователя 19.09) ----
     Кнопка Must-review — это НЕ вся Practice-очередь, а ограниченный дневной
     минимум: худшие слова первыми. Риск считается на записях review-очереди
     SRS (item.overdue/intervalDays/level уже проставлены ядром):
       decay      = overdue / interval   — насколько слово перезрело относительно
                                          собственного интервала (забывается);
       fragility  = fail_count / review_count — исторически хрупкое слово;
       importance = level / MAX_LEVEL    — дорогой прогресс (L5 терять больнее).
       score = 2*decay + 1.5*fragility + importance + (0.5 если перезрело)
     Потолок CAP=40: сессию реально закрыть перед сном; app.js вызывает
     window.VocabaCritical.select() из режима 'critical'. */
  var CRITICAL_CAP = 40;

  function criticalScore(item, card) {
    var daysOver = Math.max(0, Number(item && item.overdue) || 0);
    var interval = Math.max(1, Number(item && item.intervalDays) || 1);
    var level = Math.max(0, Number(item && item.level) || 0);
    var rc = Number(card && card.review_count) || 0;
    var fc = Number(card && card.fail_count) || 0;
    var decay = daysOver / interval;
    var fragility = rc > 0 ? fc / rc : 0;   // (20.09, F7) нет отзывов — нет хрупкости
    var importance = level / 6;
    return 2 * decay + 1.5 * fragility + importance + (daysOver > 0 ? 0.5 : 0);
  }

  function criticalSelect(items, cards) {
    var byId = {};
    (cards || []).forEach(function (c) { if (c && c.id != null) byId[c.id] = c; });
    var scored = (items || []).map(function (it) {
      return { it: it, s: criticalScore(it, byId[it && it.cardId]) };
    });
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      var ao = Number(a.it.overdue) || 0, bo = Number(b.it.overdue) || 0;
      if (bo !== ao) return bo - ao;
      return (Number(b.it.level) || 0) - (Number(a.it.level) || 0);
    });
    return scored.slice(0, CRITICAL_CAP).map(function (x) { return x.it; });
  }

  window.VocabaCritical = { CAP: CRITICAL_CAP, score: criticalScore, select: criticalSelect };

  function dmGoal() {
    var v = 15;
    try { v = parseInt(localStorage.getItem(DM_GOAL_KEY), 10); } catch (e) {}
    if (!Number.isFinite(v) || v < 1) v = 15;
    return Math.min(200, Math.max(1, v));
  }

  function dmCards() {
    try {
      if (typeof appState !== 'undefined' && appState && Object.prototype.toString.call(appState.cards) === '[object Array]') return appState.cards;
    } catch (e) {}
    return (window.LEITNER_DATA && LEITNER_DATA.cards) || [];
  }

  function dmDay(today) {
    try {
      var h = (typeof appState !== 'undefined' && appState && appState.history) ? appState.history
        : ((window.LEITNER_DATA && LEITNER_DATA.history) || {});
      return (h && h[today]) || {};
    } catch (e) { return {}; }
  }

  function dmAlpha(token, triplet, alpha) {
    try {
      if (typeof themeRgba === 'function') return themeRgba(token, triplet, alpha);
    } catch (e) {}
    return 'rgba(' + triplet + ', ' + alpha + ')';
  }

  function renderDailyMission() {
    var panel = document.getElementById('daily-mission');
    if (!panel) return;
    var today = (typeof srsToday === 'function') ? srsToday() : new Date().toISOString().slice(0, 10);
    var goal = dmGoal();
    var day = dmDay(today);
    var learned = Number(day.newWords) || 0;
    var dueItems = [];
    try {
      if (typeof SRS !== 'undefined' && typeof SRS.buildReviewQueue === 'function') {
        dueItems = SRS.buildReviewQueue(dmCards(), today, {}) || [];
      }
    } catch (e) {}
    var due = dueItems.length;
    var critical = due;
    try {
      if (window.VocabaCritical) critical = window.VocabaCritical.select(dueItems, dmCards(), today).length;
    } catch (e) { critical = due; }
    // Закрыто сегодня повторений: сумма byDirection.total дневной истории.
    // Любой ответ на созревшее слово двигает его next_review в будущее, поэтому
    // completed/(completed+долг) — честная доля закрытого дневного объёма.
    var completed = 0;
    try {
      var bd = day.byDirection || {};
      ['en_ru', 'ru_en'].forEach(function (dir) {
        completed += Number(bd[dir] && bd[dir].total) || 0;
      });
    } catch (e) {}

    var learnPct = Math.min(100, Math.round((learned / goal) * 100));
    var reviewPct = due === 0 ? 100 : Math.min(99, Math.round((completed / (completed + due)) * 100));
    var goalReached = learned >= goal;

    var dateEl = document.getElementById('dm-date');
    if (dateEl) dateEl.textContent = fmtDay(today);

    // Кольца: минимум текста — цифра в центре, прогресс fills the ring.
    var track = dmAlpha('--overlay-rgb', '128, 128, 128', 0.12);
    var ringPaint = function (id, pct, token, triplet) {
      var el = document.getElementById(id);
      if (!el) return;
      var color = dmAlpha(token, triplet, 0.9);
      el.style.background = 'conic-gradient(' + color + ' ' + (pct * 3.6) + 'deg, ' + track + ' 0deg)';
    };
    ringPaint('dm-ring-review', reviewPct,
      due === 0 ? '--accent-green-rgb' : '--accent-red-rgb',
      due === 0 ? '16, 185, 129' : '239, 68, 68');
    ringPaint('dm-ring-learn', learnPct,
      goalReached ? '--accent-green-rgb' : '--accent-primary-rgb',
      goalReached ? '16, 185, 129' : '99, 102, 241');

    var setTxt = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    setTxt('dm-review-num', String(due));
    setTxt('dm-learn-num', learned + '/' + goal);

    // Все подробности — в hover-тултипы плиток.
    var reviewTile = document.getElementById('dm-review');
    if (reviewTile) {
      reviewTile.title = due === 0
        ? 'All reviews done — sleep well!'
        : (critical < due
          ? (due + ' due · the session starts with the worst ' + critical + ' — tap to review')
          : (due + ' due — tap to start'));
    }
    var learnTile = document.getElementById('dm-learn');
    if (learnTile) {
      learnTile.title = goalReached
        ? ('Goal reached: ' + learned + ' of ' + goal + ' — tap to learn more')
        : (learned + ' of ' + goal + ' new words today — tap to learn');
    }

    panel.classList.toggle('dm-goal-reached', goalReached);
    panel.classList.toggle('dm-review-done', due === 0);

    var input = document.getElementById('dm-goal-input');
    if (input && document.activeElement !== input) input.value = goal;
  }

  var dmWired = false;
  function wireDailyMission() {
    if (dmWired) return;
    var learn = document.getElementById('dm-learn');
    var review = document.getElementById('dm-review');
    var input = document.getElementById('dm-goal-input');
    if (!learn && !review && !input) return;
    dmWired = true;
    function go(mode) {
      if (typeof startTrainingSession === 'function') startTrainingSession(mode);
    }
    [['dm-learn', 'learn'], ['dm-review', 'critical']].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      el.addEventListener('click', function () { go(pair[1]); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(pair[1]); }
      });
      el.dataset.bound = '1';
    });
    if (input) {
      var commit = function () {
        var v = parseInt(input.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 15;
        v = Math.min(200, Math.max(1, v));
        try { localStorage.setItem(DM_GOAL_KEY, String(v)); } catch (e) {}
        input.value = v;
        renderDailyMission();
        if (typeof showToast === 'function') showToast('🎯 Daily goal set: ' + v + ' new words per day.', 'success');
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
      });
      input.dataset.bound = '1';
    }
  }

  function watchDashboardActivation() {
    var sec = document.getElementById('screen-dashboard');
    if (!sec) return;
    if (typeof MutationObserver === 'function') {
      var wasActive = sec.classList.contains('active');
      new MutationObserver(function () {
        var now = sec.classList.contains('active');
        if (now && !wasActive) renderDailyMission();
        wasActive = now;
      }).observe(sec, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('themechange', function () {
      if (sec.classList.contains('active')) renderDailyMission();
    });
  }

  /* ============ STATS v4: NEW WORDS PER DAY (20.09) ============
     Сколько НОВЫХ слов активировано из Банка в каждый из последних 14 дней.
     Источник — history[день].newWords (пишет app.js submitAnswer при
     result.activated; Today's Mission и этот график считают одно и то же). */
  function renderNewWords() {
    var hist = {};
    try {
      hist = (typeof appState !== 'undefined' && appState && appState.history) ? appState.history
        : ((window.LEITNER_DATA && LEITNER_DATA.history) || {});
      if (!hist) hist = {};
    } catch (e) {}
    var today = (typeof srsToday === 'function') ? srsToday() : new Date().toISOString().slice(0, 10);
    var labels = [], data = [], total = 0;
    for (var i = 13; i >= 0; i--) {
      var iso = new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10);
      labels.push(fmtDay(iso));
      var n = Number(hist[iso] && hist[iso].newWords) || 0;
      data.push(n);
      total += n;
    }
    var emptyEl = document.getElementById('chart-newwords-empty');
    var canvas = document.getElementById('chart-newwords');
    if (emptyEl) emptyEl.hidden = total > 0;
    if (!canvas || total === 0 || typeof drawFallbackBarChart !== 'function') return;
    var green = outcomeColor('--accent-green-rgb', '16, 185, 129');
    var colors = data.map(function () { return green; });
    drawFallbackBarChart(canvas, labels, data, -1, colors, 'new word');
  }

  function renderStatsExtras() {
    try { renderOutcomes(); } catch (e) {}
    try { renderMasteryRibbon(); } catch (e) {}
    try { renderHighlights(); } catch (e) {}
    try { renderForecast(); } catch (e) {}
    try { renderNewWords(); } catch (e) {}
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

  /* ============ CARD STATS (20.09): личная статистика карточки из Dictionary ============
     Идея пользователя: рядом с «Edit»/«Delete» кнопка 📊 открывает досье слова —
     уровни обоих направлений (полоса L1..L6 в групповых цветах), даты следующего
     и последнего повторения с человеческой относительностью, темп, lifetime
     ответы/забывания и процент успеха. Модалка ИНЪЕКТИРУЕТСЯ в body этим модулем
     (в index.html её нет — фича целиком живёт в datacare.js); единственный вход
     из app.js — window.VocabaCardStats.open(cardId) по клику .btn-dict-stats. */
  function csEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function csToday() {
    return (typeof srsToday === 'function') ? srsToday() : new Date().toISOString().slice(0, 10);
  }

  function csCards() {
    try {
      if (typeof appState !== 'undefined' && appState && Object.prototype.toString.call(appState.cards) === '[object Array]') return appState.cards;
    } catch (e) {}
    return (window.LEITNER_DATA && LEITNER_DATA.cards) || [];
  }

  function csFindCard(cardId) {
    var cards = csCards();
    for (var i = 0; i < cards.length; i++) { if (cards[i] && cards[i].id === cardId) return cards[i]; }
    return null;
  }

  function csIsDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

  function csDirBlock(card, dir, today) {
    var meta = {}, level = 0, due = null, last = null;
    try {
      meta = SRS.DIRECTION_META[dir] || {};
      level = Number(card[SRS.levelKey(dir)]) || 0;
      due = card[SRS.dueKey(dir)];
      last = card['last_review_' + dir];
    } catch (e) {}
    var gname = '';
    try { gname = SRS.groupForLevel(level); } catch (e) {}
    var segs = '';
    for (var l = 1; l <= 6; l++) {
      var on = l <= level;
      var style = '';
      if (on) {
        var g = '';
        try { g = String(SRS.groupForLevel(l)).toLowerCase(); } catch (e) {}
        style = g ? ' style="background: rgba(var(--grp-' + g + '-rgb), 0.95);"' : '';
      }
      segs += '<div class="cs-seg' + (on ? ' on' : '') + '"' + style + '></div>';
    }
    var dueTxt = '—', dueCls = '';
    if (csIsDate(due)) {
      var n = 0;
      try { n = -SRS.diffDays(today, due); } catch (e) {}
      if (n < 0) { dueTxt = fmtDay(due) + ' · ' + (-n) + ' days overdue'; dueCls = ' overdue'; }
      else if (n === 0) { dueTxt = fmtDay(due) + ' · today'; dueCls = ' due-now'; }
      else if (n === 1) { dueTxt = fmtDay(due) + ' · tomorrow'; }
      else { dueTxt = fmtDay(due) + ' · in ' + n + ' days'; }
    }
    var lastTxt = 'no record yet';
    if (csIsDate(last)) {
      var el = 0;
      try { el = -SRS.diffDays(last, today); } catch (e) {}
      lastTxt = fmtDay(last) + (el === 0 ? ' · today' : ' · ' + el + ' days ago');
    }
    var interval = 0;
    try { interval = Number(SRS.INTERVALS[Math.max(0, Math.min(6, level))]) || 0; } catch (e) {}
    var pace = (level > 0 && interval > 0)
      ? ('one review every ' + interval + ' day' + (interval === 1 ? '' : 's') + ' at L' + level)
      : '—';
    var h = '<div class="cs-dirblock">';
    h += '<div class="cs-dirhead"><span>' + csEsc(meta.flag || '') + ' ' + csEsc(meta.full || dir) + '</span>'
      +  '<span class="cs-dirlevel">Level ' + level + (gname ? ' · ' + csEsc(gname) : '') + '</span></div>';
    h += '<div class="cs-levelbar">' + segs + '</div>';
    h += '<div class="cs-rows">';
    h += '<span class="cs-k">Next review</span><span class="cs-v' + dueCls + '">' + csEsc(dueTxt) + '</span>';
    h += '<span class="cs-k">Last recall</span><span class="cs-v">' + csEsc(lastTxt) + '</span>';
    h += '<span class="cs-k">Pace</span><span class="cs-v">' + csEsc(pace) + '</span>';
    h += '</div></div>';
    return h;
  }

  function csRenderBody(card) {
    var today = csToday();
    var inBank = true, group = 'BANK';
    try { inBank = SRS.isBank(card); group = String(SRS.derivedGroup(card)); } catch (e) {}
    var pos = '';
    try { pos = SRS.posText(card.part_of_speech != null ? card.part_of_speech : card.partOfSpeech) || ''; } catch (e) {}
    var html = '<div class="cs-wordline">';
    html += '<span class="cs-word">' + csEsc(card.word) + '</span>';
    html += '<button class="btn-speak" id="cs-speak" title="Listen to pronunciation" aria-label="Listen to word">🔊</button>';
    if (card.phonetic && String(card.phonetic).trim() !== '') html += '<span class="cs-phonetic">' + csEsc(card.phonetic) + '</span>';
    html += '</div>';
    html += '<div class="cs-translation">' + csEsc(card.translation) + '</div>';
    html += '<div class="cs-meta">';
    if (pos) html += '<span class="badge pos-other" style="text-transform: capitalize;">' + csEsc(pos) + '</span>';
    html += '<span class="badge grp-badge grp-' + csEsc(group.toLowerCase()) + '">' + csEsc(inBank ? '🏦 Bank' : group) + '</span>';
    if (csIsDate(card.created_at)) {
      var age = 0;
      try { age = -SRS.diffDays(String(card.created_at), today); } catch (e) {}
      html += '<span>Added ' + (age <= 0 ? 'today' : age + ' days ago') + '</span>';
    }
    if (card.batch_name) html += '<span>Batch: ' + csEsc(card.batch_name) + '</span>';
    html += '</div>';

    if (inBank) {
      html += '<div class="cs-bank-note">🏦 Resting in the Bank — not studied yet. Any Learn session (or the 🌱 mission tile) activates it, and the full per-direction stats will appear here.</div>';
    } else {
      html += csDirBlock(card, 'en_ru', today);
      html += csDirBlock(card, 'ru_en', today);
    }

    var rc = Number(card.review_count) || 0;
    var fc = Number(card.fail_count) || 0;
    // Кламп 0..100: в старых/посевных данных fail_count может превышать
    // review_count (счётчики велись раздельно) — отрицательный процент не показываем.
    var pct = rc > 0 ? Math.min(100, Math.max(0, Math.round(((rc - fc) / rc) * 100))) : null;
    html += '<div class="cs-lifetime">';
    html += '<div class="cs-lifetime-head">Lifetime · both directions</div>';
    html += '<div class="cs-rows">';
    html += '<span class="cs-k">Answers given</span><span class="cs-v cs-answers-val">' + rc + '</span>';
    html += '<span class="cs-k">Times forgotten</span><span class="cs-v">' + fc + '</span>';
    html += '<span class="cs-k">Success rate</span><span class="cs-v cs-success-val">' + (pct === null ? '—' : pct + '%') + '</span>';
    html += '</div>';
    if (pct !== null) html += '<div class="cs-success-track"><div class="cs-success-fill" style="width:' + pct + '%;"></div></div>';
    html += '</div>';
    return html;
  }

  function csClose() {
    var overlay = document.getElementById('modal-card-stats');
    if (overlay) overlay.classList.add('hidden');
  }

  function csEnsureModal() {
    // Скелет модалки статично живёт в index.html (id покрыт check.cjs);
    // фолбэк-инъекция сохраняет модуль самодостаточным, если разметки нет.
    var overlay = document.getElementById('modal-card-stats');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'modal-card-stats';
      overlay.className = 'modal-overlay hidden';
      overlay.innerHTML =
        '<div class="modal-content glass-card cs-modal" role="dialog" aria-modal="true" aria-labelledby="cs-title">' +
          '<div class="modal-header">' +
            '<h3 id="cs-title">📊 Card Stats</h3>' +
            '<button class="btn-close-modal" id="cs-close" aria-label="Close">✖</button>' +
          '</div>' +
          '<div id="cs-body" class="cs-body"></div>' +
        '</div>';
      document.body.appendChild(overlay);
    }
    if (overlay.dataset.csBound === '1') return;
    overlay.dataset.csBound = '1';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) csClose(); });
    var closeBtn = document.getElementById('cs-close');
    if (closeBtn) closeBtn.addEventListener('click', csClose);
    // Страховка от Escape: app.js закрывает модалку своим capture-слушателем
    // window (modal-card-stats включён в его priority-1 список), а этот
    // документ-слушатель гасит всплытие, если модалка ещё видима.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
        e.stopPropagation();
        csClose();
      }
    }, true);
  }

  function csOpen(cardId) {
    csEnsureModal();
    var overlay = document.getElementById('modal-card-stats');
    var body = document.getElementById('cs-body');
    if (!overlay || !body) return;
    var card = csFindCard(cardId);
    if (!card) {
      body.innerHTML = '<p class="cs-empty">Card not found — it may have been deleted.</p>';
      overlay.classList.remove('hidden');
      return;
    }
    body.innerHTML = csRenderBody(card);
    overlay.classList.remove('hidden');
    var speak = document.getElementById('cs-speak');
    if (speak && typeof attachSpeakHandler === 'function') {
      try { attachSpeakHandler(speak, card.word); } catch (e) {}
    }
  }

  window.VocabaCardStats = { open: csOpen, close: csClose };

  /* ============ DAILY REMINDERS (20.09, sam-сессия) — завершение исходного
     запроса пользователя «дневные задания И напоминания»: панель Mission (задания)
     была, системных напоминаний (напоминания) не было. Electron renderer поддерживает
     HTML5 Notification нативно (без правок main.js — не лезть в чужую территорию).
     Стратегия: негавристичная, не спамит. Тикает на старте + раз в 25 мин; будит лишь
     если Mission НЕ закрыта (есть due-долг ИЛИ не достигнута цель новых слов);
     троттл ≤ 1 напоминания в час (localStorage-штамп); клик → фокус окна + дашборд.
     Отключение: localStorage 'vocaba_reminders' = '0' (UI-тоггл — future nice-to-have). */
  var REMINDER_KEY = 'vocaba_last_reminder';
  var REMINDERS_ENABLED_KEY = 'vocaba_reminders';
  var REMINDER_THROTTLE_MS = 60 * 60 * 1000;   // не чаще раза в час
  var REMINDER_TICK_MS = 25 * 60 * 1000;       // проверка раз в 25 мин
  var REMINDER_FIRST_MS = 90 * 1000;           // первая проверка через 90с после старта

  function remindersEnabled() {
    try { return localStorage.getItem(REMINDERS_ENABLED_KEY) !== '0'; } catch (e) { return true; }
  }

  // Лёгкий пересчёт статуса Mission из тех же источников, что renderDailyMission —
  // изолирован от DOM-рендера, доступен тестам через window.VocabaReminder.
  function missionStatus(today) {
    var goal = dmGoal();
    var day = dmDay(today);
    var learned = Number(day && day.newWords) || 0;
    var debt = 0;
    try {
      if (typeof SRS !== 'undefined' && typeof SRS.buildReviewQueue === 'function') {
        debt = (SRS.buildReviewQueue(dmCards(), today, {}) || []).length;
      }
    } catch (e) {}
    var completedToday = 0;
    try {
      var bd = (day && day.byDirection) || {};
      ['en_ru', 'ru_en'].forEach(function (dir) { completedToday += Number(bd[dir] && bd[dir].total) || 0; });
    } catch (e) {}
    return {
      learned: learned, goal: goal, debt: debt, completedToday: completedToday,
      reviewDone: debt === 0, learnDone: learned >= goal
    };
  }

  function notify(title, body) {
    try {
      if (typeof Notification === 'undefined') return false;
      if (Notification.permission === 'denied') return false;
      if (Notification.permission !== 'granted') return false;
      var n = new Notification(title, { body: body, icon: 'icon.png' });
      // Клик → поднять окно (window.focus в Electron работает из рендерера) и открыть
      // дашборд с Mission. switchScreen — протёкшая функция app.js (typeof-guard).
      n.onclick = function () {
        try { if (typeof window.focus === 'function') window.focus(); } catch (e) {}
        try { if (typeof switchScreen === 'function') switchScreen('dashboard'); } catch (e) {}
        try { n.close(); } catch (e) {}
      };
      return true;
    } catch (e) { return false; }
  }

  function lastReminderTs() {
    try { return parseInt(localStorage.getItem(REMINDER_KEY), 10) || 0; } catch (e) { return 0; }
  }
  function markReminder(ts) {
    try { localStorage.setItem(REMINDER_KEY, String(ts)); } catch (e) {}
  }

  // force=true обходит троттл (для тестов и ручного «напомни сейчас»).
  function maybeRemind(force) {
    if (!remindersEnabled()) return null;
    var now = Date.now();
    if (!force && (now - lastReminderTs()) < REMINDER_THROTTLE_MS) return null;
    var today = csToday();
    var st = missionStatus(today);
    if (st.reviewDone && st.learnDone) return null;   // Mission закрыта — не тревожим
    var parts = [];
    if (!st.reviewDone) parts.push('🔥 ' + st.debt + ' review' + (st.debt === 1 ? '' : 's') + ' still due');
    if (!st.learnDone) parts.push('🌱 ' + st.learned + '/' + st.goal + ' new words');
    if (!parts.length) return null;
    var body = parts.join(' · ');
    var ok = notify('Vocaba — Today\'s Mission', body);
    if (ok) markReminder(now);
    return { body: body, ok: ok };
  }

  function requestReminderPermission() {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default' && typeof Notification.requestPermission === 'function') {
        var r = Notification.requestPermission();
        if (r && typeof r.then === 'function') r.then(function () {});
      }
    } catch (e) {}
  }

  var reminderTimer = null;
  var reminderFirstTimer = null;
  function startReminders() {
    requestReminderPermission();
    if (reminderFirstTimer) clearTimeout(reminderFirstTimer);
    reminderFirstTimer = setTimeout(function () { try { maybeRemind(false); } catch (e) {} }, REMINDER_FIRST_MS);
    if (reminderTimer) clearInterval(reminderTimer);
    reminderTimer = setInterval(function () { try { maybeRemind(false); } catch (e) {} }, REMINDER_TICK_MS);
  }

  window.VocabaReminder = {
    missionStatus: missionStatus, notify: notify, maybeRemind: maybeRemind,
    startReminders: startReminders
  };

  // (20.09, F1 аудита) app.js зовёт VocabaMission.render() после loadData —
  // иначе Mission-плитки стейл («0 due») на первом запуске (гонка init ↔ loadData).
  window.VocabaMission = { render: renderDailyMission };

  function init() {
    wire();
    watchActivation();
    renderStats();
    watchStatsActivation();
    renderStatsExtras();
    wireDailyMission();
    watchDashboardActivation();
    renderDailyMission();
    startReminders();   // (20.09) ежедневные напоминания — завершение исходного запроса «и напоминания»
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
