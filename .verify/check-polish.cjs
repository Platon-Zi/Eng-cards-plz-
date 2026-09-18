/* ==========================================================================
   .verify/check-polish.cjs — поведение polish.js (сброс прокрутки при смене
   экрана). Загружает ВСЕ пять скриптов index.html в производственном порядке
   и гоняет реальный app.js switchScreen(), а не ручное переключение классов.

   Зачем отдельный файл: check.cjs проверяет лишь ПОРЯДОК загрузки, а
   interact.cjs сфокусирован на SRS-поведении; сброс прокрутки общего
   контейнера .content-area не проверял никто.

   Запуск:  node .verify/check-polish.cjs      (или npm run check:polish)
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

// Заглушки того, чего в jsdom нет (канвас, речь).
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, p) => (p === 'canvas' ? null : () => {}) });
w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [] };
w.SpeechSynthesisUtterance = function () {};

// Ровно тот порядок, что в разметке: данные → ядро → приложение → темы → polish.
['data/leitner_data.js', 'srs.js', 'app.js', 'theme.js', 'polish.js'].forEach(f => {
  w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
});

const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const rec = (name, ok, evidence) => checks.push({ name, ok: !!ok, evidence });

(async () => {
  await wait(1500);
  const area = d.querySelector('main.content-area');

  rec('контейнер прокрутки main.content-area найден', !!area, area ? 'да' : 'НЕТ');
  rec('экранов .screen в разметке: 9', d.querySelectorAll('.screen').length === 9,
      String(d.querySelectorAll('.screen').length));
  rec('polish.js загрузился без ошибок', errors.length === 0, errors.slice(0, 2).join(' | ') || 'нет ошибок');

  if (area) {
    // 1) Смена экрана сбрасывает прокрутку общего контейнера.
    area.scrollTop = 400;
    rec('scrollTop=400 выставлен до смены экрана', area.scrollTop === 400, String(area.scrollTop));
    w.switchScreen('guide');
    await wait(150);
    rec('switchScreen("guide") сделал экран активным',
        d.getElementById('screen-guide').classList.contains('active'));
    rec('прокрутка сброшена при смене экрана', area.scrollTop === 0, 'scrollTop=' + area.scrollTop);

    // 2) И при следующем переключении тоже.
    area.scrollTop = 250;
    w.switchScreen('dictionary');
    await wait(150);
    rec('второе переключение тоже сбрасывает', area.scrollTop === 0, 'scrollTop=' + area.scrollTop);

    // 3) Переключение на ТОТ ЖЕ экран не должно терять место чтения.
    area.scrollTop = 120;
    w.switchScreen('dictionary');
    await wait(150);
    rec('повтор того же экрана прокрутку НЕ трогает', area.scrollTop === 120, 'scrollTop=' + area.scrollTop);

    // 4) Смена темы не должна дёргать прокрутку (классы .screen не меняются).
    area.scrollTop = 300;
    d.documentElement.setAttribute('data-theme', 'midnight');
    d.dispatchEvent(new w.CustomEvent('themechange', { bubbles: true, detail: { theme: 'midnight' } }));
    await wait(150);
    rec('смена темы прокрутку НЕ трогает', area.scrollTop === 300, 'scrollTop=' + area.scrollTop);

    // 5) Тренировочный экран: сброс не мешает его no-scroll guarantee.
    area.scrollTop = 500;
    w.switchScreen('training');
    await wait(150);
    rec('training сбрасывает прокрутку контейнера', area.scrollTop === 0, 'scrollTop=' + area.scrollTop);
  }

  console.log('--- .verify/check-polish.cjs: поведение сброса прокрутки ---');
  checks.forEach(c => console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + (c.evidence ? ' [' + c.evidence + ']' : '')));
  const bad = checks.filter(c => !c.ok);
  console.log('\nОШИБКИ ЗАПУСКА (' + errors.length + '):', errors.slice(0, 5).join(' | ') || 'нет ✓');
  const ok = errors.length === 0 && bad.length === 0;
  console.log(ok
    ? `\nPASS ${checks.length}/${checks.length} — check-polish.cjs`
    : `\nFAIL ${checks.length - bad.length}/${checks.length} — check-polish.cjs`);
  try { dom.window.close(); } catch (e) { /* noop */ }
  process.exit(ok ? 0 : 1);
})();
