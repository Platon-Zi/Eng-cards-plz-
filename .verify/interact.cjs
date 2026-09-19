#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// interact.cjs — BEHAVIOURAL end-to-end verification of the ENG CARDS SPA
// through the real DOM in jsdom. Everything is driven by real events
// (.click(), KeyboardEvent, change/input/submit dispatches); internal app.js
// state is only READ (via the window's global scope) to build assertions, and
// every expectation is derived from the SRS kernel — no hardcoded counts.
//
// Run from the repo root:  node .verify/interact.cjs
// Exits non-zero on any failure. Final line: `PASS n/m` or `FAIL n/m (…)`.
//
// Environments:
//   env1 — real data/leitner_data.json, fixed date 2026-09-17  (dashboard,
//          dictionary, edit modal, delete, practice session, grading walk,
//          double-grade guard, undo, skip, keyboard, themechange)
//   env2 — crafted 7-card state with known vectors                (exact
//          grading arithmetic for again/hard/easy, requeue, learn mode)
//   env3 — .verify/fixtures/legacy-198.json (schema 1, BOM'd)   (automatic
//          startup migration path)
//
// NOTE: .verify/test-srs.cjs already covers the pure kernel (104 tests).
// This file deliberately does NOT re-test kernel logic — it tests that the
// DOM/UI layer drives that kernel correctly and renders its results.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const {
  createDomEnv, createRunner, loadJson, deepClone, deepEqual,
  stableStringify, BUCKETS, ANSWER_BTNS, ROOT,
} = require('./helpers/dom-env.cjs');
const SRS = require(path.join(ROOT, 'srs.js'));   // Node-side kernel for expectations

const T = '2026-09-17';                            // fixed date for every env
const runner = createRunner('interact.cjs — behavioural DOM integration');

/* ───────────────────────── shared helpers ───────────────────────── */

const otherDir = (d) => (d === 'en_ru' ? 'ru_en' : 'en_ru');

/** JSON view of the item currently shown by the trainer (null if none). */
function currentItem(env) {
  return env.evalIn(`(function(){
    if (!currentTrainingItem) return null;
    return JSON.parse(JSON.stringify({
      key: currentTrainingItem.key, cardId: currentTrainingItem.cardId,
      direction: currentTrainingItem.direction, kind: currentTrainingItem.kind || 'review',
      index: currentCardIndex, total: currentTrainingQueue.length
    }));
  })()`);
}

function counterText(env) { return env.document.getElementById('train-counter').textContent; }

function histSnapshot(env) {
  return env.evalIn(`(function(){ const h = appState.history[${JSON.stringify(T)}]; return h ? JSON.parse(JSON.stringify(h)) : null; })()`);
}

function gradedCount(env) { return env.evalIn(`srsSession ? Object.keys(srsSession.graded).length : -1`); }
function isGraded(env, key) { return env.evalIn(`!!(srsSession && srsSession.graded[${JSON.stringify(String(key))}])`); }

function setSelect(env, el, value) {
  el.value = value;
  el.dispatchEvent(new env.window.Event('change', { bubbles: true }));
}
function setInput(env, el, value) {
  el.value = value;
  el.dispatchEvent(new env.window.Event('input', { bubbles: true }));
}
function submitForm(env, form) {
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
}

/** The card chrome (direction / level pill / due note) must describe the
 *  queue item's direction, computed from the LIVE card via the kernel. */
function verifyCardChrome(env, t, item, label) {
  const d = env.document;
  const card = env.card(item.cardId);
  if (!card) { t(`${label}: card ${item.cardId} exists`, false, 'cardById returned null'); return; }
  const dir = SRS.normalizeDir(item.direction);
  const chrome = SRS.describeDirection(card, dir, T, 'en');
  t(`${label}: #card-dir-indicator-front shows the queue item's direction (${chrome.short})`,
    d.getElementById('card-dir-indicator-front').textContent === chrome.short,
    `"${d.getElementById('card-dir-indicator-front').textContent}" ≠ "${chrome.short}"`);
  t(`${label}: #card-dir-indicator-back matches too`,
    d.getElementById('card-dir-indicator-back').textContent === chrome.short);
  const wantPrompt = dir === 'en_ru' ? card.word : card.translation;
  t(`${label}: prompt text is the ${dir} side of the card`,
    d.getElementById('card-word-text').textContent === wantPrompt,
    `"${d.getElementById('card-word-text').textContent}" ≠ "${wantPrompt}"`);
  const wantPill = `${chrome.levelLabel} · ${chrome.group}`;
  t(`${label}: level pill = ${wantPill}`,
    d.getElementById('card-level-pill-front').textContent === wantPill,
    `"${d.getElementById('card-level-pill-front').textContent}"`);
  t(`${label}: due note = kernel phrase "${chrome.phrase}"`,
    d.getElementById('card-due-note-front').textContent === chrome.phrase,
    `"${d.getElementById('card-due-note-front').textContent}"`);
  t(`${label}: counter shows ${item.index + 1} / ${item.total}`,
    counterText(env).startsWith(`${item.index + 1} / ${item.total}`), counterText(env));
}

/**
 * Grade the currently shown item through `act` (a real click or key press)
 * and verify the FULL mutation equals SRS.applyAnswer on the shown direction:
 *  • whole card == kernel expectation (covers level, date, counters, status);
 *  • the other vector is byte-identical;
 *  • the answered direction is not due again the same day;
 *  • history[today] gained exactly one graded entry;
 *  • exactly one undo frame was pushed.
 */
