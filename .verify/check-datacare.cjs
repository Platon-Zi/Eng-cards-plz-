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

  rec('ноль ошибок загрузки/выполнения', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.evidence ? ' [' + c.evidence + ']' : ''}`);
  console.log(`\n${failed.length ? 'FAIL ' + (checks.length - failed.length) + '/' + checks.length : 'PASS ' + checks.length + '/' + checks.length} — check-datacare.cjs — экран Data & Backup`);
  w.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
