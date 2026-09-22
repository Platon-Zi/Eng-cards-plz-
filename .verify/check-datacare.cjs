/* ==========================================================================
   .verify/check-datacare.cjs — поведение экрана Data & Backup (бывший нижний
   блок сайдбара) и его мозгов datacare.js: KPI-строка, кнопки копирования,
   переход в гайд. Загружает ВСЕ шесть скриптов в производственном порядке.

   Запуск:  node .verify/check-datacare.cjs
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { JSDOM, VirtualConsole } = require(path.join(__dirname, 'node_modules', 'jsdom'));

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 160)));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const dom = new JSDOM(html, {
  runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/'
});
const w = dom.window, d = w.document;
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, p) => (p === 'canvas' ? null : () => {}) });
w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [] };
w.SpeechSynthesisUtterance = function () {};
let copied = null;
try {
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: (txt) => { copied = txt; return Promise.resolve(); } }, configurable: true });
} catch (e) { errors.push('clipboard stub: ' + e.message); }

// (21.09) ОС-нотификации убраны (запрос разрешения раздражал) — in-app баннер #dm-reminder их заменяет.

// В РЕАЛЬНОЙ разметке все классические <script> делят ОДИН global lexical
// scope: top-level `let appState` из app.js виден из datacare.js. В jsdom
// отдельные w.eval() НЕ разделяют let, поэтому склеиваем все шесть скриптов
// в один eval — это воспроизводит браузерную семантику ровно.
const SRC = ['data/leitner_data.js', 'srs.js', 'app.js', 'theme.js', 'polish.js', 'datacare.js']
  .map(f => '/*== ' + f + ' ==*/\n' + fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n;\n');
try { w.eval(SRC); } catch (e) { errors.push('bundle eval: ' + e.message); }

const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const rec = (name, ok, evidence) => checks.push({ name, ok: !!ok, evidence: evidence == null ? '' : String(evidence) });
const $ = sel => d.querySelector(sel);
  const $$ = (sel) => [...d.querySelectorAll(sel)];

