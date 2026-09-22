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
    renderReminderBanner();   // (21.09) видимая полоса-напоминание на дашборде
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
    html += '<button class="btn btn-secondary" id="cs-trash" style="margin-top:12px;width:100%;padding:8px;color:var(--accent-red);">🗑️ Move to Trash</button>';
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
    var trashBtn = document.getElementById('cs-trash');
    if (trashBtn && window.VocabaTrash) {
      trashBtn.onclick = function () {
        if (window.VocabaTrash.trashCard(card.id)) {
          csClose();
          if (typeof renderDictionary === 'function') renderDictionary();
          if (typeof renderDashboard === 'function') renderDashboard();
          if (typeof showToast === 'function') showToast('🗑️ Moved to Trash — out of repetition.', 'info');
        }
      };
    }
  }

  window.VocabaCardStats = { open: csOpen, close: csClose };

  /* ============ TRASH (21.09) — «мусорка» для слов. Карточка переносом
     уходит из appState.cards в localStorage('vocaba_trash') (полный снимок):
     тем самым автоматически выпадает из ВСЕХ SRS-очередей (build*Queue
     итерируют appState.cards) и прячется из словаря (renderDictionary рисует
     только appState.cards). validateState пропускает shrink через removedIds.
     Восстановление — обратный перенос. Словарь показывает мусор как
     псевдо-карточку 🗑️ Trash в конце сетки (поиск 'trash' её находит); клик
     открывает модалку со списком + ↩ Restore. Перенос инициируется кнопкой
     «🗑️ Move to Trash» в Card Stats (📊) — это и есть «зайти в само слово». */
  var TRASH_KEY = 'vocaba_trash';

  function trashLoad() {
    try { return JSON.parse(localStorage.getItem(TRASH_KEY)) || []; } catch (e) { return []; }
  }
  function trashSave(arr) {
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(arr || [])); } catch (e) {}
  }
  function trashCount() { return trashLoad().length; }
  function trashFind(cardId) {
    var arr = trashLoad();
    for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i].id === cardId) return i; }
    return -1;
  }

  // saveData асинхронен (Promise) — глотаем и sync-бросок, и rejection,
  // чтобы перенос в мусорку не падал на IPC/сериализации в любом окружении.
  function trashPersist(args) {
    try {
      if (typeof saveData !== 'function') return;
      var _p = args ? saveData(args) : saveData();
      if (_p && typeof _p.then === 'function') _p.catch(function () {});
    } catch (e) {}
  }

  function trashCard(cardId) {
    if (!appState || !Array.isArray(appState.cards)) return false;
    var idx = -1, snap = null;
    for (var i = 0; i < appState.cards.length; i++) {
      if (appState.cards[i] && appState.cards[i].id === cardId) { idx = i; snap = JSON.parse(JSON.stringify(appState.cards[i])); break; }
    }
    if (idx < 0 || !snap) return false;
    var arr = trashLoad();
    if (trashFind(cardId) < 0) arr.unshift(snap);   // свежие сверху, без дублей
    trashSave(arr);
    appState.cards.splice(idx, 1);
    trashPersist({ removedIds: [cardId] });
    return true;
  }
  function restoreCard(cardId) {
    var arr = trashLoad();
    var at = trashFind(cardId);
    if (at < 0) return false;
    var snap = arr[at];
    arr.splice(at, 1);
    trashSave(arr);
    if (appState && Array.isArray(appState.cards)) {
      var dup = -1;
      for (var i = 0; i < appState.cards.length; i++) { if (appState.cards[i] && appState.cards[i].id === cardId) { dup = i; break; } }
      if (dup < 0) appState.cards.push(snap);
    }
    trashPersist();
    return true;
  }

  // Псевдо-карточка для конца словарной сетки (показывается, если в мусоре
  // что-то есть И (нет поискового запроса) ИЛИ запрос содержит 'trash').
  function trashCardEl() {
    var el = document.createElement('div');
    el.className = 'dict-card trash-card';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Open Trash');
    el.style.cssText = 'cursor:pointer;display:flex;flex-direction:column;gap:6px;padding:16px;border:1px dashed var(--accent);border-radius:12px;background:rgba(var(--overlay-rgb),0.05);';
    var n = trashCount();
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600;color:var(--accent);';
    head.textContent = '🗑️ Trash';
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:var(--text-muted);';
    sub.textContent = n + ' word' + (n === 1 ? '' : 's') + ' archived — out of SRS. Click to manage.';
    el.appendChild(head); el.appendChild(sub);
    el.onclick = function () { trashOpen(); };
    return el;
  }

  function trashEnsureModal() {
    var ov = document.getElementById('modal-trash');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'modal-trash';
      ov.className = 'modal-overlay hidden';
      ov.innerHTML = '<div class="modal-content glass-card" role="dialog" aria-modal="true" aria-labelledby="trash-title" style="max-width:560px;">'
        + '<div class="modal-header"><h3 id="trash-title">🗑️ Trash</h3>'
        + '<button class="btn-close-modal" id="trash-close" aria-label="Close">✖</button></div>'
        + '<div id="trash-body" style="padding:12px 16px;max-height:60vh;overflow:auto;"></div></div>';
      document.body.appendChild(ov);
    }
    var cl = document.getElementById('trash-close');
    if (cl) cl.onclick = function () { trashClose(); };
    return ov;
  }
  function trashRenderBody() {
    var body = document.getElementById('trash-body');
    if (!body) return;
    var arr = trashLoad();
    body.innerHTML = '';
    if (!arr.length) {
      body.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Trash is empty. Move words here from a card\'s 📊 Stats view to hide them from the dictionary and pause their repetition.</p>';
      return;
    }
    arr.forEach(function (c) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid rgba(var(--overlay-rgb),0.12);border-radius:8px;margin-bottom:6px;';
      var left = document.createElement('div');
      var w = document.createElement('b'); w.textContent = c.word || ''; left.appendChild(w);
      var t = document.createElement('span'); t.style.cssText = 'color:var(--text-muted);margin-left:8px;font-size:13px;'; t.textContent = '— ' + (c.translation || ''); left.appendChild(t);
      var btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'padding:4px 10px;font-size:12px;';
      btn.textContent = '↩ Restore';
      btn.onclick = function () {
        restoreCard(c.id);
        trashRenderBody();
        if (typeof renderDictionary === 'function') renderDictionary();
        if (typeof renderDashboard === 'function') renderDashboard();
      };
      row.appendChild(left); row.appendChild(btn);
      body.appendChild(row);
    });
  }
  function trashOpen() { var ov = trashEnsureModal(); trashRenderBody(); ov.classList.remove('hidden'); }
  function trashClose() { var ov = document.getElementById('modal-trash'); if (ov) ov.classList.add('hidden'); }

  window.VocabaTrash = {
    trashCard: trashCard, restoreCard: restoreCard, trashCount: trashCount,
    trashCardEl: trashCardEl, open: trashOpen, close: trashClose, trashLoad: trashLoad
  };

  /* ============ MISSION STATUS (21.09) — лёгкий пересчёт для in-app баннера
     (renderReminderBanner). ОС-нотификации УБРАНЫ 21.09 (фидбек: запрос разрешения
     каждый запуск раздражал). Напоминание теперь только видимое — полоса #dm-reminder
     на дашборде, без запроса прав. */
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

  window.VocabaReminder = { missionStatus: missionStatus };

  /* ============ IN-APP REMINDER BANNER (21.09) — «простенькая система
     напоминаний» для веб-приложения. ОС-нотификации (VocabaReminder.notify)
     системные — могут блокироваться правами/теряться во вкладке. Эта полоса
     видима прямо на дашборде, пока дневная Mission не закрыта, и закрывается
     на день (✖ → localStorage = today). Ре-рендерится из renderDailyMission
     (а значит и при активации дашборда). Элемент создаётся динамически — id не
     обязан быть в index.html (check.cjs id-coverage сканирует только app.js). */
  var REMINDER_DISMISS_KEY = 'vocaba_reminder_dismissed';

  function reminderDismissedToday(today) {
    try { return (localStorage.getItem(REMINDER_DISMISS_KEY) || '') === today; } catch (e) { return false; }
  }
  function dismissReminder(today) {
    try { localStorage.setItem(REMINDER_DISMISS_KEY, today); } catch (e) {}
  }

  function renderReminderBanner() {
    var dm = document.getElementById('daily-mission');
    if (!dm || !dm.parentNode) return;
    var el = document.getElementById('dm-reminder');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dm-reminder';
      el.className = 'section-card dm-reminder';
      el.style.cssText = 'display:none;align-items:center;gap:12px;padding:12px 16px;background:rgba(var(--overlay-rgb),0.08);border:1px solid var(--accent);border-radius:12px;flex-wrap:wrap;margin-bottom:12px;';
      dm.parentNode.insertBefore(el, dm);
    }
    var today = (typeof srsToday === 'function') ? srsToday() : new Date().toISOString().slice(0, 10);
    var st = missionStatus(today);
    var incomplete = !st.reviewDone || !st.learnDone;
    if (!incomplete || reminderDismissedToday(today)) { el.style.display = 'none'; el.innerHTML = ''; return; }
    var parts = [];
    if (!st.reviewDone) parts.push('🔥 ' + st.debt + ' review' + (st.debt === 1 ? '' : 's') + ' due');
    if (!st.learnDone) parts.push('🌱 ' + st.learned + '/' + st.goal + ' new words');
    el.innerHTML = '';
    var msg = document.createElement('span');
    msg.style.cssText = 'flex:1;min-width:180px;font-size:14px;color:var(--text-main);';
    msg.textContent = '⏰ Daily mission not done — ' + parts.join(' · ') + ' left for today.';
    var btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.style.cssText = 'padding:6px 14px;font-size:13px;';
    btn.textContent = 'Practice now';
    btn.onclick = function () {
      try { if (typeof switchScreen === 'function') switchScreen('training'); } catch (e) {}
      try { if (typeof startTrainingSession === 'function') startTrainingSession('critical'); } catch (e) {}
    };
    var close = document.createElement('button');
    close.className = 'btn btn-secondary';
    close.style.cssText = 'padding:4px 10px;font-size:13px;line-height:1;';
    close.title = 'Hide until tomorrow';
    close.textContent = '✖';
    close.onclick = function () { dismissReminder(today); renderReminderBanner(); };
    el.appendChild(msg); el.appendChild(btn); el.appendChild(close);
    el.style.display = '';
  }
  window.VocabaReminder.renderBanner = renderReminderBanner;

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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