async function gradeVia(env, t, answer, act, label) {
  const item = await currentItem(env);
  if (!item) { t(`${label}: an item is shown`, false, 'currentTrainingItem is null'); return null; }
  const before = env.card(item.cardId);
  const dir = SRS.normalizeDir(item.direction);
  const histBefore = histSnapshot(env);
  const undoBefore = env.evalIn(`sessionUndoStack.length`);

  verifyCardChrome(env, t, item, label);
  act();
  await env.tick(35);

  const expected = SRS.applyAnswer(deepClone(before), dir, answer, T).card;
  const live = env.card(item.cardId);
  t(`${label}: card after "${answer}" == SRS.applyAnswer (dir ${dir})`,
    deepEqual(live, expected),
    `live    = ${stableStringify(live, 320)}\nexpected= ${stableStringify(expected, 320)}`);

  const od = otherDir(dir);
  if (String(before.status || '').toUpperCase() === 'ACTIVE') {
    t(`${label}: other vector (${od}) byte-identical`,
      live[`level_${od}`] === before[`level_${od}`] && live[`next_review_${od}`] === before[`next_review_${od}`],
      `L${before[`level_${od}`]}/${before[`next_review_${od}`]} → L${live[`level_${od}`]}/${live[`next_review_${od}`]}`);
  } else {
    // Answering a BANK card activates it: the kernel deliberately stamps BOTH
    // review dates to today so the second side is learnable in the same lesson.
    t(`${label}: activation from BANK leaves ${od} at L0 due today (kernel activation semantics)`,
      live[`level_${od}`] === 0 && live[`next_review_${od}`] === T,
      `L${live[`level_${od}`]}/${live[`next_review_${od}`]}`);
  }

  t(`${label}: answered direction not due again the same day`,
    SRS.isDirectionDue(live, dir, T) === false,
    `next_review_${dir} = ${live[`next_review_${dir}`]}, today = ${T}`);

  const histAfter = histSnapshot(env);
  const dTotal = (histAfter && histAfter.total || 0) - (histBefore && histBefore.total || 0);
  const dAns = ((histAfter && histAfter.byAnswer && histAfter.byAnswer[answer]) || 0)
    - ((histBefore && histBefore.byAnswer && histBefore.byAnswer[answer]) || 0);
  const dDir = ((histAfter && histAfter.byDirection && histAfter.byDirection[dir] && histAfter.byDirection[dir].total) || 0)
    - ((histBefore && histBefore.byDirection && histBefore.byDirection[dir] && histBefore.byDirection[dir].total) || 0);
  const dCorr = ((histAfter && histAfter.byDirection && histAfter.byDirection[dir] && histAfter.byDirection[dir].correct) || 0)
    - ((histBefore && histBefore.byDirection && histBefore.byDirection[dir] && histBefore.byDirection[dir].correct) || 0);
  t(`${label}: history gained exactly one graded entry (total +1, byAnswer.${answer} +1, byDirection.${dir} +1)`,
    dTotal === 1 && dAns === 1 && dDir === 1 && dCorr === (answer === 'again' ? 0 : 1),
    `Δtotal=${dTotal} Δ${answer}=${dAns} Δdir=${dDir} Δcorrect=${dCorr}`);

  const undoDelta = env.evalIn(`sessionUndoStack.length`) - undoBefore;
  t(`${label}: exactly one undo frame pushed`, undoDelta === 1, `Δ=${undoDelta}`);
  return { item, before, live, dir };
}

/* Crafted-state card factory (schema-2 native). */
function mkCard(id, word, translation, status, le, de, lr, dr) {
  return {
    id, word, phonetic: '', translation,
    example: `Example for ${word}.`, example_translation: `Пример для ${word}.`,
    part_of_speech: 'noun', partOfSpeech: 'noun',
    batch_id: 'batch_verify', batch_name: 'Verify Batch',
    created_at: '2026-09-01',
    status, level_en_ru: le, next_review_en_ru: de, level_ru_en: lr, next_review_ru_en: dr,
    fail_count: 0, review_count: 0,
  };
}
const dd = (n) => SRS.addDays(T, n);

/* ─────────────────────────────────────────────────────────────────────────── */

