#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check.cjs — STATIC / STRUCTURAL verification of index.html ↔ app.js contracts.
// Run from the repo root:  node .verify/check.cjs
//
// Covers:
//   A. every getElementById / querySelector('#id') target used by app.js (and
//      theme.js) exists in index.html — static literals + expanded dynamic
//      template families (screen-*, kg-count-*, kg-bar-*, card-*-front/back,
//      groups-tab-*);
//   B. no duplicate ids in index.html;
//   C. no leftover box-era ids/classes (btn-srs-*, btn-swipe-*, dict-filter-box,
//      edit-box, btn-practice-box, box-count-*, box-bar-*, .box-row) in
//      index.html or referenced from app.js;
//   D. script load order: data/leitner_data.js → srs.js → app.js → theme.js → polish.js
//      (srs.js MUST precede app.js — app.js needs the global SRS at eval time;
//      polish.js must be LAST — it observes the .screen classes app.js toggles);
//   E. exactly the three answer buttons (again/hard/easy), no fourth;
//   F. the v2 DOM contract ids from the SRS reform (kg rows, dictionary,
//      direction switcher, card chrome, edit modal, stats, toasts);
//   G. navigation coverage (every .nav-btn and switchScreen literal has a
//      #screen-<id>);
//   H. runtime boot smoke: the real page boots in jsdom with the real data at a
//      fixed date, dashboard numbers equal SRS.summarize, the nav tour renders
//      every screen without throwing, themechange re-renders cleanly.
//
// Exits non-zero on any failure. Final line: `PASS n/m` or `FAIL n/m (…)`.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { JSDOM } = require(path.join(__dirname, 'node_modules', 'jsdom'));
const {
  createDomEnv, createRunner, readSource, deepClone, BUCKETS,
} = require('./helpers/dom-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const FIXED_DATE = '2026-09-17';
const runner = createRunner('check.cjs — static/structural verification');

const htmlSrc = readSource('index.html');
const appSrc = readSource('app.js');
const themeSrc = readSource('theme.js');

/* Parse index.html WITHOUT running scripts (structure only). */
const structDom = new JSDOM(htmlSrc);
const doc = structDom.window.document;

/* id inventory of index.html */
const present = new Map();
for (const el of doc.querySelectorAll('[id]')) present.set(el.id, (present.get(el.id) || 0) + 1);
const hasId = (id) => present.has(id);

/* ── id extraction from JS sources ─────────────────────────────────────────── */

/** Static string-literal ids: getElementById('x'), querySelector('#x …'). */
function extractStaticIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/getElementById\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
    if (!m[2].includes('${')) ids.add(m[2]);
  }
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*(['"`])([^'"`]+)\1/g)) {
    if (m[2].includes('${')) continue;
    for (const t of m[2].matchAll(/#([A-Za-z0-9_-]+)/g)) ids.add(t[1]);
  }
  return ids;
}

/** Template-literal selectors containing ${…} (dynamic families). */
function extractDynamicTemplates(src) {
  const out = [];
  for (const m of src.matchAll(/getElementById\(\s*`([^`]*\$\{[^`]*)`\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*`([^`]*\$\{[^`]*)`/g)) out.push(m[1]);
  return [...new Set(out)];
}

/* Screen ids app.js can switch to: nav data-screen attrs + switchScreen('x')
   literals + template expansions seen in the wild. */
const navScreens = [...doc.querySelectorAll('.nav-btn')].map((b) => b.dataset.screen).filter(Boolean);
const switchLiterals = [...appSrc.matchAll(/switchScreen\(\s*['"]([a-z0-9-]+)['"]\s*\)/g)].map((m) => m[1]);
const screenIds = [...new Set([...navScreens, ...switchLiterals, 'training'])];

/* groups-tab-<x>: values come from the HTML itself */
const groupsTabs = [...doc.querySelectorAll('[data-groups-tab]')].map((b) => b.dataset.groupsTab).filter(Boolean);

/* Expand the dynamic templates into concrete required ids / selectors. */
function expandTemplate(t) {
  if (t.startsWith('screen-${')) return { kind: 'ids', values: screenIds.map((s) => `screen-${s}`) };
  if (t.startsWith('kg-count-${')) return { kind: 'ids', values: BUCKETS.map((b) => `kg-count-${b}`) };
  if (t.startsWith('kg-bar-${')) return { kind: 'ids', values: BUCKETS.map((b) => `kg-bar-${b}`) };
  if (t.startsWith('card-dir-indicator-${')) return { kind: 'ids', values: ['front', 'back'].map((s) => `card-dir-indicator-${s}`) };
  if (t.startsWith('card-level-pill-${')) return { kind: 'ids', values: ['front', 'back'].map((s) => `card-level-pill-${s}`) };
  if (t.startsWith('card-due-note-${')) return { kind: 'ids', values: ['front', 'back'].map((s) => `card-due-note-${s}`) };
  if (t.startsWith('groups-tab-${')) return { kind: 'ids', values: groupsTabs.map((g) => `groups-tab-${g}`) };
  if (t.includes('data-dir=')) return { kind: 'selectors', values: ['eng-rus', 'auto', 'rus-eng'].map((d) => `.dir-btn[data-dir="${d}"]`) };
  return null; // unknown family
}

(async () => {
  /* ── A. STATIC ID COVERAGE ─────────────────────────────────────────────── */
  await runner.section('A. app.js ↔ index.html id coverage', ({ t }) => {
    const staticIds = extractStaticIds(appSrc);
    const missing = [...staticIds].filter((id) => !hasId(id)).sort();
    t(`all ${staticIds.size} static ids referenced by app.js exist in index.html`,
      missing.length === 0, missing.length ? `missing:\n  - ${missing.join('\n  - ')}` : '');

    const themeIds = extractStaticIds(themeSrc);
    const themeMissing = [...themeIds].filter((id) => !hasId(id)).sort();
    t(`all ${themeIds.size} static ids referenced by theme.js exist in index.html`,
      themeMissing.length === 0, themeMissing.join(', '));

    const templates = extractDynamicTemplates(appSrc);
    const unexpanded = [];
    const dynMissing = [];
    for (const tpl of templates) {
      const exp = expandTemplate(tpl);
      if (!exp) { unexpanded.push(tpl); continue; }
      if (exp.kind === 'ids') {
        for (const id of exp.values) if (!hasId(id)) dynMissing.push(`${id}  (from \`${tpl}\`)`);
      } else {
        for (const sel of exp.values) if (!doc.querySelector(sel)) dynMissing.push(`${sel}  (from \`${tpl}\`)`);
      }
    }
    t(`all ${templates.length - unexpanded.length}/${templates.length} dynamic id templates expand to existing elements`,
      dynMissing.length === 0, dynMissing.join('\n  - '));
    if (unexpanded.length) console.log(`   ℹ️ unexpanded dynamic templates (informational): ${unexpanded.map((x) => '`' + x + '`').join(', ')}`);
  });

  /* ── B. DUPLICATE IDS ──────────────────────────────────────────────────── */
  await runner.section('B. duplicate ids', ({ t }) => {
    const dupes = [...present.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`).sort();
    t(`index.html has no duplicate ids (${present.size} unique)`, dupes.length === 0, dupes.join(', '));
  });

  /* ── C. BOX-ERA LEFTOVERS ──────────────────────────────────────────────── */
  await runner.section('C. no box-era leftovers', ({ t }) => {
    const legacyIdRe = /^(btn-srs-.+|btn-swipe-.+|dict-filter-box|edit-box|btn-practice-box|box-count-.+|box-bar-.+)$/;
    const legacyIds = [...present.keys()].filter((id) => legacyIdRe.test(id)).sort();
    t('index.html has no box-era ids (btn-srs-*, btn-swipe-*, dict-filter-box, edit-box, btn-practice-box, box-count-*, box-bar-*)',
      legacyIds.length === 0, legacyIds.join(', '));

    const boxRows = doc.querySelectorAll('.box-row');
    t('index.html has no .box-row elements', boxRows.length === 0, `${boxRows.length} found`);

    const appRefs = appSrc.match(/(?:getElementById\(\s*|querySelector(?:All)?\(\s*['"`]#?)['"`]?(btn-srs-|btn-swipe-|dict-filter-box|edit-box(?!-)|btn-practice-box|box-count-|box-bar-)/g) || [];
    t('app.js does not query box-era ids', appRefs.length === 0, appRefs.join(', '));

    // NOTE: `btn-spelling-preset-box1` is an INTENTIONAL survivor (label is now
    // "🧠 Learning", handler loads the LEARNING group) — not a violation.
    t('allowed survivor btn-spelling-preset-box1 still present (intentional, per maintainer)',
      hasId('btn-spelling-preset-box1'));
  });

  /* ── D. SCRIPT LOAD ORDER ──────────────────────────────────────────────── */
  await runner.section('D. script load order', ({ t }) => {
    const srcs = [...htmlSrc.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    // polish.js — добровольное дополнение поверх app.js (сброс прокрутки общего
    // контейнера при смене экрана). datacare.js — экран Data & Backup (KPI +
    // копирование словесных списков), грузится после polish.js; оба — наблюдатели,
    // не трогающие app.js. datacare.js намеренно ПЕРЕД закрывающим </body> polish
    // не ломает: порядок data → srs → app → theme → polish → datacare.
    const expected = ['data/leitner_data.js', 'srs.js', 'app.js', 'theme.js', 'polish.js', 'datacare.js'];
    t(`index.html loads exactly ${expected.join(' → ')} in this order`,
      JSON.stringify(srcs) === JSON.stringify(expected), `actual: ${srcs.join(' → ') || '(none)'}`);
    t('srs.js precedes app.js (app.js needs global SRS at eval time)',
      srcs.indexOf('srs.js') !== -1 && srcs.indexOf('srs.js') < srcs.indexOf('app.js'));
    t('polish.js + datacare.js load last, after app.js/theme.js (observers)',
      srcs.indexOf('polish.js') > srcs.indexOf('app.js') && srcs.indexOf('datacare.js') > srcs.indexOf('polish.js'),
      `polish@${srcs.indexOf('polish.js')} datacare@${srcs.indexOf('datacare.js')} of ${srcs.length}`);
  });

  /* ── E. ANSWER BUTTONS ─────────────────────────────────────────────────── */
  await runner.section('E. three answer buttons, no fourth', ({ t }) => {
    for (const id of ['btn-answer-again', 'btn-answer-hard', 'btn-answer-easy']) {
      const el = doc.getElementById(id);
      t(`#${id} exists and is a <button>`, !!el && el.tagName === 'BUTTON', el ? el.tagName : 'missing');
    }
    const fourth = ['btn-answer-good', 'btn-answer-forgot', 'btn-answer-bad', 'btn-answer-again-hard',
      'btn-srs-good', 'btn-srs-easy', 'btn-srs-hard', 'btn-srs-again', 'btn-swipe-left', 'btn-swipe-right']
      .filter(hasId);
    t('no fourth answer button id exists', fourth.length === 0, fourth.join(', '));
    const answerBtns = doc.querySelectorAll('.btn-answer');
    t(`exactly 3 .btn-answer elements in index.html`, answerBtns.length === 3, `${answerBtns.length} found`);
  });

  /* ── F. V2 DOM CONTRACT ────────────────────────────────────────────────── */
  await runner.section('F. v2 DOM contract (SRS reform)', ({ t }) => {
    const contractIds = [
      'btn-hero-start-practice', 'btn-hero-start-learn',
      'dict-filter-group', 'dict-search-input', 'dict-cards-grid', 'btn-practice-group',
      'card-dir-indicator-front', 'card-dir-indicator-back',
      'card-level-pill-front', 'card-level-pill-back',
      'card-due-note-front', 'card-due-note-back',
      'modal-edit-card', 'edit-status', 'edit-level-en-ru', 'edit-level-ru-en', 'edit-due-info',
      'form-edit-card', 'edit-card-id',
      'screen-training', 'chart-stages', 'chart-activity',
      'stats-dir-en-ru', 'stats-dir-ru-en', 'toast-container',
      'btn-undo-card', 'btn-skip-card', 'train-counter', 'card-word-text', 'flashcard',
      'dash-total', 'dash-due', 'dash-learned', 'dash-accuracy', 'dash-due-en-ru', 'dash-due-ru-en',
    ];
    const missing = contractIds.filter((id) => !hasId(id));
    t(`all ${contractIds.length} contract ids present`, missing.length === 0, missing.join(', '));

    const rowsMissing = BUCKETS.filter((b) => !doc.querySelector(`.kg-row[data-group="${b}"]`));
    t('six .kg-row[data-group] rows (bank…mastered)', rowsMissing.length === 0, rowsMissing.join(', '));

    const barsMissing = BUCKETS.filter((b) => !hasId(`kg-bar-${b}`) || !hasId(`kg-count-${b}`));
    t('six #kg-count-* + #kg-bar-* pairs (lowercase buckets)', barsMissing.length === 0, barsMissing.join(', '));

    const dirMissing = ['eng-rus', 'auto', 'rus-eng'].filter((d) => !doc.querySelector(`.dir-btn[data-dir="${d}"]`));
    t('.dir-btn for eng-rus | auto | rus-eng', dirMissing.length === 0, dirMissing.join(', '));

    const filterVals = [...doc.querySelectorAll('#dict-filter-group option')].map((o) => o.value);
    const expectedVals = ['', ...BUCKETS, 'due'];
    t(`#dict-filter-group options = ${JSON.stringify(expectedVals)}`,
      JSON.stringify(filterVals) === JSON.stringify(expectedVals), `actual: ${JSON.stringify(filterVals)}`);

    const levelSel = (id) => [...doc.querySelectorAll(`#${id} option`)].map((o) => o.value).join(',');
    t('#edit-level-en-ru / #edit-level-ru-en offer levels 0..6',
      levelSel('edit-level-en-ru') === '0,1,2,3,4,5,6' && levelSel('edit-level-ru-en') === '0,1,2,3,4,5,6',
      `en:[${levelSel('edit-level-en-ru')}] ru:[${levelSel('edit-level-ru-en')}]`);

    const statusVals = [...doc.querySelectorAll('#edit-status option')].map((o) => o.value).sort().join(',');
    t('#edit-status offers BANK and ACTIVE', statusVals === 'ACTIVE,BANK', statusVals);
  });

  /* ── G. NAVIGATION COVERAGE ────────────────────────────────────────────── */
  await runner.section('G. navigation coverage', ({ t }) => {
    const unbound = navScreens.filter((s) => !hasId(`screen-${s}`));
    t(`every .nav-btn data-screen (${navScreens.join(', ')}) has a #screen-<id>`,
      unbound.length === 0, unbound.join(', '));
    const litUnbound = switchLiterals.filter((s) => !hasId(`screen-${s}`));
    t(`every switchScreen('…') literal in app.js has a #screen-<id>`,
      litUnbound.length === 0, litUnbound.join(', '));
    const screens = [...doc.querySelectorAll('section.screen')].map((s) => s.id);
    const orphan = screens.filter((id) => !navScreens.includes(id.replace(/^screen-/, '')) && id !== 'screen-training');
    t('no orphan screens (every section.screen is nav-reachable or the training screen)',
      orphan.length === 0, orphan.join(', '));
  });

  /* ── H. RUNTIME BOOT SMOKE ─────────────────────────────────────────────── */
  await runner.section(`H. runtime boot smoke (real data, fixed date ${FIXED_DATE})`, async ({ t }) => {
    let env = null;
    try {
      env = await createDomEnv({ fixedDate: FIXED_DATE, label: 'check-smoke' });
    } catch (e) {
      t('page boots in jsdom with srs.js loaded before app.js (initApp completes)', false, e.message);
      return;
    }
    t('page boots: initApp() completes (SRS global present, loadData settled)', true);
    t('window.SRS is the kernel loaded from srs.js', !!env.SRS && typeof env.SRS.buildReviewQueue === 'function');
    t('SRS.todayString() honours the pinned clock', env.todayString() === FIXED_DATE, env.todayString());

    const bootProblems = env.takeProblems();
    t('boot produced no uncaught errors / console.error', bootProblems.length === 0, bootProblems.join('\n'));

    // Dashboard == kernel summarize for the injected state.
    // Expected card count is derived from the data file itself (no hardcoded
    // numbers): loadData must not lose or invent cards.
    const fileState = require('./helpers/dom-env.cjs').loadJson(path.join(ROOT, 'data', 'leitner_data.json'));
    const summary = env.evalIn(`JSON.parse(JSON.stringify(SRS.summarize(appState.cards, srsToday())))`);
    t(`state loaded from data/leitner_data.json without card loss (${fileState.cards.length} cards)`,
      summary.total === fileState.cards.length, `file=${fileState.cards.length} loaded=${summary.total}`);
    for (const b of BUCKETS) {
      const txt = env.document.getElementById(`kg-count-${b}`).textContent;
      t(`dashboard #kg-count-${b} == SRS.summarize groups.${b.toUpperCase()} (${summary.groups[b.toUpperCase()]})`,
        txt === String(summary.groups[b.toUpperCase()]), `rendered "${txt}"`);
    }
    t('#dash-total == summary.bank', env.document.getElementById('dash-total').textContent === String(summary.bank));
    t('#dash-due == summary.dueEntries', env.document.getElementById('dash-due').textContent === String(summary.dueEntries));

    // stats-accuracy regression: calculateAccuracy() returns an OBJECT — the
    // fixed code prints acc.accuracy + '%'; the old bug printed "[object Object]%".
    const acc = env.document.getElementById('stats-accuracy').textContent;
    t('#stats-accuracy renders a number% (regression: was "[object Object]%")', /^\d+%$/.test(acc), acc);

    // Nav tour: every screen renders without throwing.
    const tour = [...env.document.querySelectorAll('.nav-btn')];
    let tourOk = true;
    const tourDetail = [];
    for (const btn of tour) {
      const target = btn.dataset.screen;
      env.click(btn);
      await env.tick(15);
      const active = env.activeScreen();
      if (active !== `screen-${target}`) { tourOk = false; tourDetail.push(`${target} → active=${active}`); }
    }
    t('nav tour: every .nav-btn activates its screen', tourOk, tourDetail.join('; '));
    const tourProblems = env.takeProblems();
    t('nav tour produced no uncaught errors / console.error', tourProblems.length === 0, tourProblems.join('\n'));

    // themechange re-render (the same event theme.js fires on load/selection)
    env.themeChange('midnight');
    await env.tick(20);
    const tcProblems = env.takeProblems();
    t('themechange re-renders dashboard/stats without throwing', tcProblems.length === 0, tcProblems.join('\n'));
    const sum2 = env.evalIn(`JSON.parse(JSON.stringify(SRS.summarize(appState.cards, srsToday())))`);
    const bankAfter = env.document.getElementById('kg-count-bank').textContent;
    t('dashboard still consistent after themechange', bankAfter === String(sum2.groups.BANK), `${bankAfter} vs ${sum2.groups.BANK}`);

    env.close();
  });

  process.exit(runner.finish());
})().catch((e) => {
  console.error('\nFATAL: check.cjs crashed —', e && e.stack || e);
  console.log(`\nFAIL 0/? — check.cjs — fatal: ${e && e.message}`);
  process.exit(1);
});