(async () => {
  await wait(1500);

  // ── 1. каркас экрана и навигации ──────────────────────────────────────────
  rec('экран #screen-data существует', !!$('#screen-data'));
  rec('nav-кнопка 🛡️ Data & Backup в левом меню',
    !!d.querySelector('.nav-btn[data-screen="data"]'));
  rec('сайдбокс quick-train-box из разметки убран', !d.querySelector('.quick-train-box'));
  ['btn-backup-json', 'btn-restore-json', 'input-restore-json-file', 'btn-copy-english-list']
    .forEach(id => rec(`перенесённый id сохранён: #${id}`, !!d.getElementById(id)));
  rec('единственный вхождение перенесённых id (без дублей)',
    ['btn-backup-json', 'btn-restore-json', 'btn-copy-english-list', 'input-restore-json-file']
      .every(id => [...d.querySelectorAll('[id="' + id + '"]')].length === 1));
  rec('новые инструменты на месте: lines/trans/guide',
    !!$('#btn-copy-words-lines') && !!$('#btn-copy-words-trans') && !!$('#btn-data-open-guide'));

  // ── 2. KPI-строка считает живые данные ────────────────────────────────────
  w.eval("switchScreen('data')");
  await wait(120);
  rec('switchScreen("data") делает экран активным', $('#screen-data').classList.contains('active'));
  // total берём из window.LEITNER_DATA (глобал-источник для appState.cards)
  const total = Number(w.eval('window.LEITNER_DATA.cards.length'));
  const shown = id => ($('#' + id).textContent || '').trim();
  rec('KPI total совпадает с appState.cards', shown('data-stat-total') === String(total), `${shown('data-stat-total')} vs ${total}`);
  const bank = Number(shown('data-stat-bank')), act = Number(shown('data-stat-active')), due = Number(shown('data-stat-due'));
  rec('KPI active + bank = total', act + bank === total, `${act}+${bank} vs ${total}`);
  rec('KPI due в разумных границах (0..total)', due >= 0 && due <= total, `due=${due}`);

  // ── 3. кнопка «одним столбиком» ───────────────────────────────────────────
  copied = null;
  $('#btn-copy-words-lines').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(60);
  const lines = (copied || '').split('\n').filter(Boolean);
  rec('words-lines: непустой буфер обмена', !!copied && lines.length > 100, `${lines.length} строк`);
  rec('words-lines: без переводов и без «—»', !/[—\u0400-\u04FF]/.test(copied || ''));

  // ── 4. кнопка «word — translation» ────────────────────────────────────────
  copied = null;
  $('#btn-copy-words-trans').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(60);
  const pairs = (copied || '').split('\n').filter(Boolean);
  const withTrans = pairs.filter(l => l.includes(' — ')).length;
  rec('word-trans: строки с разделителем « — »', withTrans > pairs.length * 0.5, `${withTrans}/${pairs.length}`);
  rec('word-trans: есть кириллица (переводы)', /[\u0400-\u04FF]/.test(copied || ''));

  // ── 5. переход в гайд ─────────────────────────────────────────────────────
  $('#btn-data-open-guide').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(120);
  rec('кнопка гайдa открывает #screen-guide', $('#screen-guide').classList.contains('active'));
  rec('ушёл с data-экрана', !$('#screen-data').classList.contains('active'));

  // ── 6. гайд больше не обещает «левую панель» ─────────────────────────────
  const guideText = $('#screen-guide').textContent;
  rec('EN-гайд: ссылки на «left panel» не осталось', !/left panel/i.test(guideText));
  rec('RU-гайд: ссылки на «левой панели» не осталось', !/левой панели/i.test(guideText));

  // ── 7. STATS v2: outcomes donut + direction bars ──────────────────────────
  w.eval("switchScreen('stats')");
  await wait(150);
  rec('switchScreen("stats") делает экран активным', $('#screen-stats').classList.contains('active'));
  rec('пояснения .stat-explain ≥6', $('#screen-stats').querySelectorAll('.stat-explain').length >= 6,
    String($('#screen-stats').querySelectorAll('.stat-explain').length));
  const pe = ($('#ds-en-ru-pct').textContent || '').trim();
  const pr = ($('#ds-ru-en-pct').textContent || '').trim();
  rec('dir pcts отрендерены (NN% или —)', (/^\d{1,3}%$/.test(pe) || pe === '—') && (/^\d{1,3}%$/.test(pr) || pr === '—'), pe + ' / ' + pr);
  const histGrand = Number(w.eval(`(function(){var h=(window.LEITNER_DATA.history||{});var g=0;Object.keys(h).forEach(function(k){var b=(h[k]||{}).byAnswer||{};g+=(b.again||0)+(b.hard||0)+(b.easy||0);});return g;})()`));
  const emptyHidden = $('#chart-outcomes-empty').hidden;
  rec('empty-state консистентен с историей', emptyHidden === (histGrand > 0), `history=${histGrand} hidden=${emptyHidden}`);
  const weakerTags = [$('#ds-en-ru-tag').textContent, $('#ds-ru-en-tag').textContent].filter(x => x === 'weaker').length;
  rec('тег weaker не более одного', weakerTags <= 1, String(weakerTags));
  rec('пояснения есть у всех четырёх старых секций',
    ['14-Day Activity', 'Knowledge Group Distribution', 'Activity Heatmap', 'Hard Words'].every(h3text => {
      const h3 = [...$('#screen-stats').querySelectorAll('h3')].find(x => x.textContent.includes(h3text));
      return h3 && h3.parentElement.parentElement.querySelector('.stat-explain');
    }));

  // ── 8. STATS v3: ribbon + highlights ──────────────────────────────────────
  const segs = $$('#mastery-ribbon .mseg');
  rec('лента: 6 сегментов-кнопок', segs.length === 6, String(segs.length));
  rec('лента: ненулевые сегменты кликабельны', segs.every(sg => sg.style.width === '0%' ? sg.disabled : !sg.disabled));
  rec('легенда: 6 чипов с числами', $$('#ribbon-legend .rl-chip').length === 6 &&
    $$('#ribbon-legend .rl-count').every(x => /^\d+$/.test(x.textContent.trim())));
  const hlIds = ['hl-total-answers', 'hl-best-day', 'hl-best-streak', 'hl-perfect-days'];
  rec('highlights заполнены (число/тире+дата, без пустот)', hlIds.every(id => ($('#' + id).textContent || '').trim().length > 0),
    hlIds.map(id => id + '=' + $('#' + id).textContent).join(' '));
  const ribbonSum = $$('#ribbon-legend .rl-count').reduce((a, x) => a + Number(x.textContent), 0);
  rec('легенда: сумма = размер базы', ribbonSum === Number(w.LEITNER_DATA.cards.length), ribbonSum + ' vs ' + w.LEITNER_DATA.cards.length);
  rec('тултип графиков в разметке и скрыт', !!$('#chart-tooltip') && $('#chart-tooltip').hidden);

  // ── 9. Регрессия: click-биндинг доната переживает перерисовки ─────────────
  // Баг из browser-ревью: hover-redraw пересоздавал canvas._chart и терял
  // .click, поэтому клик по срезу (всегда предваряемый наведением) не работал.
  const clickSurvives = w.eval(`(function(){
    var c = document.getElementById('chart-stages');
    if (!c || typeof drawFallbackDonutChart !== 'function') return 'skip';
    drawFallbackDonutChart(c, ['A','B'], [3,7], ['#f00','#0f0']);
    c._chart.click = function(){ window.__clickFired = true; };
    c._chart.redraw(0);
    if (typeof c._chart.click !== 'function') return 'lost-on-hover-redraw';
    drawFallbackDonutChart(c, ['A','B'], [3,7], ['#f00','#0f0']);
    if (typeof c._chart.click !== 'function') return 'lost-on-full-redraw';
    c._chart.click(0);
    return window.__clickFired ? 'ok' : 'handler-not-fired';
  })()`);
  rec('клик по срезу переживает перерисовки (регрессия ревью)',
    clickSurvives === 'ok' || clickSurvives === 'skip', clickSurvives);

  // ── 10. STATS v4: прогноз Upcoming Load (детерминированно: фиксированный «сегодня») ──
  // Перехватываем srsToday и дёргаем themechange (datacare слушает его на window) —
  // прогноз перерисовывается на фиксированной дате, независимой от wall-clock.
  w.eval(`srsToday = function () { return '2026-09-19'; }; window.dispatchEvent(new CustomEvent('themechange'));`);
  const FC_TODAY = '2026-09-19';
  let fcSum = 0, fcNow = 0;
  (w.LEITNER_DATA.cards || []).forEach(c => {
    if (!c || String(c.status || '').toUpperCase() !== 'ACTIVE') return;
    ['en_ru', 'ru_en'].forEach(dir => {
      const due = c['next_review_' + dir];
      if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return;
      const delta = Math.round((Date.parse(due) - Date.parse(FC_TODAY)) / 86400000);
      if (delta <= 0) { fcSum++; fcNow++; }
      else if (delta <= 13) fcSum++;
    });
  });
  const fcCanvas = $('#chart-forecast'), fcEmpty = $('#chart-forecast-empty');
  rec('прогноз: canvas и empty-state в разметке', !!fcCanvas && !!fcEmpty);
  rec('прогноз: empty-state согласован с расписанием', !!fcEmpty && fcEmpty.hidden === (fcSum > 0),
    `sum=${fcSum}, hidden=${fcEmpty && fcEmpty.hidden}`);
  rec('прогноз: сид-база даёт ненулевое расписание (иначе проверка деградировала)', fcSum > 0, String(fcSum));
  if (fcSum > 0 && fcCanvas) {
    rec('прогноз: _chart построен (bar)', !!(fcCanvas._chart && fcCanvas._chart.kind === 'bar'));
    rec('прогноз: первая колонка — "now" с числом просроченных',
      !!(fcCanvas._chart && typeof fcCanvas._chart.tipFor === 'function'
        && /now/i.test(fcCanvas._chart.tipFor(0))
        && fcCanvas._chart.tipFor(0).includes(String(fcNow))),
      fcCanvas._chart && String(fcCanvas._chart.tipFor && fcCanvas._chart.tipFor(0)));
    if (fcNow > 0) {
      rec('прогноз: клик по "now" запускает Practice (bound)', typeof fcCanvas._chart.click === 'function');
      const fcClickSurvives = w.eval(`(function(){
        var c = document.getElementById('chart-forecast');
        if (!c || !c._chart || typeof c._chart.redraw !== 'function') return 'skip';
        c._chart.redraw(0);
        return typeof c._chart.click === 'function' ? 'ok' : 'lost';
      })()`);
      rec('прогноз: click переживает hover-redraw', fcClickSurvives === 'ok' || fcClickSurvives === 'skip', fcClickSurvives);
    }
  }

  // ── 11. Today's Mission: дневной минимум (критическое повторение СЛЕВА, новые слова СПРАВА) ──
  // srsToday уже зафиксирован §10 ('2026-09-19'); переключаем на dashboard и
  // синхронно перерисовываем панель themechange-событием (listener на window).
  w.eval(`switchScreen('dashboard'); window.dispatchEvent(new CustomEvent('themechange'));`);
  const dmRaw = w.eval(`(function () {
    var cards = (typeof appState !== 'undefined' && appState && Object.prototype.toString.call(appState.cards) === '[object Array]')
      ? appState.cards : ((window.LEITNER_DATA && LEITNER_DATA.cards) || []);
    var dueItems = [];
    try { dueItems = SRS.buildReviewQueue(cards, srsToday(), {}) || []; } catch (e) {}
    var criticalItems = window.VocabaCritical ? window.VocabaCritical.select(dueItems, cards, srsToday()) : dueItems;
    var hist = (typeof appState !== 'undefined' && appState && appState.history) ? appState.history : ((window.LEITNER_DATA && LEITNER_DATA.history) || {});
    var day = hist[srsToday()] || {};
    var g = function (id) { var e = document.getElementById(id); return e ? e.textContent : null; };
    var title = function (id) { var e = document.getElementById(id); return e ? e.title : null; };
    var bg = function (id) { var e = document.getElementById(id); return (e && e.style && e.style.background) || ''; };
    var input = document.getElementById('dm-goal-input');
    var firstTile = document.querySelector('#daily-mission .dm-tile');
    return JSON.stringify({
      due: dueItems.length,
      expectedCritical: criticalItems.length,
      cap: window.VocabaCritical ? window.VocabaCritical.CAP : null,
      revNum: g('dm-review-num'),
      learnNum: g('dm-learn-num'),
      reviewTitle: title('dm-review'),
      learnTitle: title('dm-learn'),
      expectedLearned: Number(day.newWords) || 0,
      goalVal: input ? Number(input.value) : null,
      date: g('dm-date'),
      firstTileIsReview: !!(firstTile && firstTile.id === 'dm-review'),
      boundLearn: !!(document.getElementById('dm-learn') && document.getElementById('dm-learn').dataset.bound === '1'),
      boundReview: !!(document.getElementById('dm-review') && document.getElementById('dm-review').dataset.bound === '1'),
      boundInput: !!(input && input.dataset.bound === '1'),
      ringRevBg: bg('dm-ring-review'),
      ringLearnBg: bg('dm-ring-learn'),
      reviewText: document.getElementById('dm-review').textContent || '',
      learnText: document.getElementById('dm-learn').textContent || ''
    });
  })()`);
  const dmData = JSON.parse(dmRaw);
  rec('миссия: панель и обе плитки в разметке',
    !!$('#daily-mission') && !!$('#dm-learn') && !!$('#dm-review') && !!$('#dm-goal-input'));
  rec('миссия: повторения СЛЕВА, новые слова СПРАВА (порядок плиток)', dmData.firstTileIsReview === true);
  const dmTileLen = Math.max(
    dmData.reviewText.replace(/\s+/g, ' ').trim().length,
    dmData.learnText.replace(/\s+/g, ' ').trim().length
  );
  rec('миссия: плитки минималистичны — только цифра и подпись',
    dmTileLen <= 22, `len=${dmTileLen} «${dmData.reviewText.replace(/\s+/g, ' ').trim()}»`);
  rec('миссия: центр кольца review = долг дня (весь due)',
    dmData.revNum === String(dmData.due), `${dmData.revNum} vs due ${dmData.due}`);
  rec('миссия: критический минимум живёт в тултипе и ≤ CAP ≤ due',
    /worst \d+/.test(dmData.reviewTitle || '')
      && dmData.expectedCritical <= dmData.cap
      && dmData.expectedCritical <= dmData.due,
    `${dmData.reviewTitle} | critical=${dmData.expectedCritical}, cap=${dmData.cap}, due=${dmData.due}`);
  rec('миссия: центр кольца learn = «learned/goal»',
    dmData.learnNum === dmData.expectedLearned + '/' + dmData.goalVal,
    `${dmData.learnNum} при learned=${dmData.expectedLearned}, goal=${dmData.goalVal}`);
  rec('миссия: оба кольца — conic-gradient из JS',
    /conic-gradient/.test(dmData.ringRevBg) && /conic-gradient/.test(dmData.ringLearnBg),
    dmData.ringRevBg.slice(0, 40) + ' / ' + dmData.ringLearnBg.slice(0, 40));
  rec('миссия: дефолтная цель 15, дата непустая', dmData.goalVal === 15 && !!dmData.date, `goal=${dmData.goalVal} date=${dmData.date}`);
  rec('миссия: плитки и input заваершены (dataset.bound)',
    dmData.boundLearn && dmData.boundReview && dmData.boundInput);

  // смена цели: localStorage + перерисовка центра кольца
  w.eval(`(function () {
    var i = document.getElementById('dm-goal-input');
    i.value = '25';
    i.dispatchEvent(new window.Event('change'));
  })()`);
  const dm2 = JSON.parse(w.eval(`JSON.stringify({
    stored: localStorage.getItem('vocaba_daily_goal'),
    num: document.getElementById('dm-learn-num').textContent
  })`));
  rec('миссия: цель 25 сохраняется и центр кольца становится «0/25»',
    dm2.stored === '25' && dm2.num === '0/25', JSON.stringify(dm2));
  w.eval(`(function () {
    var i = document.getElementById('dm-goal-input');
    i.value = '15';
    i.dispatchEvent(new window.Event('change'));
  })()`);

  // юнит-проверки селектора критического минимума
  const dmOrder = JSON.parse(w.eval(`(function () {
    var V = window.VocabaCritical;
    var clean = { id: 'c', review_count: 10, fail_count: 0 };
    var fragile = { id: 'f', review_count: 10, fail_count: 5 };
    var s1 = V.score({ overdue: 9, intervalDays: 14, level: 5 }, clean);
    var s2 = V.score({ overdue: 0, intervalDays: 1, level: 1 }, fragile);
    var s3 = V.score({ overdue: 0, intervalDays: 1, level: 1 }, clean);
    var sel = V.select([
      { cardId: 'a', direction: 'en_ru', overdue: 0, intervalDays: 1, level: 1 },
      { cardId: 'b', direction: 'en_ru', overdue: 9, intervalDays: 14, level: 5 }
    ], [{ id: 'a', review_count: 2, fail_count: 0 }, { id: 'b', review_count: 8, fail_count: 1 }], '2026-09-19');
    var capped = [];
    for (var i = 0; i < 50; i++) capped.push({ cardId: 'x' + i, direction: 'en_ru', overdue: i, intervalDays: 7, level: 3 });
    var selCapped = V.select(capped, [], '2026-09-19');
    return JSON.stringify({
      overdueFirst: s1 > s2,
      fragileBeatsClean: s2 > s3,
      worstFirst: sel.length === 2 && sel[0].cardId === 'b',
      capWorks: selCapped.length === V.CAP && selCapped[0].overdue === 49
    });
  })()`));
  rec('селектор: перезревшая дорогая L5 важнее сегодняшней L1', dmOrder.overdueFirst === true);
  rec('селектор: хрупкое слово важнее чистого при том же сроке', dmOrder.fragileBeatsClean === true);
  rec('селектор: худшие первыми в очереди', dmOrder.worstFirst === true);
  rec('селектор: потолок 40 режет хвост, оставляя худших', dmOrder.capWorks === true);

  // боевая проверка: клик левой плитки запускает сессию 'critical'
  const dmLive = JSON.parse(w.eval(`(function () {
    var out = {};
    try {
      document.getElementById('dm-review').click();
      var tr = document.getElementById('screen-training');
      out.trainingActive = !!(tr && tr.classList.contains('active'));
      var ctr = document.getElementById('train-counter');
      out.counter = ctr ? ctr.textContent : '';
      try {
        if (typeof srsSession !== 'undefined' && srsSession) {
          out.mode = srsSession.mode;
          out.len = srsSession.items.length;
        } else { out.letInvisible = true; }
      } catch (e) { out.letInvisible = true; }
    } catch (e) { out.crash = String(e); }
    return JSON.stringify(out);
  })()`));
  rec('миссия: клик по must-review открывает тренировку', dmLive.trainingActive === true && !dmLive.crash, JSON.stringify(dmLive));
  rec("миссия: сессия 'critical' — счётчик очереди = критический минимум",
    dmLive.counter === '1 / ' + dmData.expectedCritical
      || (dmLive.mode === 'critical' && dmLive.len === dmData.expectedCritical),
    JSON.stringify(dmLive));

  // ── 12. New Words per Day: новые слова по дням (последние 14 дней) ──────
  rec('newwords: canvas и empty-state в разметке',
    !!$('#chart-newwords') && !!$('#chart-newwords-empty'));

  // Синтетика: unit-параметр тултипов + множественное число + выживание redraw.
  const nwSynth = JSON.parse(w.eval(`(function () {
    var c = document.getElementById('chart-newwords');
    var green = 'rgba(16, 185, 129, 0.9)';
    drawFallbackBarChart(c, ['Sep 18', 'Sep 19'], [3, 1], -1, [green, green], 'new word');
    var tip0 = c._chart.tipFor(0), tip1 = c._chart.tipFor(1);
    c._chart.redraw(0);
    var tipAfter = c._chart.tipFor(1);
    // обратная совместимость: без unit — по-прежнему 'reviews'
    drawFallbackBarChart(c, ['A'], [2], -1, null);
    var tipDefault = c._chart.tipFor(0);
    return JSON.stringify({ tip0: tip0, tip1: tip1, tipAfter: tipAfter, tipDefault: tipDefault });
  })()`));
  rec('newwords: тултип говорит «3 new words» (unit + плюрализация)',
    /3 new words/.test(nwSynth.tip0) && /1 new word(?!s)/.test(nwSynth.tip1),
    `${nwSynth.tip0} | ${nwSynth.tip1}`);
  rec('newwords: unit переживает hover-redraw', nwSynth.tipAfter === nwSynth.tip1, nwSynth.tipAfter);
  rec('newwords: без unit тултип прежний («reviews») — обратная совместимость',
    /2 reviews/.test(nwSynth.tipDefault), nwSynth.tipDefault);

  // Боевой поток: клик Learn → Space (flip) → 3 (easy) → активация банковского
  // слова → app.js пишет history[today].newWords → stats перерисован → график.
  const nwLive = JSON.parse(w.eval(`(function () {
    var out = {};
    try {
      document.getElementById('dm-learn').click();
      out.training = document.getElementById('screen-training').classList.contains('active');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
      switchScreen('stats');
      window.dispatchEvent(new CustomEvent('themechange'));
      var c = document.getElementById('chart-newwords');
      var empty = document.getElementById('chart-newwords-empty');
      out.emptyHidden = empty ? empty.hidden : null;
      out.hasChart = !!(c && c._chart && c._chart.kind === 'bar');
      if (out.hasChart) { out.tipToday = c._chart.tipFor(13); out.tipOld = c._chart.tipFor(0); }
    } catch (e) { out.crash = String(e); }
    return JSON.stringify(out);
  })()`));
  rec('newwords: learn-сессия стартовала по клику плитки', nwLive.training === true && !nwLive.crash, JSON.stringify(nwLive));
  rec('newwords: после активации слова график построен, empty-state скрыт',
    nwLive.hasChart === true && nwLive.emptyHidden === true, JSON.stringify(nwLive).slice(0, 120));
  rec('newwords: сегодняшний столбец = «1 new word» (полный конвейер)',
    /1 new word(?!s)/.test(nwLive.tipToday || ''), String(nwLive.tipToday));
  rec('newwords: пустые дни — «0 new words»',
    /0 new words/.test(nwLive.tipOld || ''), String(nwLive.tipOld));

  // ── 13. Правило «выучено» (20.09): Easy/Hard на новом слове — да, Again — нет ──
  // Полностью боевой поток на реальных клавишах и функциях. afterAgain/afterUndo/
  // afterEasy/afterHard читаются с кольца миссии (единственный видимый из eval
  // источник: appState-let из отдельного eval недоступен).
  rec('undo-кнопка «previous» в разметке тренировки', !!$('#btn-undo-card'));
  const nwRule = JSON.parse(w.eval(`(function () {
    var out = {};
    function learnNum() {
      switchScreen('dashboard');
      window.dispatchEvent(new CustomEvent('themechange'));
      return document.getElementById('dm-learn-num').textContent;
    }
    function key(k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }
    try {
      out.before = learnNum();                                  // §12 оставил 1 выученное
      document.getElementById('dm-learn').click();              // новая learn-сессия (банковское W1)
      key(' '); key('1');                                       // flip + AGAIN → активация БЕЗ зачёта
      out.afterAgain = learnNum();
      switchScreen('training');
      undoPreviousCard();                                       // отмотка «нажал не ту кнопку»
      out.afterUndo = learnNum();
      submitAnswer('easy');                                     // вытянули то же слово → зачёт
      out.afterEasy = learnNum();
      document.getElementById('dm-learn').click();              // новая learn-сессия (W2)
      key(' '); key('2');                                       // flip + HARD → зачёт
      out.afterHard = learnNum();
    } catch (e) { out.crash = String(e); }
    return JSON.stringify(out);
  })()`));
  rec('правило: старт — 1 выученное из §12', nwRule.before === '1/15' && !nwRule.crash, JSON.stringify(nwRule));
  rec('правило: AGAIN на новом слове НЕ засчитывается', nwRule.afterAgain === '1/15', nwRule.afterAgain);
  rec('правило: undo откатывает ответ целиком (счётчик не дрогнул)', nwRule.afterUndo === '1/15', nwRule.afterUndo);
  rec('правило: EASY после отмотки засчитывает слово', nwRule.afterEasy === '2/15', nwRule.afterEasy);
  rec('правило: HARD на новом слове засчитывается', nwRule.afterHard === '3/15', nwRule.afterHard);
  // график New Words per Day отражает то же число
  const nwChart = JSON.parse(w.eval(`(function () {
    switchScreen('stats');
    window.dispatchEvent(new CustomEvent('themechange'));
    var c = document.getElementById('chart-newwords');
    return JSON.stringify({ tip: c && c._chart ? c._chart.tipFor(13) : null });
  })()`));
  rec('график: сегодняшний столбец = 3 new words (синхронно с кольцом)',
    /3 new words/.test(nwChart.tip || ''), String(nwChart.tip));

  // ── 14. Card Stats: личная статистика карточки из Dictionary (📊) ────────
  w.eval(`switchScreen('dictionary'); renderDictionary();`);
  const csOpen = JSON.parse(w.eval(`(function () {
    var out = {};
    var btns = document.querySelectorAll('.btn-dict-stats');
    out.btnCount = btns.length;
    out.totalCards = ((window.LEITNER_DATA && LEITNER_DATA.cards) || []).length;
    if (!btns.length) return JSON.stringify(out);
    var cards = (window.LEITNER_DATA && LEITNER_DATA.cards) || [];
    var btn = null, card = null;
    for (var i = 0; i < btns.length && !btn; i++) {
      for (var j = 0; j < cards.length; j++) {
        if (cards[j].id === btns[i].dataset.cardId && String(cards[j].status || '').toUpperCase() === 'ACTIVE') {
          btn = btns[i]; card = cards[j]; break;
        }
      }
    }
    if (!btn) return JSON.stringify(out);
    btn.click();
    var m = document.getElementById('modal-card-stats');
    out.visible = !!(m && !m.classList.contains('hidden'));
    out.wordShown = !!(m && m.querySelector('.cs-word') && m.querySelector('.cs-word').textContent === card.word);
    out.dirBlocks = m ? m.querySelectorAll('.cs-dirblock').length : 0;
    out.segs = m ? m.querySelectorAll('.cs-seg').length : 0;
    out.segsOn = m ? m.querySelectorAll('.cs-seg.on').length : 0;
    out.expectOn = (Number(card.level_en_ru) || 0) + (Number(card.level_ru_en) || 0);
    var rc = Number(card.review_count) || 0, fc = Number(card.fail_count) || 0;
    out.answers = m && m.querySelector('.cs-answers-val') ? m.querySelector('.cs-answers-val').textContent : null;
    out.expectRc = rc;
    out.success = m && m.querySelector('.cs-success-val') ? m.querySelector('.cs-success-val').textContent : null;
    out.expectPct = rc > 0 ? Math.min(100, Math.max(0, Math.round((rc - fc) / rc * 100))) + '%' : '—';
    out.overdueOrDue = m ? m.querySelectorAll('.cs-v.overdue, .cs-v.due-now').length : 0;
    return JSON.stringify(out);
  })()`));
  rec('cardstats: 📊-кнопка у каждой карточки словаря',
    csOpen.btnCount > 0 && csOpen.btnCount === csOpen.totalCards, `${csOpen.btnCount}/${csOpen.totalCards}`);
  rec('cardstats: клик открывает модалку с тем самым словом',
    csOpen.visible === true && csOpen.wordShown === true);
  rec('cardstats: два блока направлений, 12 сегментов, заполнено = сумма уровней',
    csOpen.dirBlocks === 2 && csOpen.segs === 12 && csOpen.segsOn === csOpen.expectOn,
    `blocks=${csOpen.dirBlocks} segs=${csOpen.segs} on=${csOpen.segsOn} expected=${csOpen.expectOn}`);
  rec('cardstats: lifetime-цифры = данные карточки',
    csOpen.answers === String(csOpen.expectRc) && csOpen.success === csOpen.expectPct,
    `answers=${csOpen.answers} (ждём ${csOpen.expectRc}), success=${csOpen.success} (ждём ${csOpen.expectPct})`);
  const csBank = JSON.parse(w.eval(`(function () {
    var cards = (window.LEITNER_DATA && LEITNER_DATA.cards) || [];
    var bankId = null;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] && String(cards[i].status || '').toUpperCase() !== 'ACTIVE') { bankId = cards[i].id; break; }
    }
    if (!bankId) return JSON.stringify({ skip: true });
    window.VocabaCardStats.open(bankId);
    var m = document.getElementById('modal-card-stats');
    return JSON.stringify({
      visible: !m.classList.contains('hidden'),
      bankNote: !!m.querySelector('.cs-bank-note'),
      noDirBlocks: m.querySelectorAll('.cs-dirblock').length === 0
    });
  })()`));
  rec('cardstats: банковская карточка — нотис вместо блоков направлений',
    csBank.skip === true || (csBank.visible && csBank.bankNote && csBank.noDirBlocks), JSON.stringify(csBank));
  w.eval(`document.getElementById('cs-close').click();`);
  rec('cardstats: ✖ закрывает модалку',
    w.eval(`document.getElementById('modal-card-stats').classList.contains('hidden')`) === true);
  w.eval(`window.VocabaCardStats.open(document.querySelector('.btn-dict-stats').dataset.cardId);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  rec('cardstats: Escape закрывает модалку (capture, без ухода с экрана)',
    w.eval(`document.getElementById('modal-card-stats').classList.contains('hidden')`) === true
      && w.eval(`document.getElementById('screen-dictionary').classList.contains('active')`) === true);

  // ── 15. Learn-батч: банк в словах, сессия в карточках (объясняющий тост) ──
  w.eval(`startTrainingSession('learn');`);
  const learnToast = String(w.eval(`document.getElementById('toast-container').textContent`));
  const bt = learnToast.match(/Learn batch: (\d+) of (\d+) Bank words · (\d+) cards/);
  rec('learn: тост объявляет батч (N of M Bank words · K cards)', !!bt, learnToast.slice(0, 140));
  rec('learn: карточек = числу слов (одно направление EN→RU, без дублей), банк больше батча',
    !!bt && Number(bt[3]) === Number(bt[1]) && Number(bt[2]) > Number(bt[1]),
    bt ? bt.slice(1).join(' / ') : 'no match');
  w.eval(`switchScreen('dashboard');`);

  // ── 16. missionStatus: лёгкий пересчёт дневной Mission (кормит in-app баннер) ─
  const ms = JSON.parse(w.eval(`JSON.stringify(window.VocabaReminder.missionStatus(srsToday()))`));
  rec('reminders: missionStatus честен — долг>0, reviewDone=false, цель>=1',
    ms.debt > 0 && ms.reviewDone === false && ms.learnDone === (ms.learned >= ms.goal) && ms.goal >= 1,
    JSON.stringify(ms));

  // ── 17. Reminder banner: видимое in-app напоминание на дашборде ────────
  w.eval(`localStorage.removeItem('vocaba_reminder_dismissed');`);
  w.eval(`window.VocabaReminder.renderBanner();`);
  const bannerShown = w.eval(`(function(){ var el = document.getElementById('dm-reminder'); return !!(el && el.style.display !== 'none'); })()`);
  const bannerText = String(w.eval(`(function(){ var el = document.getElementById('dm-reminder'); return el ? el.textContent : ''; })()`));
  rec('reminders: видимый баннер появляется, когда Mission не закрыта (долг>0)',
    bannerShown === true && /\d+ review/.test(bannerText), bannerText.slice(0, 120));
  w.eval(`(function(){ var b = document.querySelector('#dm-reminder button[title="Hide until tomorrow"]'); if (b) b.click(); })()`);
  const afterDismiss = w.eval(`(function(){ var el = document.getElementById('dm-reminder'); return !el || el.style.display === 'none'; })()`);
  const dismissedVal = String(w.eval(`localStorage.getItem('vocaba_reminder_dismissed')`));
  const todayStr = String(w.eval(`srsToday()`));
  rec('reminders: ✖ прячет баннер до завтра (localStorage = today)',
    afterDismiss === true && dismissedVal === todayStr, `${afterDismiss} | "${dismissedVal}" vs "${todayStr}"`);

  // ── 18. Trash (мусорка): перенос слова из базы, выход из SRS, восстановление ──
  w.eval(`localStorage.removeItem('vocaba_trash'); switchScreen('dictionary'); renderDictionary();`);
  rec('trash: мусорка ВСЕГДА рисует псевдо-карточку в конце словаря (даже пустая, trashCount=0)',
    w.eval('window.VocabaTrash.trashCount()') === 0 && w.eval('!!document.querySelector(".trash-card")') === true);
  rec('trash: на каждой карточке есть прямой кнопка 🗑️ Trash (.btn-dict-trash)',
    w.eval('document.querySelectorAll(".btn-dict-trash").length') > 0);
  const trashId = w.eval(`(function(){ var b=document.querySelector('.btn-dict-stats'); return b ? b.dataset.cardId : null; })()`);
  const realBefore = Number(w.eval(`document.querySelectorAll('.dict-card:not(.trash-card)').length`));
  const trashed = w.eval(`window.VocabaTrash.trashCard(${JSON.stringify(trashId)})`);
  w.eval(`renderDictionary();`);
  const realAfter = Number(w.eval(`document.querySelectorAll('.dict-card:not(.trash-card)').length`));
  const trashEntry = Number(w.eval(`JSON.parse(localStorage.getItem('vocaba_trash')||'[]').length`));
  rec('trash: trashCard убирает слово из словаря и пишет снимок в localStorage (выход из SRS)',
    trashId !== null && trashed === true && realAfter === realBefore - 1 && trashEntry === 1 && w.eval('window.VocabaTrash.trashCount()') === 1);
  rec('trash: псевдо-карточка 🗑️ Trash кликабельна (role=button)',
    w.eval(`document.querySelector('.trash-card').getAttribute('role')`) === 'button');
  rec('trash: перенесённое слово исчезло из сетки (нет .btn-dict-stats с этим id)',
    w.eval(`!document.querySelector('.btn-dict-stats[data-card-id="${trashId}"]')`) === true);
  w.eval(`document.getElementById('dict-search-input').value='trash'; renderDictionary();`);
  rec('trash: поиск "trash" находит псевдо-карточку (findable by English search)',
    w.eval(`!!document.querySelector('.trash-card')`) === true);
  w.eval(`document.getElementById('dict-search-input').value=''; renderDictionary();`);
  const restored = w.eval(`window.VocabaTrash.restoreCard(${JSON.stringify(trashId)})`);
  w.eval(`renderDictionary();`);
  const realRestored = Number(w.eval(`document.querySelectorAll('.dict-card:not(.trash-card)').length`));
  rec('trash: restoreCard возвращает слово в словарь и чистит localStorage',
    restored === true && realRestored === realBefore && w.eval('window.VocabaTrash.trashCount()') === 0);

  rec('ноль ошибок загрузки/выполнения', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.evidence ? ' [' + c.evidence + ']' : ''}`);
  console.log(`\n${failed.length ? 'FAIL ' + (checks.length - failed.length) + '/' + checks.length : 'PASS ' + checks.length + '/' + checks.length} — check-datacare.cjs — экран Data & Backup`);
  w.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