(async () => {
  const envs = [];
  const boot = async (opts) => { const env = await createDomEnv(opts); envs.push(env); return env; };

  /* ═══════════════ ENV 1 — REAL DATA ═══════════════ */

  let env = null;
  try {
    env = await boot({ fixedDate: T, label: 'real-data' });
  } catch (e) {
    runner.t('env1 boots (real data, srs.js before app.js, initApp completes)', false, e.message);
  }

  if (env) {
    /* ── 1. Dashboard == SRS.summarize ─────────────────────────────────── */
    await runner.section('1. dashboard renders SRS.summarize of the injected state', async ({ t }) => {
      t('boot produced no uncaught errors / console.error', env.problems.length === 0, env.problems.join('\n'));
      t('booted on the dashboard screen', env.activeScreen() === 'screen-dashboard', env.activeScreen());
      t('save guard did not block the startup save', env.evalIn(`saveBlockedReason`) === null, String(env.evalIn(`saveBlockedReason`)));

      const cards = env.snapshotState().cards;
      const sum = SRS.summarize(deepClone(cards), T);
      console.log(`   ℹ️ loaded ${sum.total} cards · bank ${sum.bank} · dueEntries ${sum.dueEntries} · groups ${JSON.stringify(sum.groups)}`);

      let countsOk = true, countsDetail = [];
      let barsOk = true, barsDetail = [];
      for (const b of BUCKETS) {
        const g = sum.groups[b.toUpperCase()] || 0;
        const cnt = env.document.getElementById(`kg-count-${b}`).textContent;
        if (cnt !== String(g)) { countsOk = false; countsDetail.push(`${b}: "${cnt}" ≠ ${g}`); }
        const wantW = `${Math.min(100, Math.round((g / Math.max(sum.total, 1)) * 100))}%`;
        const gotW = env.document.getElementById(`kg-bar-${b}`).style.width;
        if (gotW !== wantW) { barsOk = false; barsDetail.push(`${b}: "${gotW}" ≠ "${wantW}"`); }
      }
      t('all six #kg-count-<bucket> == summarize.groups', countsOk, countsDetail.join('; '));
      t('all six #kg-bar-<bucket> widths == count/total share', barsOk, barsDetail.join('; '));

      const txt = (id) => env.document.getElementById(id).textContent;
      t('#dash-total == summary.bank ("In the Bank" KPI)', txt('dash-total') === String(sum.bank), `${txt('dash-total')} vs ${sum.bank}`);
      t('#dash-learned == summary.groups.MASTERED', txt('dash-learned') === String(sum.groups.MASTERED || 0));
      t('#dash-due == summary.dueEntries', txt('dash-due') === String(sum.dueEntries), txt('dash-due'));
      t('#dash-due-now == summary.dueEntries', txt('dash-due-now') === String(sum.dueEntries));
      t('#dash-due-en-ru == summary.dueByDirection.en_ru', txt('dash-due-en-ru') === String(sum.dueByDirection.en_ru));
      t('#dash-due-ru-en == summary.dueByDirection.ru_en', txt('dash-due-ru-en') === String(sum.dueByDirection.ru_en));
      t('#dash-accuracy is a number%', /^\d+%$/.test(txt('dash-accuracy')), txt('dash-accuracy'));
      t('#hero-due-text describes the due load', /Due now: \d+ sides? across \d+ words?/.test(txt('hero-due-text')) || sum.dueEntries === 0, txt('hero-due-text'));
    });

    /* ── 2. Stats screen ───────────────────────────────────────────────── */
    await runner.section('2. stats screen renders kernel analytics', async ({ t }) => {
      env.click('.nav-btn[data-screen="stats"]');
      await env.tick(30);
      t('nav → screen-stats', env.activeScreen() === 'screen-stats', env.activeScreen());
      const cards = env.snapshotState().cards;
      const sum = SRS.summarize(deepClone(cards), T);
      const txt = (id) => env.document.getElementById(id).textContent;
      t('#stats-total-cards == cards.length', txt('stats-total-cards') === String(cards.length), txt('stats-total-cards'));
      t('#stats-due-cards == summary.dueEntries', txt('stats-due-cards') === String(sum.dueEntries), txt('stats-due-cards'));
      t('#stats-mastered-cards == groups.MASTERED', txt('stats-mastered-cards') === String(sum.groups.MASTERED || 0));
      // Regression guard: calculateAccuracy() returns an OBJECT; the pre-fix code
      // printed "[object Object]%" here. Must stay a plain percentage.
      t('#stats-accuracy is a number% (regression: "[object Object]%")', /^\d+%$/.test(txt('stats-accuracy')), txt('stats-accuracy'));
      const dirRe = /^avg L\d+\.\d+ · \d+ due · \d+ overdue$/;
      t('#stats-dir-en-ru formatted from the kernel', dirRe.test(txt('stats-dir-en-ru')) || sum.active === 0, txt('stats-dir-en-ru'));
      t('#stats-dir-ru-en formatted from the kernel', dirRe.test(txt('stats-dir-ru-en')) || sum.active === 0, txt('stats-dir-ru-en'));
      t('#chart-stages + #chart-activity exist (fallback renderer ran without throwing)',
        !!env.document.getElementById('chart-stages') && !!env.document.getElementById('chart-activity'));
      const p = env.takeProblems();
      t('stats render produced no errors', p.length === 0, p.join('\n'));
      env.click('.nav-btn[data-screen="dashboard"]');
      await env.tick(15);
    });

    /* ── 3. Dictionary: tiles, chips, filters, search, unique ids ──────── */
    await runner.section('3. dictionary tiles + group filter + search', async ({ t }) => {
      env.click('.nav-btn[data-screen="dictionary"]');
      await env.tick(30);
      const d = env.document;
      const tiles = () => d.querySelectorAll('#dict-cards-grid .dict-card');
      const cards = env.snapshotState().cards;
      t(`every card renders one tile (${cards.length})`, tiles().length === cards.length, `${tiles().length} tiles`);

      const chipCounts = env.evalJson(`JSON.stringify(Array.from(document.querySelectorAll('#dict-cards-grid .dict-card')).map(c => c.querySelectorAll('.dict-dir-chip').length))`);
      t('every tile shows exactly TWO direction chips',
        chipCounts.length === cards.length && chipCounts.every((n) => n === 2),
        `bad tiles: ${chipCounts.map((n, i) => (n === 2 ? null : i + ':' + n)).filter(Boolean).slice(0, 10).join(', ')}`);

      const allIds = env.evalJson(`JSON.stringify(Array.from(document.querySelectorAll('[id]')).map(e => e.id))`);
      const seen = new Set(), dupes = [];
      for (const id of allIds) { if (seen.has(id)) dupes.push(id); seen.add(id); }
      t(`no duplicate DOM ids anywhere after rendering ${cards.length} tiles (${allIds.length} ids)`,
        dupes.length === 0, [...new Set(dupes)].join(', '));

      const expectedCount = (f) => {
        if (!f) return cards.length;
        if (f === 'due') return cards.filter((c) => SRS.isDue(c, T)).length;
        return cards.filter((c) => String(SRS.derivedGroup(c)).toLowerCase() === f).length;
      };
      const sel = d.getElementById('dict-filter-group');
      for (const f of ['', ...BUCKETS, 'due']) {
        setSelect(env, sel, f);
        await env.tick(20);
        const want = expectedCount(f);
        t(`filter "${f || 'all'}" → ${want} tiles (kernel-computed)`, tiles().length === want, `${tiles().length} rendered`);
        const practiceVisible = !d.getElementById('btn-practice-group').classList.contains('hidden');
        t(`filter "${f || 'all'}": #btn-practice-group ${f ? 'visible' : 'hidden'}`, practiceVisible === !!f);
      }

      // search
      setSelect(env, sel, '');
      await env.tick(15);
      const probe = String(cards[Math.floor(cards.length / 2)].word || '').toLowerCase();
      const search = d.getElementById('dict-search-input');
      setInput(env, search, probe);
      await env.tick(20);
      const wantSearch = cards.filter((c) =>
        String(c.word || '').toLowerCase().includes(probe) ||
        String(c.translation || '').toLowerCase().includes(probe)).length;
      t(`search "${probe}" → ${wantSearch} tiles`, tiles().length === wantSearch, `${tiles().length} rendered`);
      t('search: every visible tile actually matches',
        Array.from(tiles()).every((el) => el.textContent.toLowerCase().includes(probe)));
      setInput(env, search, '');
      await env.tick(20);
      t('clearing search restores all tiles', tiles().length === cards.length, `${tiles().length}`);
      const p = env.takeProblems();
      t('dictionary section produced no errors', p.length === 0, p.join('\n'));
    });

    /* ── 4. Edit modal: prefill + level change recomputes next_review ──── */
    await runner.section('4. edit modal (both level selects; save recomputes next_review_*)', async ({ t }) => {
      const d = env.document;
      const cardId = env.evalIn(`appState.cards[0].id`);
      const before = env.card(cardId);
      env.click(d.querySelector('#dict-cards-grid .dict-card .btn-dict-edit'));
      await env.tick(20);
      const modal = d.getElementById('modal-edit-card');
      t('modal opens (no .hidden)', !modal.classList.contains('hidden'));
      t('#edit-card-id prefilled', d.getElementById('edit-card-id').value === cardId);
      t('#edit-word / #edit-translation prefilled',
        d.getElementById('edit-word').value === before.word && d.getElementById('edit-translation').value === before.translation);
      t('#edit-level-en-ru select populated with the card level',
        d.getElementById('edit-level-en-ru').value === String(Number(before.level_en_ru) || 0), d.getElementById('edit-level-en-ru').value);
      t('#edit-level-ru-en select populated with the card level',
        d.getElementById('edit-level-ru-en').value === String(Number(before.level_ru_en) || 0), d.getElementById('edit-level-ru-en').value);
      t('#edit-status reflects the card status',
        d.getElementById('edit-status').value === String(before.status || 'ACTIVE').toUpperCase());
      t('#edit-due-info shows the schedule (readonly)', d.getElementById('edit-due-info').value.length > 0, d.getElementById('edit-due-info').value);

      const cur = Number(before.level_en_ru) || 0;
      const newLe = cur <= 3 ? Math.min(6, cur + 2) : cur - 2;
      d.getElementById('edit-level-en-ru').value = String(newLe);
      submitForm(env, d.getElementById('form-edit-card'));
      await env.tick(40);

      const live = env.card(cardId);
      t('modal hidden after save', modal.classList.contains('hidden'));
      t(`level_en_ru ${cur} → ${newLe}`, live.level_en_ru === newLe, String(live.level_en_ru));
      t(`next_review_en_ru recomputed = today + INTERVALS[${newLe}] = ${SRS.addDays(T, SRS.INTERVALS[newLe])}`,
        live.next_review_en_ru === SRS.addDays(T, SRS.INTERVALS[newLe]), live.next_review_en_ru);
      t('ru_en vector untouched by the en_ru edit',
        live.level_ru_en === before.level_ru_en && live.next_review_ru_en === before.next_review_ru_en);
      t('content fields preserved', live.word === before.word && live.translation === before.translation);
      t('save guard not tripped by the edit', env.evalIn(`saveBlockedReason`) === null, String(env.evalIn(`saveBlockedReason`)));

      // Escape closes the modal
      env.click(d.querySelector('#dict-cards-grid .dict-card .btn-dict-edit'));
      await env.tick(15);
      t('modal reopened for the Escape test', !modal.classList.contains('hidden'));
      env.key('Escape');
      await env.tick(15);
      t('Escape closes the edit modal', modal.classList.contains('hidden'));
      const p = env.takeProblems();
      t('edit-modal section produced no errors', p.length === 0, p.join('\n'));
    });

    /* ── 5. Delete: tombstone + save guard ─────────────────────────────── */
    await runner.section('5. delete from dictionary → deleted_ids tombstone, save guard quiet', async ({ t }) => {
      const d = env.document;
      const idsBefore = env.evalJson(`JSON.stringify(appState.cards.map(c => c.id))`);
      const delId = env.evalIn(`appState.cards[3].id`);
      const delWord = env.evalIn(`appState.cards[3].word`);
      const tilesBefore = d.querySelectorAll('#dict-cards-grid .dict-card').length;
      env.confirms.length = 0;

      env.click(d.querySelectorAll('#dict-cards-grid .dict-card')[3].querySelector('.btn-dict-delete'));
      await env.tick(50);

      t('confirm() was asked and mentions the word', env.confirms.some((m) => m.includes(delWord)), env.confirms.join(' | '));
      const idsAfter = env.evalJson(`JSON.stringify(appState.cards.map(c => c.id))`);
      t('exactly one card removed from appState', idsAfter.length === idsBefore.length - 1 && !idsAfter.includes(delId),
        `${idsBefore.length} → ${idsAfter.length}`);
      t(`appState.deleted_ids contains "${delId}"`, env.evalJson(`JSON.stringify(appState.deleted_ids || [])`).includes(delId));
      t('save guard NOT tripped (saveBlockedReason === null)', env.evalIn(`saveBlockedReason`) === null, String(env.evalIn(`saveBlockedReason`)));
      const toastTxt = d.getElementById('toast-container').textContent;
      t('toast reports the deletion, not a blocked save', /deleted/i.test(toastTxt) && !/blocked/i.test(toastTxt), toastTxt.slice(0, 200));
      t(`tile count ${tilesBefore} → ${tilesBefore - 1}`,
        d.querySelectorAll('#dict-cards-grid .dict-card').length === tilesBefore - 1);

      const stored = JSON.parse(env.window.localStorage.getItem('leitner_data'));
      t('localStorage: card gone, tombstone persisted',
        !!stored && Array.isArray(stored.deleted_ids) && stored.deleted_ids.includes(delId)
        && !stored.cards.some((c) => c.id === delId));
      const p = env.takeProblems();
      t('delete section produced no errors', p.length === 0, p.join('\n'));
    });

    /* ── 6. Practice from the dictionary "due" filter ──────────────────── */
    await runner.section('6. #btn-practice-group on filter "due" starts the system session', async ({ t }) => {
      const d = env.document;
      setSelect(env, d.getElementById('dict-filter-group'), 'due');
      await env.tick(20);
      const dueCards = SRS.summarize(deepClone(env.snapshotState().cards), T).dueCards;
      t(`"due" filter shows exactly the due words (${dueCards})`,
        d.querySelectorAll('#dict-cards-grid .dict-card').length === dueCards);
      env.click('#btn-practice-group');
      await env.tick(40);
      t('training screen opened', env.activeScreen() === 'screen-training', env.activeScreen());
      const want = env.evalIn(`SRS.buildReviewQueue(appState.cards, srsToday(), { seed: sessionSeed }).length`);
      const total = (await currentItem(env)).total;
      t(`session queue length == SRS.buildReviewQueue (${want})`, total === want, `${total} vs ${want}`);
      env.key('Escape');
      await env.tick(20);
      t("Escape returns to the session's source screen (dashboard for 'system')",
        env.activeScreen() === 'screen-dashboard', env.activeScreen());
    });

    /* ── 7. Hero Practice: queue identity + grading walk ───────────────── */
    const walkAnswers = ['easy', 'hard', 'easy', 'easy', 'hard', 'easy', 'easy', 'hard'];
    await runner.section('7. main Practice button: queue == kernel, walk with real clicks', async ({ t }) => {
      const cardsNow = env.snapshotState().cards;              // AFTER edit+delete mutations
      const expectedQ = SRS.buildReviewQueue(deepClone(cardsNow), T, { seed: T });
      env.click('#btn-hero-start-practice');
      await env.tick(40);
      t('hero Practice opens the training screen', env.activeScreen() === 'screen-training', env.activeScreen());

      const actualKeys = env.evalJson(`JSON.stringify(currentTrainingQueue.map(i => i.key))`);
      const expectedKeys = expectedQ.map((i) => i.key);
      console.log(`   ℹ️ review queue: ${expectedKeys.length} entries on ${T} (kernel-derived)`);
      t('queue == SRS.buildReviewQueue(cards, today, {seed: today}) — same order',
        deepEqual(actualKeys, expectedKeys),
        `actual[0..4]=${JSON.stringify(actualKeys.slice(0, 5))} expected[0..4]=${JSON.stringify(expectedKeys.slice(0, 5))}`);

      const actualIds = env.evalJson(`JSON.stringify(currentTrainingQueue.map(i => i.cardId))`);
      let adjacent = [];
      for (let i = 1; i < actualIds.length; i++) if (actualIds[i] === actualIds[i - 1]) adjacent.push(i);
      t('the same card never appears twice in a row in the queue', adjacent.length === 0, `adjacent at ${adjacent.join(',')}`);

      const renderedSeq = [];
      for (let step = 0; step < walkAnswers.length; step++) {
        const answer = walkAnswers[step];
        const item = await currentItem(env);
        if (!item) { t(`walk step ${step}: item shown`, false, 'session ended early'); break; }
        renderedSeq.push(item.cardId);
        await gradeVia(env, t, answer, () => env.click(ANSWER_BTNS[answer]), `walk[${step}] ${answer}`);
      }
      let seqOk = true;
      for (let i = 1; i < renderedSeq.length; i++) if (renderedSeq[i] === renderedSeq[i - 1]) seqOk = false;
      t('rendered sequence never repeated the same card back-to-back', seqOk, renderedSeq.join(' → '));
      t('still in session after the walk (queue longer than 8)', env.activeScreen() === 'screen-training');
      const p = env.takeProblems();
      t('walk produced no errors', p.length === 0, p.join('\n'));
    });

    /* ── 8. Double-grading the same item is rejected ───────────────────── */
    let doubleCtx = null;
    await runner.section('8. double-grade guard (two synchronous clicks)', async ({ t }) => {
      const item = await currentItem(env);
      const idxX = item.index, keyX = item.key;
      const beforeX = env.card(item.cardId);
      const nextInfo = env.evalJson(`JSON.stringify((function(){ const it = currentTrainingQueue[${idxX + 1}]; return it ? {key: it.key, cardId: it.cardId} : null; })())`);
      const beforeNext = nextInfo ? env.card(nextInfo.cardId) : null;
      const histBefore = histSnapshot(env);
      const undoBefore = env.evalIn(`sessionUndoStack.length`);
      const gradedBefore = gradedCount(env);
      const qLenBefore = env.evalIn(`currentTrainingQueue.length`);

      env.click(ANSWER_BTNS.easy);   // two clicks with NO await between them —
      env.click(ANSWER_BTNS.easy);   // the guard must absorb the second one
      await env.tick(50);

      const expected = SRS.applyAnswer(deepClone(beforeX), SRS.normalizeDir(item.direction), 'easy', T).card;
      const live = env.card(item.cardId);
      t('second click did NOT apply the answer twice (card == single applyAnswer)',
        deepEqual(live, expected),
        `live    = ${stableStringify(live, 300)}\nsingle  = ${stableStringify(expected, 300)}`);
      t('graded registry gained exactly one entry', gradedCount(env) === gradedBefore + 1, `${gradedBefore} → ${gradedCount(env)}`);
      t('the item is registered as graded', isGraded(env, keyX));
      if (nextInfo) {
        t('the NEXT queue item was not consumed/graded by the second click',
          !isGraded(env, nextInfo.key) && deepEqual(env.card(nextInfo.cardId), beforeNext));
      }
      const histAfter = histSnapshot(env);
      t('history counted the answer exactly once',
        (histAfter.total || 0) - (histBefore && histBefore.total || 0) === 1);
      t('exactly one undo frame from the double click',
        env.evalIn(`sessionUndoStack.length`) === undoBefore + 1);
      t('queue length unchanged by the rejected second grade',
        env.evalIn(`currentTrainingQueue.length`) === qLenBefore);
      doubleCtx = { idxX, keyX, beforeX, histBefore };
    });

    /* ── 9. Undo restores BOTH vectors exactly ─────────────────────────── */
    await runner.section('9. undo (#btn-undo-card) restores both vectors exactly', async ({ t }) => {
      const { idxX, keyX, beforeX, histBefore } = doubleCtx;
      env.click('#btn-undo-card');
      await env.tick(50);
      const live = env.card(keyX.split(':')[0]);
      t('card restored byte-for-byte (both vectors)', deepEqual(live, beforeX),
        `live    = ${stableStringify(live, 300)}\nbefore  = ${stableStringify(beforeX, 300)}`);
      t('graded mark removed (pair can be graded again)', !isGraded(env, keyX));
      const item = await currentItem(env);
      t('trainer went back to the undone item', item && item.key === keyX, item ? item.key : 'null');
      t('queue item un-marked (done === false)',
        env.evalIn(`currentTrainingQueue[${idxX}].done`) === false);
      t(`counter back at "${idxX + 1} / "`, counterText(env).startsWith(`${idxX + 1} / `), counterText(env));
      const histNow = histSnapshot(env);
      t('history rolled back to the pre-answer snapshot',
        deepEqual(histNow, histBefore), `${stableStringify(histNow, 160)} vs ${stableStringify(histBefore, 160)}`);
    });

    /* ── 10. Skip does not grade ───────────────────────────────────────── */
    await runner.section('10. skip (#btn-skip-card) moves to the tail without grading', async ({ t }) => {
      const item = await currentItem(env);
      const snap = env.card(item.cardId);
      const histBefore = histSnapshot(env);
      const qLenBefore = env.evalIn(`currentTrainingQueue.length`);
      env.click('#btn-skip-card');
      await env.tick(30);
      t('skipped card completely unchanged', deepEqual(env.card(item.cardId), snap));
      t('skip did not grade the pair', !isGraded(env, item.key));
      t('history untouched by the skip', deepEqual(histSnapshot(env), histBefore));
      t('queue length unchanged (moved, not dropped)', env.evalIn(`currentTrainingQueue.length`) === qLenBefore);
      t('skipped item sits at the tail of the queue',
        env.evalIn(`currentTrainingQueue[currentTrainingQueue.length - 1].key`) === item.key);
      const now = await currentItem(env);
      t('trainer advanced to a different item', now && now.key !== item.key, now ? now.key : 'null');
      t('skip registered in the session registry', env.evalIn(`srsSession.skipped[${JSON.stringify(item.key)}] || 0`) === 1);
    });

    /* ── 11. Keyboard contract ─────────────────────────────────────────── */
    await runner.section('11. keyboard: 1/← again · 2/↑ hard · 3/→ easy · 4 nothing · 0 bank · W skip · Space flip · Escape back', async ({ t }) => {
      const d = env.document;
      // Space flips the card
      const flash = d.getElementById('flashcard');
      env.key(' ', { code: 'Space' });
      await env.tick(15);
      t('Space flips the card (.flipped)', flash.classList.contains('flipped'));
      env.key(' ', { code: 'Space' });
      await env.tick(15);
      t('Space flips it back', !flash.classList.contains('flipped'));

      // '4' is intentionally dead
      const z = await currentItem(env);
      const zSnap = env.card(z.cardId);
      const zState = JSON.stringify({ idx: z.index, counter: counterText(env), qLen: z.total, graded: gradedCount(env), hist: histSnapshot(env) });
      env.key('4');
      await env.tick(25);
      const z2 = await currentItem(env);
      const zState2 = JSON.stringify({ idx: z2 ? z2.index : null, counter: counterText(env), qLen: z2 ? z2.total : null, graded: gradedCount(env), hist: histSnapshot(env) });
      t("key '4' does nothing (no fourth answer)", zState === zState2 && deepEqual(env.card(z.cardId), zSnap), `${zState} → ${zState2}`);

      // '1' → again (+ requeue into this session)
      const qLenBefore = z.total;
      const r1 = await gradeVia(env, t, 'again', () => env.key('1'), "key '1' → again");
      t("'again' requeues the word into THIS session (queue grew by the copy)",
        env.evalIn(`currentTrainingQueue.length`) === qLenBefore + 1
        && env.evalIn(`currentTrainingQueue.some(i => i.key === ${JSON.stringify(z.key)} && i.kind === 'requeue')`),
        `len ${qLenBefore} → ${env.evalIn(`currentTrainingQueue.length`)}`);
      // order зеркалит items (инвариант ядра) — и до, и после undo «Забыл»:
      // раньше undo вырезал requeue-копию из items, но оставлял призрак в order.
      const mirrorExpr = `JSON.stringify(srsSession.order) === JSON.stringify(currentTrainingQueue.map(function (i) { return i.key; }))`;
      t('session.order mirrors items with the requeue copy present', env.evalIn(mirrorExpr));
      env.key('ArrowDown');
      await env.tick(40);
      t('undo removed the requeue ghost from order (mirror restored)', env.evalIn(mirrorExpr));
      t('no requeue copy left for the undone key',
        env.evalIn(`currentTrainingQueue.filter(function (i) { return i.key === ${JSON.stringify(z.key)} && i.kind === 'requeue'; }).length`) === 0);
      // поток секции продолжается: следующий gradeVia просто переоценит восстановленный item

      // ← → again, 2 → hard, 3 → easy, → → easy
      await gradeVia(env, t, 'again', () => env.key('ArrowLeft'), "key 'ArrowLeft' → again");
      await gradeVia(env, t, 'hard', () => env.key('2'), "key '2' → hard");
      await gradeVia(env, t, 'easy', () => env.key('3'), "key '3' → easy");
      await gradeVia(env, t, 'easy', () => env.key('ArrowRight'), "key 'ArrowRight' → easy");
      await gradeVia(env, t, 'hard', () => env.key('ArrowUp'), "key 'ArrowUp' → hard (↑ reassigned from skip)");
      // W по-прежнему отправляет в конец очереди без оценки (↑ больше не skip)
      const wItem = await currentItem(env);
      env.key('w');
      await env.tick(30);
      t("key 'w' skips to end without grading", !isGraded(env, wItem.key)
        && env.evalIn(`currentTrainingQueue[currentTrainingQueue.length - 1].key`) === wItem.key,
        `graded=${isGraded(env, wItem.key)}`);
      void r1;

      // '0' → return the word to the Bank
      const v = await currentItem(env);
      const vSnap = env.card(v.cardId);
      env.key('0');
      await env.tick(40);
      const vLive = env.card(v.cardId);
      const wantBank = SRS.returnToBank(deepClone(vSnap));
      t("key '0' returns the word to the Bank (status BANK, levels 0, dates null)",
        deepEqual(vLive, wantBank), `live=${stableStringify(vLive, 260)} want=${stableStringify(wantBank, 260)}`);
      const afterV = await currentItem(env);
      t("'0' advanced the trainer", afterV && afterV.key !== v.key, afterV ? afterV.key : 'null');

      // ArrowDown → undo the bank move, both vectors restored exactly
      env.key('ArrowDown');
      await env.tick(40);
      t('ArrowDown (undo) restored the card from the Bank move exactly',
        deepEqual(env.card(v.cardId), vSnap), stableStringify(env.card(v.cardId), 260));
      const back = await currentItem(env);
      t('undo put the trainer back on the same item', back && back.key === v.key, back ? back.key : 'null');

      // Escape leaves training
      env.key('Escape');
      await env.tick(25);
      t('Escape leaves training back to the source screen (dashboard)',
        env.activeScreen() === 'screen-dashboard', env.activeScreen());
      const p = env.takeProblems();
      t('keyboard section produced no errors', p.length === 0, p.join('\n'));
    });

    /* ── 12. themechange re-renders without throwing ───────────────────── */
    await runner.section('12. themechange re-renders dashboard + stats', async ({ t }) => {
      const sum = SRS.summarize(deepClone(env.snapshotState().cards), T);
      env.themeChange('midnight');
      await env.tick(30);
      env.themeChange('light');
      await env.tick(30);
      const p = env.takeProblems();
      t('two themechange events produced no errors', p.length === 0, p.join('\n'));
      const bankNow = env.document.getElementById('kg-count-bank').textContent;
      t('dashboard still consistent with the kernel after re-render',
        bankNow === String(sum.groups.BANK), `${bankNow} vs ${sum.groups.BANK}`);
      const dueNow = env.document.getElementById('dash-due').textContent;
      t('#dash-due still == dueEntries after re-render', dueNow === String(sum.dueEntries), `${dueNow} vs ${sum.dueEntries}`);
      t('#stats-dir-en-ru still populated after re-render',
        env.document.getElementById('stats-dir-en-ru').textContent.length > 0);
    });
  }

  /* ═══════════════ ENV 2 — CRAFTED GRADING STATE ═══════════════ */

  const craftedCards = [
    mkCard('gv_t1', 'tundra alpha', 'тундра альфа', 'ACTIVE', 3, dd(0), 5, dd(10)),   // easy → L4
    mkCard('gv_t2', 'bravo ridge', 'гребень браво', 'ACTIVE', 2, dd(-3), 4, dd(5)),   // hard → frozen L2
    mkCard('gv_t3', 'charlie pit', 'яма чарли', 'ACTIVE', 3, dd(0), 1, dd(7)),        // again → L1 (≤3) + requeue
    mkCard('gv_t4', 'delta wave', 'волна дельта', 'ACTIVE', 5, dd(0), 5, dd(2)),      // again → L2 (>3) + requeue
    mkCard('gv_t5', 'echo peak', 'пик эхо', 'ACTIVE', 6, dd(0), 6, dd(20)),           // easy → stays L6 (ceiling)
    mkCard('gv_t6', 'foxtrot dual', 'двойной фокстрот', 'ACTIVE', 1, dd(-1), 2, dd(-2)), // BOTH sides due
    mkCard('gv_t7', 'golf bank', 'банк гольф', 'BANK', 0, null, 0, null),             // BANK: never in review
  ];
  const craftedState = {
    schema_version: 2, saved_at: '2026-09-17T08:00:00.000Z',
    cards: craftedCards, history: {}, streak: { count: 0, last_date: null },
    custom_groups: [], deleted_ids: [],
  };

  let env2 = null;
  await runner.section('13. crafted state: exact grading arithmetic through the full session', async ({ t }) => {
    const preCheck = SRS.validateState(deepClone(craftedState), null, { today: T });
    t('crafted fixture passes SRS.validateState before injection', preCheck.ok === true, (preCheck.errors || []).join('; '));
    try {
      env2 = await boot({ state: craftedState, fixedDate: T, label: 'crafted' });
    } catch (e) {
      t('env2 boots with the crafted state', false, e.message);
      return;
    }
    t('env2 booted with no boot errors', env2.problems.length === 0, env2.problems.join('\n'));

    // dashboard sanity on the crafted state
    const live0 = env2.snapshotState().cards;
    const sum0 = SRS.summarize(deepClone(live0), T);
    let countsOk = true, detail = [];
    for (const b of BUCKETS) {
      const got = env2.document.getElementById(`kg-count-${b}`).textContent;
      if (got !== String(sum0.groups[b.toUpperCase()] || 0)) { countsOk = false; detail.push(`${b}=${got}≠${sum0.groups[b.toUpperCase()]}`); }
    }
    t(`dashboard groups match the kernel on the crafted state ${JSON.stringify(sum0.groups)}`, countsOk, detail.join('; '));

    // start the daily practice session
    env2.click('#btn-hero-start-practice');
    await env2.tick(40);
    const liveCards = env2.snapshotState().cards;
    const expectedQ = SRS.buildReviewQueue(deepClone(liveCards), T, { seed: T });
    const actualKeys = env2.evalJson(`JSON.stringify(currentTrainingQueue.map(i => i.key))`);
    console.log(`   ℹ️ crafted review queue (${expectedQ.length}): ${expectedQ.map((i) => i.key).join(', ')}`);
    t('crafted queue == SRS.buildReviewQueue (order included)',
      deepEqual(actualKeys, expectedQ.map((i) => i.key)), JSON.stringify(actualKeys));
    t('queue has 7 entries (t6 contributes BOTH directions)', expectedQ.length === 7, String(expectedQ.length));
    t('BANK card gv_t7 is NOT in the review queue', !actualKeys.some((k) => k.startsWith('gv_t7:')));
    t('both due directions of gv_t6 are queued', actualKeys.includes('gv_t6:en_ru') && actualKeys.includes('gv_t6:ru_en'));
    const idsQ = expectedQ.map((i) => i.cardId);
    let adjOk = true;
    for (let i = 1; i < idsQ.length; i++) if (idsQ[i] === idsQ[i - 1]) adjOk = false;
    t("gv_t6's two sides are never back-to-back", adjOk, idsQ.join(','));

    // walk the whole session to completion with a per-key answer plan
    const PLAN = {
      'gv_t1:en_ru': ['easy'],
      'gv_t2:en_ru': ['hard'],
      'gv_t3:en_ru': ['again', 'easy'],
      'gv_t4:en_ru': ['again', 'easy'],
      'gv_t5:en_ru': ['easy'],
      'gv_t6:en_ru': ['easy'],
      'gv_t6:ru_en': ['hard'],
    };
    const used = {};
    let grades = 0, guard = 0;
    while (env2.activeScreen() === 'screen-training' && guard++ < 30) {
      const item = await currentItem(env2);
      if (!item) break;
      const plan = PLAN[item.key];
      if (!plan) { t(`walk: unexpected queue item ${item.key}`, false, JSON.stringify(item)); break; }
      const n = used[item.key] || 0;
      used[item.key] = n + 1;
      const answer = plan[Math.min(n, plan.length - 1)];
      await gradeVia(env2, t, answer, () => env2.click(ANSWER_BTNS[answer]),
        `crafted[${item.key}${item.kind === 'requeue' ? '·requeue' : ''}] ${answer}`);
      grades++;
    }
    t('session graded every planned pair incl. both requeues (9 grades)', grades === 9, `grades=${grades} used=${JSON.stringify(used)}`);
    t('all 7 planned pairs were shown', Object.keys(used).length === 7, Object.keys(used).join(','));
    t('session completion returned to the dashboard', env2.activeScreen() === 'screen-dashboard', env2.activeScreen());
    t('completion toast shown', /Practice finished/i.test(env2.document.getElementById('toast-container').textContent));
    t('recordActivity stamped the streak with the fixed today',
      env2.evalIn(`appState.streak.last_date`) === T, env2.evalIn(`String(appState.streak.last_date)`));
    const p = env2.takeProblems();
    t('crafted walk produced no errors', p.length === 0, p.join('\n'));
  });

  await runner.section('14. learn mode: bank word enters with BOTH sides, activation works', async ({ t }) => {
    if (!env2) { t('env2 available', false, 'previous section failed to boot'); return; }
    env2.click('#btn-hero-start-learn');
    await env2.tick(40);
    t('learn session started on the training screen', env2.activeScreen() === 'screen-training', env2.activeScreen());
    const liveCards = env2.snapshotState().cards;
    const expected = SRS.buildLearnQueue(deepClone(liveCards), T, { seed: T, limit: SRS.DEFAULTS.learnBatchLimit });
    const actual = env2.evalJson(`JSON.stringify(currentTrainingQueue.map(i => i.key))`);
    t('learn queue == SRS.buildLearnQueue (only the bank word, both directions)',
      deepEqual(actual, expected.map((i) => i.key)), `${JSON.stringify(actual)} vs ${JSON.stringify(expected.map((i) => i.key))}`);
    t('learn queue = 2 items (gv_t7 en_ru + ru_en)', actual.length === 2 && actual.every((k) => k.startsWith('gv_t7:')), JSON.stringify(actual));

    const r1 = await gradeVia(env2, t, 'easy', () => env2.click(ANSWER_BTNS.easy), 'learn[en_ru] easy (activates bank word)');
    if (r1) {
      t('bank word is ACTIVE after the first answer', r1.live.status === 'ACTIVE', String(r1.live.status));
      t('L0 answer promotes to L1 with due = today + 1', r1.live.level_en_ru === 1 && r1.live.next_review_en_ru === dd(1),
        `L${r1.live.level_en_ru} due ${r1.live.next_review_en_ru}`);
    }
    await gradeVia(env2, t, 'easy', () => env2.click(ANSWER_BTNS.easy), 'learn[ru_en] easy');
    t('learn session finished → dashboard', env2.activeScreen() === 'screen-dashboard', env2.activeScreen());
    const t7 = env2.card('gv_t7');
    t('gv_t7 now ACTIVE L1/L1 with both dates = today+1',
      t7.status === 'ACTIVE' && t7.level_en_ru === 1 && t7.level_ru_en === 1
      && t7.next_review_en_ru === dd(1) && t7.next_review_ru_en === dd(1), stableStringify(t7, 300));
    const p = env2.takeProblems();
    t('learn section produced no errors', p.length === 0, p.join('\n'));
  });

  /* ═══════════════ ENV 3 — LEGACY MIGRATION ═══════════════ */

  await runner.section('15. legacy fixture (schema 1, BOM) migrates automatically at startup', async ({ t }) => {
    let env3 = null;
    try {
      env3 = await boot({ stateFixture: 'legacy-198', fixedDate: T, label: 'legacy-migration' });
    } catch (e) {
      t('legacy env boots (automatic migration path)', false, e.message);
      return;
    }
    const fixture = loadJson(path.join(__dirname, 'fixtures', 'legacy-198.json'));
    const state = env3.snapshotState();
    t('no card lost: 198 legacy cards survive the migration', state.cards.length === fixture.cards.length,
      `${fixture.cards.length} → ${state.cards.length}`);
    const fixIds = new Set(fixture.cards.map((c) => c.id));
    const liveIds = new Set(state.cards.map((c) => c.id));
    t('every legacy id present after migration', [...fixIds].every((id) => liveIds.has(id)));
    t('state upgraded to schema_version 2', Number(state.schema_version) === 2, String(state.schema_version));
    const report = env3.evalIn(`lastMigrationReport ? JSON.parse(JSON.stringify(lastMigrationReport)) : null`);
    console.log(`   ℹ️ migration report: migrated=${report && report.migrated} bySource=${report && JSON.stringify(report.bySource)} byGroup=${report && JSON.stringify(report.byGroup)} overdueCarried=${report && report.overdueCarried}`);
    // ── GENUINE APP BUG (read-only file — reported, not fixed, not weakened) ──
    // app.js loadData() normalizes EVERY candidate card with SRS.normalizeCard
    // DURING the merge (app.js ~line 262), so by the time migrateAppStateToSRS()
    // calls SRS.migrateState(appState, today) every legacy card is already
    // 'native' → report.migrated === 0 → firstMigration === false →
    // writePreMigrationSnapshot() (documented in app.js as "единственная точка
    // полного отката на старую модель коробок") NEVER runs and the upgrade
    // toast is never shown — while the schema-1 base IS irreversibly converted
    // and the very next saveData() overwrites both localStorage keys with
    // schema-2. Minimal repro: this section (boot on the legacy fixture).
    t('KNOWN-BLOCKER: legacy startup records report.migrated > 0 (cards converted by migrateState)',
      !!report && Number(report.migrated) > 0,
      report ? `migrated=${report.migrated}, bySource=${JSON.stringify(report.bySource)} — loadData pre-normalizes cards, so migrateState always sees 'native'` : 'no report');
    t('validator accepts the migrated state',
      env3.evalIn(`SRS.validateState(appState, null, { today: srsToday() }).ok`) === true);
    t('dead box-era fields stripped from every card',
      env3.evalIn(`appState.cards.filter(c => Object.prototype.hasOwnProperty.call(c, 'box') || Object.prototype.hasOwnProperty.call(c, 'srsStage') || Object.prototype.hasOwnProperty.call(c, 'next_review_date')).length`) === 0);
    t('every card has two numeric level vectors after migration',
      state.cards.every((c) => Number.isInteger(c.level_en_ru) && Number.isInteger(c.level_ru_en)
        && c.level_en_ru >= 0 && c.level_en_ru <= 6 && c.level_ru_en >= 0 && c.level_ru_en <= 6));
    t('save guard not tripped by migration', env3.evalIn(`saveBlockedReason`) === null, String(env3.evalIn(`saveBlockedReason`)));

    const backupRaw = env3.window.localStorage.getItem('leitner_data_pre_srs_backup');
    let backup = null;
    try { backup = JSON.parse(backupRaw); } catch (e) {}
    t('KNOWN-BLOCKER: pre-migration snapshot written (the documented ONLY rollback point to the box model; must keep the legacy box fields)',
      !!backup && Array.isArray(backup.cards) && backup.cards.length === 198 && backup.cards.some((c) => Object.prototype.hasOwnProperty.call(c, 'box')),
      `localStorage.leitner_data_pre_srs_backup = ${backupRaw === null ? 'null (never written: firstMigration===false because report.migrated===0)' : 'present but unexpected shape'}`);
    t('KNOWN-BLOCKER: user-visible upgrade toast shown on legacy startup',
      /upgraded|two independent scales/i.test(env3.document.getElementById('toast-container').textContent),
      `toast container: "${env3.document.getElementById('toast-container').textContent.slice(0, 120)}" — showToast(…'Your base was upgraded…') sits behind the same firstMigration flag`);

    const sum = SRS.summarize(deepClone(state.cards), T);
    console.log(`   ℹ️ migrated groups ${JSON.stringify(sum.groups)} · dueEntries ${sum.dueEntries} · queue ${env3.evalIn(`SRS.buildReviewQueue(appState.cards, srsToday(), { seed: sessionSeed }).length`)}`);
    let ok = true, det = [];
    for (const b of BUCKETS) {
      const got = env3.document.getElementById(`kg-count-${b}`).textContent;
      if (got !== String(sum.groups[b.toUpperCase()] || 0)) { ok = false; det.push(`${b}=${got}≠${sum.groups[b.toUpperCase()]}`); }
    }
    t('dashboard renders the MIGRATED state consistently with the kernel', ok, det.join('; '));
    t('#dash-due == migrated dueEntries', env3.document.getElementById('dash-due').textContent === String(sum.dueEntries));
    const p = env3.takeProblems();
    t('migration boot produced no uncaught errors / console.error', p.length === 0, p.join('\n'));
    env3.close();
  });

  /* ── teardown & summary ──────────────────────────────────────────────── */
  for (const e of envs) e.close();
  process.exit(runner.finish());
})().catch((e) => {
  console.error('\nFATAL: interact.cjs crashed —', (e && e.stack) || e);
  console.log(`\nFAIL 0/? — interact.cjs — fatal: ${e && e.message}`);
  process.exit(1);
});
