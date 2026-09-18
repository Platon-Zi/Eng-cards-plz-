// UI-agent contract verifier: index.html + theme.js + CSS token integrity.
// Usage: node .scratch/ui/verify_ui.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/home/zinko/ENG CARDS/.verify/node_modules/jsdom');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const themesCss = fs.readFileSync(path.join(ROOT, 'themes.css'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

const dom = new JSDOM(html);
const doc = dom.window.document;

/* ---------- 1. duplicate ids ---------- */
const seen = new Map();
for (const el of doc.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
const dupes = [...seen].filter(([, n]) => n > 1);
ok(dupes.length === 0, `duplicate ids = ${dupes.length}${dupes.length ? ' → ' + JSON.stringify(dupes) : ''}`);

/* ---------- 2. contract ids from the brief ---------- */
const contractIds = [
  'knowledge-panel', 'knowledge-rows',
  ...['bank', 'new', 'learning', 'familiar', 'confident', 'mastered'].flatMap(g => [`kg-count-${g}`, `kg-bar-${g}`]),
  'dash-due-now', 'dash-due-en-ru', 'dash-due-ru-en', 'dash-total', 'dash-learned', 'dash-due',
  'hero-due-text', 'hero-learn-text',
  'card-dir-indicator-front', 'card-dir-indicator-back', 'card-level-pill-front', 'card-level-pill-back',
  'card-due-note-front', 'card-due-note-back',
  'btn-answer-again', 'btn-answer-hard', 'btn-answer-easy',
  'dict-filter-group', 'btn-practice-group',
  'stats-dir-en-ru', 'stats-dir-ru-en',
  'edit-status', 'edit-level-en-ru', 'edit-level-ru-en', 'edit-due-info',
  'train-counter', 'train-mode-title', 'screen-training', 'chart-stages', 'stat-mistakes-body',
];
const missingIds = contractIds.filter(id => !doc.getElementById(id));
ok(missingIds.length === 0, `contract ids present (${contractIds.length - missingIds.length}/${contractIds.length})${missingIds.length ? ' MISSING: ' + missingIds.join(', ') : ''}`);

/* ---------- 3. contract classes ---------- */
const contractClasses = [
  'kg-container', 'kg-row', 'kg-meta', 'kg-icon', 'kg-name', 'kg-caption', 'kg-bar-wrapper', 'kg-bar',
  'kg-count', 'kg-due-summary', 'due-summary-title', 'due-summary-total', 'due-summary-split', 'due-split-item',
  'answer-controls', 'btn-answer', 'btn-answer-again', 'btn-answer-hard', 'btn-answer-easy',
  'card-corner-meta', 'card-dir-indicator', 'card-level-pill', 'card-due-note',
  ...['bank', 'new', 'learning', 'familiar', 'confident', 'mastered'].map(g => `grp-${g}`),
  'stats-dir-card', 'dir-breakdown-grid', 'dir-breakdown-card', 'dir-breakdown-title', 'dir-breakdown-value', 'dir-breakdown-note',
  'edit-levels-row', 'shortcut-tip-box',
];
const missingClasses = contractClasses.filter(c => !doc.querySelector('.' + c));
ok(missingClasses.length === 0, `contract classes present (${contractClasses.length - missingClasses.length}/${contractClasses.length})${missingClasses.length ? ' MISSING: ' + missingClasses.join(', ') : ''}`);

/* ---------- 4. screens / anchors / scripts ---------- */
ok(doc.querySelectorAll('.screen').length === 9, `exactly 9 .screen elements (got ${doc.querySelectorAll('.screen').length})`);
const anchors = [...doc.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href').slice(1));
const badAnchors = anchors.filter(h => h && !doc.getElementById(h));
ok(badAnchors.length === 0, `all ${anchors.length} href="#…" anchors resolve${badAnchors.length ? ' BAD: ' + badAnchors.join(', ') : ''}`);
const scripts = [...doc.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
// polish.js + datacare.js грузятся после app.js — наблюдатели за классами .screen.
ok(JSON.stringify(scripts) === JSON.stringify(['data/leitner_data.js', 'srs.js', 'app.js', 'theme.js', 'polish.js', 'datacare.js']),
  `script order = ${scripts.join(' → ')}`);

/* ---------- 5. hard constraints from parent ---------- */
const dueInfo = doc.getElementById('edit-due-info');
ok(dueInfo && dueInfo.tagName === 'INPUT' && dueInfo.hasAttribute('readonly'), '#edit-due-info is a readonly <input>');
const dictAll = doc.querySelector('#dict-filter-group option[value=""]');
ok(!!dictAll, `#dict-filter-group "all" option keeps value="" (label: ${dictAll ? JSON.stringify(dictAll.textContent.trim()) : 'MISSING'})`);

/* ---------- 6. theme markup ---------- */
ok(doc.documentElement.getAttribute('data-theme') === 'beta', 'html[data-theme="beta"] default in markup');
const tpBtn = doc.getElementById('theme-picker-btn');
ok(!!tpBtn && tpBtn.getAttribute('aria-haspopup') === 'true' && tpBtn.getAttribute('aria-expanded') === 'false'
  && tpBtn.getAttribute('aria-controls') === 'theme-picker-menu', 'theme button: aria-haspopup/expanded/controls');
const tpMenu = doc.getElementById('theme-picker-menu');
ok(!!tpMenu && tpMenu.getAttribute('role') === 'menu' && tpMenu.hasAttribute('hidden'), 'theme menu: role=menu, hidden by default');
ok(!!doc.getElementById('theme-picker-dot'), 'theme dot swatch exists');
/* titlebar placement: picker inside .window-titlebar, after .app-brand */
const titlebar = doc.querySelector('.window-titlebar');
ok(!!titlebar && titlebar.contains(tpBtn) && titlebar.querySelector('.app-brand').compareDocumentPosition(tpBtn) & 4,
  'theme button sits top-left inside .window-titlebar after the brand');
/* BRANDING v2: name is Vocaba; the three meta labels + author live in the
   titlebar (promoted out of the old sidebar header, which is now gone). */
ok(titlebar && /Vocaba/.test((titlebar.querySelector('.app-name') || {}).textContent || ''),
  'brand renamed to Vocaba');
ok(titlebar && titlebar.querySelector('.titlebar-meta .offline-badge')
  && !titlebar.querySelector('#streak-badge') && !titlebar.querySelector('.tb-vocab'),
  'quiet titlebar: offline mark in theme colour, streak & Vocabulary removed');
ok(!doc.getElementById('dash-streak') && !!doc.getElementById('stats-streak'),
  'streak pill gone from titlebar, Day streak KPI lives on Statistics');
{
  const dash = doc.getElementById('screen-dashboard');
  const kg = dash.querySelector('#knowledge-panel'), mg = dash.querySelector('.metrics-grid');
  ok(!!kg && !!mg && (kg.compareDocumentPosition(mg) & 4) > 0,
    'dashboard order: hero → Knowledge Groups → metrics');
  ok(!dash.querySelector('.info-tag'), 'INTERVALS tech-tag removed from dashboard');
}
ok(titlebar && !!titlebar.querySelector('.app-author .aa-mail')
  && titlebar.querySelector('.app-author .aa-mail').textContent.trim() === 'zinkovplaton@gmail.com',
  'subtle author handle in titlebar');
ok(titlebar && titlebar.querySelector('.contact-pop .cp-name')
  && /\+972 584010710/.test(titlebar.querySelector('.contact-pop').textContent)
  && /Platon Zinkov/.test(titlebar.querySelector('.contact-pop').textContent)
  && /zinkovplaton@gmail\.com/.test(titlebar.querySelector('.contact-pop').textContent),
  'contact popup carries name + phone + email');
ok(!!doc.querySelector('link[rel="icon"][href="icon.png"]'), 'favicon link present (browser tab chip)');

/* STATS v2: every section explains itself; outcomes donut + direction bars exist */
{
  const st = doc.getElementById('screen-stats');
  ok(!!st && st.querySelectorAll('.stat-explain').length >= 6,
    'every stats section carries a plain-language caption (' + (st ? st.querySelectorAll('.stat-explain').length : 0) + ' found)');
  ok(!!doc.getElementById('chart-outcomes') && !!doc.getElementById('chart-outcomes-empty'),
    'answer-outcomes donut canvas + empty state exist');
  ok(['ds-en-ru', 'ds-ru-en', 'ds-en-ru-pct', 'ds-ru-en-pct', 'ds-en-ru-tag', 'ds-ru-en-tag']
      .every(id => !!doc.getElementById(id)), 'direction-strength bars exist');
}

/* STATS v3: ribbon, highlights, chart tooltip */
{
  ok(!!doc.getElementById('mastery-ribbon') && !!doc.getElementById('ribbon-legend'),
    'Journey-to-Mastery ribbon + legend containers exist');
  ok(['hl-total-answers', 'hl-best-day', 'hl-best-streak', 'hl-perfect-days']
      .every(id => !!doc.getElementById(id)), 'Personal Highlights value slots exist');
  ok(!!doc.getElementById('chart-tooltip'), 'shared chart tooltip is static markup (app.js id contract)');
}
ok(!doc.querySelector('.sidebar .nav-header'), 'old sidebar nav-header removed (menu rides higher)');
/* inline anti-FOUC script is in <head> and mentions the storage key */
const headScripts = [...doc.querySelectorAll('head script:not([src])')].map(s => s.textContent).join('\n');
ok(headScripts.includes('eng_cards_theme') && headScripts.includes('data-theme'), 'anti-FOUC inline script in <head> uses eng_cards_theme');
/* themes.css after style.css */
const links = [...doc.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href'));
ok(links.indexOf('themes.css') === links.indexOf('style.css') + 1 && links.includes('themes.css'),
  `stylesheet order: ${links.filter(l => l.includes('css')).join(' → ')}`);

/* ---------- 7. guide views: EN default visible, RU intact ---------- */
const gEn = doc.getElementById('guide-lang-en'), gRu = doc.getElementById('guide-lang-ru');
ok(gEn && !gEn.classList.contains('hidden') && !gEn.hasAttribute('hidden'), 'EN guide view visible by default');
ok(gRu && (gRu.classList.contains('hidden') || gRu.hasAttribute('hidden')), 'RU guide view hidden by default');
ok(gRu && gRu.querySelectorAll('.section-card').length >= 5 && gRu.textContent.includes('Горячие клавиши'), 'RU guide fully intact');
ok(doc.querySelector('[data-guide-lang="en"]').classList.contains('active'), 'EN guide toggle is the active one');

/* ---------- 8. answer buttons: exactly three, English, hotkey kbd ---------- */
const answers = [...doc.querySelectorAll('.answer-controls .btn-answer')];
ok(answers.length === 3, `exactly 3 answer buttons (got ${answers.length})`);
const labels = answers.map(b => b.textContent.replace(/\s+/g, ' ').trim());
ok(labels[0].includes('Forgot') && labels[1].includes('Hard') && labels[2].includes('Easy'),
  `answer labels English: ${JSON.stringify(labels)}`);
ok(answers.every(b => b.querySelector('kbd')), 'every answer button keeps its <kbd> hotkey hint');

/* ---------- 9. Russian outside sanctioned zones ---------- */
const CYR = /[\u0400-\u04FF]/;
const offenders = [];
// Sanctioned Russian (kept intentionally, per brief):
//  • #guide-lang-ru / #guide-prompt-code-ru — the RU guide view (must stay)
//  • span[lang="ru"] — cross-references to RU button names inside EN copy
//  • kbd — physical Cyrillic-layout hotkey aliases (Ы/Ф/В/Ц), functional docs
//  • .card-face demo content + #textarea-antigravity sample JSON — word DATA
//    (RU translations are the product's payload, not UI chrome)
//  • #guide-prompt-code-en — RU part-of-speech markers (сущ./гл./прил.) that
//    app.js's importer parser matches on; functional, not decorative
const SANCTIONED_SEL = '#guide-lang-ru, #guide-prompt-code-ru, .card-face, #textarea-antigravity, kbd, [lang="ru"]';
(function walk(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === 8) continue;                     // comments: allowed
    if (node.nodeType === 3) {
      if (CYR.test(node.textContent) && !el.closest(SANCTIONED_SEL)) {
        if (el.id === 'guide-prompt-code-en' && /^[\s\S]*(сущ|гл|прил)\./.test(node.textContent) && !/«|»/.test(node.textContent.replace(/\(сущ\.\/гл\.\/прил\.\)/g,''))) {
          // only the PoS-marker line is sanctioned inside the EN prompt
        } else if (el.id === 'guide-prompt-code-en' && /(сущ|гл|прил)\./.test(node.textContent) && node.textContent.split('\n').filter(l => CYR.test(l)).every(l => /(сущ|гл|прил)\.|на русский|Russian translation/.test(l))) {
          // every Cyrillic line of the EN prompt is a functional PoS/translation instruction
        } else {
          offenders.push(`text in <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>: ${node.textContent.trim().slice(0, 60)}`);
        }
      }
    } else if (node.nodeType === 1) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue;
      for (const at of node.attributes || []) {
        // sanctioned: RU example placeholders on the Russian-input fields
        // (#input-translation / #input-example-trans expect Russian content)
        if (at.name === 'placeholder' && ['input-translation', 'input-example-trans'].includes(node.id)) continue;
        if (CYR.test(at.value) && !node.closest(SANCTIONED_SEL) && !(node.id && SANCTIONED_SEL.includes('#' + node.id))) {
          offenders.push(`attr ${at.name} on <${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}>: ${at.value.slice(0, 60)}`);
        }
      }
      walk(node);
    }
  }
})(doc.body);
const filtered = offenders;
ok(filtered.length === 0, `no unsanctioned user-visible Russian in markup (${filtered.length} found)`);
filtered.slice(0, 12).forEach(o => console.log('   ↳', o));

console.log(`\n=== ${failures === 0 ? 'ALL HTML CHECKS PASS' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
