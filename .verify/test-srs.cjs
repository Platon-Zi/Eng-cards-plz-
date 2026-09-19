'use strict';
/* =============================================================================
   .verify/test-srs.cjs — unit-test suite for the srs.js spaced-repetition kernel
   -----------------------------------------------------------------------------
   Runner : node:test + node:assert/strict (built in, offline)
   Run    : node --test .verify/test-srs.cjs
            node --test ".verify/test-*.cjs"
            (cd .verify && node --test)
            NOTE: on Node v24.21.0 `node --test .verify/` executes the directory
            path itself as a module (MODULE_NOT_FOUND) instead of walking it —
            a runner quirk independent of this suite; use one of the forms above.
   Scope  : pins the product-owner business rules (1..19), the real-198 goldens
            from data/leitner_data.json (today='2026-09-17'), module purity and
            determinism. This file must NEVER modify srs.js or any other source.
   ========================================================================== */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('child_process');

const SRS = require('../srs.js');

const ROOT = path.resolve(__dirname, '..');
const SRS_PATH = path.join(ROOT, 'srs.js');
/* Живая база уже переведена на schema 2, поэтому золотые числа миграции берём из
   ЗАМОРОЖЕННОГО legacy-фикстура. Порядок поиска: фикстур → снапшот до миграции →
   живой файл (только если он ещё legacy). loadReal() отбрасывает schema-2 источник,
   чтобы migratedCount=0 молча не «проходил» как зеленые золотые числа. */
const LEGACY_CANDIDATES = [
  path.join(ROOT, '.verify', 'fixtures', 'legacy-198.json'),
  path.join(ROOT, 'data', 'leitner_data.pre-srs.json'),
  path.join(ROOT, 'data', 'leitner_data.json')
];
const LIVE_PATH = path.join(ROOT, 'data', 'leitner_data.json');
let DATA_PATH = LEGACY_CANDIDATES[0];
const TODAY = '2026-09-17';                       // fixed clock for every test

/* ------------------------------- helpers ---------------------------------- */

const J = (x) => JSON.parse(JSON.stringify(x));   // realm-proof deep normalize

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.getOwnPropertyNames(o).forEach((k) => deepFreeze(o[k]));
  }
  return o;
}

/* today + INTERVALS[level] for TODAY='2026-09-17' — hand-computed, pinned by
   the date tests independently (addDays/toEpochDays epoch-day math).          */
const DUE = {
  0: '2026-09-17', 1: '2026-09-18', 2: '2026-09-19', 3: '2026-09-21',
  4: '2026-09-24', 5: '2026-10-01', 6: '2026-10-17'
};

/* Independent re-implementation of owner rules 2+3 (the SPEC, not the code):
   🔴 again → level<=3 ? 1 : 2 ; 🟠 hard → freeze ; 🟢 easy → min(level+1,6)
   invariant A1: level 0 → ANY answer lands on 1.                             */
function expectedNextLevel(level, answer) {
  if (level === 0) return 1;                                    // A1
  if (answer === 'easy') return Math.min(level + 1, 6);
  if (answer === 'hard') return level;
  return level <= 3 ? 1 : 2;                                    // again
}

function changedKeys(before, after) {
  const keys = new Set(Object.keys(before).concat(Object.keys(after)));
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out.sort();
}

function mkCard(id, over) {                    // full-content ACTIVE v2 card
  return Object.assign({
    id: id, word: 'word-' + id, phonetic: '[fəˈnɛtɪk]',
    translation: 'перевод-' + id, example: 'example ' + id,
    example_translation: 'пример ' + id, part_of_speech: 'noun',
    partOfSpeech: 'noun', batch_id: 'batch-1', batch_name: 'Batch One',
    created_at: '2026-01-01', status: 'ACTIVE',
    level_en_ru: 2, level_ru_en: 2,
    next_review_en_ru: '2026-09-19', next_review_ru_en: '2026-09-19',
    fail_count: 0, review_count: 0
  }, over || {});
}

function mkBank(id, over) {
  return mkCard(id, Object.assign({
    status: 'BANK', level_en_ru: 0, level_ru_en: 0,
    next_review_en_ru: null, next_review_ru_en: null
  }, over || {}));
}

function qCard(id, status, en, ru, den, dru) {  // lean card for queue tests
  return { id: id, status: status, level_en_ru: en, level_ru_en: ru,
           next_review_en_ru: den, next_review_ru_en: dru,
           word: 'w' + id, translation: 't' + id };
}

const keysOf = (items) => items.map((it) => it.key);

/* Comment stripper for source-purity greps: string-aware; srs.js has exactly
   one regex literal (/^\d{4}-\d{2}-\d{2}$/) which contains no quotes, no '//'
   and no '/*', so copying a bare '/' verbatim is safe for this file.          */
function stripComments(src) {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const ch = src[i]; const nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (ch === '/' && nx === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch; out += ch; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
    } else { out += ch; i++; }
  }
  return out;
}

function enclosingFunctionName(code, idx) {
  const before = code.slice(0, idx);
  const fi = before.lastIndexOf('function');
  if (fi === -1) return '<top-level>';
  const paren = before.indexOf('(', fi);
  const name = before.slice(fi + 8, paren === -1 ? before.length : paren).trim();
  return name || '<anonymous>';
}

/* Real data, loaded once; null when no LEGACY source is available (goldens skip). */
let realCache;
function loadReal() {
  if (realCache !== undefined) return realCache;
  for (const candidate of LEGACY_CANDIDATES) {
    let raw;
    try { raw = fs.readFileSync(candidate, 'utf8'); } catch (e) { continue; }
    let state;
    try { state = JSON.parse(SRS.stripBom(raw)); } catch (e) { continue; }
    if (!state || !Array.isArray(state.cards)) continue;
    if (Number(state.schema_version) === SRS.SCHEMA_VERSION) continue;  // уже мигрирован
    DATA_PATH = candidate;
    realCache = { raw: raw, state: state };
    return realCache;
  }
  realCache = null;
  return realCache;
}

/** Живая база (schema 2) — отдельный источник для проверки уже выполненной миграции. */
let liveCache;
function loadLive() {
  if (liveCache !== undefined) return liveCache;
  try {
    const raw = fs.readFileSync(LIVE_PATH, 'utf8');
    const state = JSON.parse(SRS.stripBom(raw));
    liveCache = (state && Array.isArray(state.cards)) ? { raw: raw, state: state } : null;
  } catch (e) { liveCache = null; }
  return liveCache;
}
let realMigCache;
function realMigration() {
  const real = loadReal();
  if (!real) return null;
  if (!realMigCache) realMigCache = SRS.migrateState(real.state, TODAY);
  return realMigCache;
}

/* ========================================================================== */
/* 1. MODULE SURFACE & PURITY                                                  */
/* ========================================================================== */
describe('module surface & purity', () => {

  const API_NAMES = [
    'VERSION', 'SCHEMA_VERSION', 'SUPPORTED_SCHEMA_MAX',
    'INTERVALS', 'MAX_LEVEL', 'MIN_REST_LEVEL', 'KNOWLEDGE_GROUPS', 'BUCKETS',
    'GROUP_OF_LEVEL', 'LEVELS_OF_GROUP', 'GROUP_RANK', 'GROUP_META', 'STATUS',
    'DIRECTIONS', 'DIRECTION_META', 'DIRECTION_ALIASES', 'ANSWERS',
    'ANSWER_ORDER', 'ANSWER_META', 'RESET_TABLE', 'BOX_TO_LEVEL',
    'STAGE_TO_LEVEL', 'DEFAULTS', 'DEPRECATED_FIELDS', 'CARD_KEY_ORDER',
    'ROOT_KEY_ORDER',
    'posText', 'pluralRu', 'stripBom', 'pipString',
    'parseYMD', 'isDateStr', 'toEpochDays', 'fromEpochDays', 'addDays',
    'diffDays', 'todayString',
    'clampLevel', 'isValidLevel', 'groupForLevel', 'intervalForLevel',
    'levelsForGroup', 'groupRank',
    'normalizeDir', 'otherDir', 'levelKey', 'dueKey', 'directionLevel',
    'directionDueDate',
    'isBank', 'isActive', 'isDirectionDue', 'dueDirections', 'isDue',
    'derivedGroup', 'derivedRank', 'sessionKey',
    'activateCard', 'returnToBank', 'setCardStatus', 'setDirectionLevel',
    'normalizeAnswer', 'applyAnswer', 'answerBankCard', 'newCardSkeleton',
    'fnv1a', 'rngFromSeed', 'seededShuffle', 'spreadSameCard',
    'makeItem', 'compareItems', 'buildReviewQueue', 'buildLearnQueue',
    'buildCramQueue', 'buildSubsetQueue',
    'summarize', 'describeDirection', 'describeCard',
    'hasEvidence', 'normalizeCard', 'mergeRecords', 'migrateState',
    'assertNoCardLoss', 'validateCard', 'validateState', 'serializeState',
    'createSession', 'sessionCurrent', 'sessionRemaining', 'sessionAdvance',
    'sessionIsGraded', 'sessionMarkGraded', 'sessionRequeue', 'sessionSkip',
    'sessionEnsure', 'sessionStats'
  ];

  test('surface: exactly 96 documented API members, identity + globals', () => {
    const keys = Object.keys(SRS);
    assert.equal(keys.length, 96, 'surface: export count must stay 96 (got ' + keys.length + ') — audit API block');
    for (const name of API_NAMES) {
      assert.ok(name in SRS, 'surface: documented export missing — ' + name);
    }
    for (const k of keys) {
      assert.ok(API_NAMES.indexOf(k) !== -1, 'surface: undocumented export appeared — ' + k);
    }
    assert.equal(globalThis.SRS, SRS, 'surface: require must also install globalThis.SRS (browser parity)');
    assert.equal(SRS.VERSION, 'srs-v2', 'surface: VERSION pin');
    assert.equal(SRS.SCHEMA_VERSION, 2, 'surface: SCHEMA_VERSION must be 2');
    assert.equal(SRS.SUPPORTED_SCHEMA_MAX, 2, 'surface: SUPPORTED_SCHEMA_MAX must be 2');
  });

  test('surface: model constants match the product rules exactly', () => {
    assert.deepEqual(J(SRS.INTERVALS), [0, 1, 2, 4, 7, 14, 30], 'rule 1: INTERVALS=[0,1,2,4,7,14,30]');
    assert.equal(SRS.INTERVALS.length, 7, 'rule 1: INTERVALS must have 7 slots');
    assert.equal(SRS.MAX_LEVEL, 6, 'rule 1: MAX_LEVEL=6 (ceiling, no archive)');
    assert.equal(SRS.MIN_REST_LEVEL, 1, 'rule 3/A1: MIN_REST_LEVEL=1');
    assert.deepEqual(J(SRS.KNOWLEDGE_GROUPS), ['NEW', 'LEARNING', 'FAMILIAR', 'CONFIDENT', 'MASTERED'], 'KNOWLEDGE_GROUPS pin');
    assert.deepEqual(J(SRS.BUCKETS), ['BANK', 'NEW', 'LEARNING', 'FAMILIAR', 'CONFIDENT', 'MASTERED'], 'BUCKETS = BANK + KNOWLEDGE_GROUPS');
    assert.deepEqual(J(SRS.GROUP_OF_LEVEL),
      { 0: 'NEW', 1: 'LEARNING', 2: 'FAMILIAR', 3: 'FAMILIAR', 4: 'CONFIDENT', 5: 'CONFIDENT', 6: 'MASTERED' },
      'GROUP_OF_LEVEL pin');
    assert.deepEqual(J(SRS.GROUP_RANK),
      { BANK: -1, NEW: 0, LEARNING: 1, FAMILIAR: 2, CONFIDENT: 3, MASTERED: 4 }, 'GROUP_RANK pin');
    assert.deepEqual(J(SRS.STATUS), { BANK: 'BANK', ACTIVE: 'ACTIVE' }, 'STATUS pin');
    assert.deepEqual(J(SRS.DIRECTIONS), ['en_ru', 'ru_en'], 'DIRECTIONS pin');
    assert.deepEqual(J(SRS.ANSWERS), { AGAIN: 'again', HARD: 'hard', EASY: 'easy' }, 'rule 2: ANSWERS pin');
    assert.equal(Object.keys(SRS.ANSWERS).length, 3, 'ANSWERS must have exactly 3 members');
    assert.deepEqual(J(SRS.ANSWER_ORDER), ['again', 'hard', 'easy'], 'ANSWER_ORDER pin');
    assert.deepEqual(J(SRS.RESET_TABLE), { lowMaxLevel: 3, lowTo: 1, highTo: 2 }, 'rule 2: RESET_TABLE as data (≤3→1, >3→2)');
    assert.deepEqual(J(SRS.BOX_TO_LEVEL),
      { '0': 0, '1': 1, '2': 2, '3': 4, '4': 5, '5': 6, '6': 6, archive: 6, bank: 0 },
      'rule 11: BOX_TO_LEVEL interval-fidelity map (box3→L4=7d, box4→L5=14d, box5→L6=30d)');
    assert.deepEqual(J(SRS.STAGE_TO_LEVEL),
      { new: 0, learning: 1, review: 4, mastered: 6, bank: 0 }, 'STAGE_TO_LEVEL pin');
    assert.deepEqual(J(SRS.DEPRECATED_FIELDS), [
      'box', 'srsStage', 'interval', 'easeFactor', 'repetitions', 'dueDate',
      'eng_to_rus', 'rus_to_eng', 'last_tested', 'last_tested_eng', 'last_tested_rus',
      'next_review_date', 'knowledge_group', 'level', 'stage'
    ], 'rule 15: DEPRECATED_FIELDS list (15 dead fields)');
    assert.equal(SRS.ANSWER_META.again.ru, 'Забыл', 'rule 2: again label «Забыл»');
    assert.equal(SRS.ANSWER_META.again.icon, '🔴', 'rule 2: again icon 🔴');
    assert.equal(SRS.ANSWER_META.again.correct, false, 'again is not a correct answer');
    assert.equal(SRS.ANSWER_META.hard.ru, 'Сложно', 'rule 2: hard label «Сложно»');
    assert.equal(SRS.ANSWER_META.hard.icon, '🟠', 'rule 2: hard icon 🟠');
    assert.equal(SRS.ANSWER_META.easy.ru, 'Легко', 'rule 2: easy label «Легко»');
    assert.equal(SRS.ANSWER_META.easy.icon, '🟢', 'rule 2: easy icon 🟢');
    assert.deepEqual(J(SRS.DEFAULTS), {
      sameCardGap: 3, learnBatchLimit: 20, requeueDelay: 4, maxRepeatsPerSession: 1,
      reviewChunkSize: 30, maxOverdueDisplay: 365, shrinkThreshold: 0.8,
      penalizeArchive: false, duePolicy: 'stagger'
    }, 'rule 8/12/18/19: DEFAULTS pin');
  });

  test('surface: every exported constant container is deep-frozen', () => {
    const frozen = ['INTERVALS', 'KNOWLEDGE_GROUPS', 'BUCKETS', 'GROUP_OF_LEVEL',
      'LEVELS_OF_GROUP', 'GROUP_RANK', 'GROUP_META', 'STATUS', 'DIRECTIONS',
      'DIRECTION_META', 'DIRECTION_ALIASES', 'ANSWERS', 'ANSWER_ORDER',
      'ANSWER_META', 'RESET_TABLE', 'BOX_TO_LEVEL', 'STAGE_TO_LEVEL',
      'DEFAULTS', 'DEPRECATED_FIELDS', 'CARD_KEY_ORDER', 'ROOT_KEY_ORDER'];
    for (const name of frozen) {
      assert.ok(Object.isFrozen(SRS[name]), 'purity: SRS.' + name + ' must be frozen');
    }
    assert.ok(Object.isFrozen(SRS.GROUP_META.BANK), 'purity: GROUP_META.BANK deep-frozen');
    assert.ok(Object.isFrozen(SRS.ANSWER_META.easy), 'purity: ANSWER_META.easy deep-frozen');
    assert.ok(Object.isFrozen(SRS.DIRECTION_META.en_ru), 'purity: DIRECTION_META.en_ru deep-frozen');
    assert.ok(Object.isFrozen(SRS.LEVELS_OF_GROUP.FAMILIAR), 'purity: LEVELS_OF_GROUP.FAMILIAR deep-frozen');
    assert.throws(() => { 'use strict'; SRS.INTERVALS[0] = 99; }, TypeError, 'purity: INTERVALS must reject writes');
    assert.equal(SRS.INTERVALS[0], 0, 'purity: INTERVALS[0] still 0 after write attempt');
  });

  test('purity: srs.js code contains no clock/DOM/network/random/require access', () => {
    const rawSrc = fs.readFileSync(SRS_PATH, 'utf8');
    const code = stripComments(rawSrc);
    // sanity: the stripper kept the code and dropped comment prose
    assert.ok(code.includes('function applyAnswer'), 'purity: comment stripper must preserve code');
    assert.ok(!code.includes('КОНТРАКТ ЧИСТОТЫ'), 'purity: comment stripper must drop comments');
    // tokens are assembled so this test file itself never contains them verbatim
    const FORBIDDEN = [
      ['Math' + '.' + 'random', 'non-deterministic RNG'],
      ['local' + 'Storage', 'DOM storage access'],
      ['document' + '.', 'DOM access'],
      ['fetch' + '(', 'network access'],
      ['require' + '(', 'module loading'],
      ['Date' + '.' + 'now(', 'hidden clock read'],
      ['Date' + '.' + 'now()', 'hidden clock read']
    ];
    for (const pair of FORBIDDEN) {
      assert.ok(!code.includes(pair[0]),
        'purity: srs.js code must not contain ' + pair[0] + ' (' + pair[1] + ')');
    }
  });

  test('purity: new Date( appears only inside the allowed time functions', () => {
    const code = stripComments(fs.readFileSync(SRS_PATH, 'utf8'));
    // utcDate допущен намеренно: он строит ФИКСИРОВАННУЮ дату (Date.UTC(2001,0,1))
    // и лишь подставляет в неё год через setUTCFullYear — часов он не читает. Нужен,
    // потому что Date.UTC(y,…) отображает годы 0..99 в 1900+y и ломал parseYMD.
    const ALLOWED = ['todayString', 'parseYMD', 'toEpochDays', 'fromEpochDays', 'utcDate'];
    const found = [];
    let idx = -1;
    const needle = 'new Date' + '(';
    while ((idx = code.indexOf(needle, idx + 1)) !== -1) {
      const fn = enclosingFunctionName(code, idx);
      assert.ok(ALLOWED.indexOf(fn) !== -1,
        'purity: `new Date(` found inside ' + fn + ' — only ' + ALLOWED.join('/') + ' may read the clock');
      found.push(fn);
    }
    assert.ok(found.length >= 1, 'purity: scanner sanity — at least one `new Date(` expected');
    assert.ok(found.indexOf('todayString') !== -1, 'purity: todayString must be the injectable clock reader');
  });

  test('purity: root package.json has no "type":"module" (srs.js must stay CJS-requireable)', () => {
    const pkg = require('../package.json');
    assert.notEqual(pkg.type, 'module', 'purity: root package.json must not declare type:module');
    const rawPkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    assert.ok(!/"type"\s*:\s*"module"/.test(rawPkg), 'purity: raw package.json text must not contain "type":"module"');
  });
});

/* ========================================================================== */
/* 2. UTILITIES                                                                */
/* ========================================================================== */
describe('utils', () => {

  test('utils: posText joins arrays, passes strings, empties nullish', () => {
    assert.equal(SRS.posText(['noun', 'verb']), 'noun / verb', 'posText: array joins with " / "');
    assert.equal(SRS.posText(['a', 'b'], ' + '), 'a + b', 'posText: custom separator');
    assert.equal(SRS.posText('noun'), 'noun', 'posText: string passthrough');
    assert.equal(SRS.posText(null), '', 'posText: null → empty string');
    assert.equal(SRS.posText(undefined), '', 'posText: undefined → empty string');
    assert.equal(SRS.posText(['x', '', null, 'y']), 'x / y', 'posText: empty members filtered');
    assert.equal(SRS.posText(42), '42', 'posText: number stringified');
  });

  test('utils: pluralRu follows Russian plural rules', () => {
    const p = (n) => SRS.pluralRu(n, 'день', 'дня', 'дней');
    assert.equal(p(1), 'день', 'pluralRu: 1 день');
    assert.equal(p(2), 'дня', 'pluralRu: 2 дня');
    assert.equal(p(4), 'дня', 'pluralRu: 4 дня');
    assert.equal(p(5), 'дней', 'pluralRu: 5 дней');
    assert.equal(p(11), 'дней', 'pluralRu: 11 дней');
    assert.equal(p(14), 'дней', 'pluralRu: 14 дней');
    assert.equal(p(21), 'день', 'pluralRu: 21 день');
    assert.equal(p(22), 'дня', 'pluralRu: 22 дня');
    assert.equal(p(101), 'день', 'pluralRu: 101 день');
    assert.equal(p(111), 'дней', 'pluralRu: 111 дней');
    assert.equal(p(112), 'дней', 'pluralRu: 112 дней (teens block)');
    assert.equal(p(0), 'дней', 'pluralRu: 0 дней');
    assert.equal(p(-1), 'день', 'pluralRu: negative uses absolute value');
  });

  test('utils: stripBom removes only a leading U+FEFF, passes non-strings', () => {
    assert.equal(SRS.stripBom('\uFEFF{"a":1}'), '{"a":1}', 'stripBom: leading BOM removed');
    assert.equal(SRS.stripBom('abc'), 'abc', 'stripBom: no-op without BOM');
    assert.equal(SRS.stripBom('a\uFEFFb'), 'a\uFEFFb', 'stripBom: inner BOM untouched');
    assert.equal(SRS.stripBom(42), 42, 'stripBom: non-string passthrough');
    assert.equal(SRS.stripBom('\uFEFF'), '', 'stripBom: lone BOM → empty string');
  });

  test('utils: pipString renders 7 pips with clamping', () => {
    assert.equal(SRS.pipString(0), '●○○○○○○', 'pipString: L0');
    assert.equal(SRS.pipString(3), '●●●●○○○', 'pipString: L3');
    assert.equal(SRS.pipString(6), '●●●●●●●', 'pipString: L6 full');
    assert.equal(SRS.pipString(9), '●●●●●●●', 'pipString: clamps above MAX_LEVEL');
    assert.equal(SRS.pipString(-2), '●○○○○○○', 'pipString: clamps below 0');
    assert.equal(SRS.pipString('x'), '●○○○○○○', 'pipString: junk → level 0');
    assert.equal(SRS.pipString(2).length, 7, 'pipString: always 7 characters');
  });
});

/* ========================================================================== */
/* 3. DATES (rule 17)                                                          */
/* ========================================================================== */
describe('dates', () => {

  test('dates: parseYMD accepts strict real calendar dates only', () => {
    assert.deepEqual(J(SRS.parseYMD('2026-09-17')), { y: 2026, m: 9, d: 17 }, 'parseYMD: valid date');
    assert.deepEqual(J(SRS.parseYMD('2024-02-29')), { y: 2024, m: 2, d: 29 }, 'parseYMD: leap day 2024 valid');
    assert.deepEqual(J(SRS.parseYMD('2400-02-29')), { y: 2400, m: 2, d: 29 }, 'parseYMD: 2400 divisible by 400 → leap');
    assert.deepEqual(J(SRS.parseYMD('2000-02-29')), { y: 2000, m: 2, d: 29 }, 'parseYMD: 2000 leap');
    assert.deepEqual(J(SRS.parseYMD('9999-12-31')), { y: 9999, m: 12, d: 31 }, 'parseYMD: year 9999 valid');
    const bad = [
      ['', 'empty string'], [null, 'null'], [undefined, 'undefined'],
      ['2026-9-7', 'no zero padding'], ['2026-02-30', 'Feb 30 never exists'],
      ['2023-02-29', '2023 is not a leap year'], ['2100-02-29', '2100 divisible by 100 not 400 → not leap'],
      ['2026-02-29', '2026 not leap'], ['2026-04-31', 'April has 30 days'],
      ['09/17/2026', 'US format'], ['2026-09-17T00:00:00Z', 'ISO timestamp'],
      [20260917, 'number'], ['2026-13-01', 'month 13'], ['2026-00-10', 'month 0'],
      ['2026-01-00', 'day 0'], ['0000-01-01', 'year 0 rejected'], [{}, 'object'],
      ['26-09-17', 'short year'], ['2026-09-17 ', 'trailing space']
    ];
    for (const pair of bad) {
      assert.equal(SRS.parseYMD(pair[0]), null, 'rule 17: parseYMD(' + JSON.stringify(pair[0]) + ') must be null — ' + pair[1]);
    }
    assert.equal(SRS.isDateStr('2026-09-17'), true, 'isDateStr: valid');
    assert.equal(SRS.isDateStr('2026-02-30'), false, 'isDateStr: impossible calendar day');
    assert.equal(SRS.isDateStr(20260917), false, 'isDateStr: non-string');
  });

  test('dates: addDays is integer epoch-day math across every boundary', () => {
    assert.equal(SRS.addDays('2026-09-17', 0), '2026-09-17', 'addDays: +0 identity');
    assert.equal(SRS.addDays('2026-12-31', 1), '2027-01-01', 'addDays: Dec 31 → Jan 1 year rollover');
    assert.equal(SRS.addDays('2026-01-31', 30), '2026-03-02', 'addDays: month-end +30 crosses February');
    assert.equal(SRS.addDays('2026-03-07', 1), '2026-03-08', 'addDays: into US DST switch day');
    assert.equal(SRS.addDays('2026-03-08', 30), '2026-04-07', 'addDays: US DST 2026-03-08 +30 (23h day cannot shift the date)');
    assert.equal(SRS.addDays('2026-10-24', 1), '2026-10-25', 'addDays: into EU DST switch day');
    assert.equal(SRS.addDays('2026-10-25', 30), '2026-11-24', 'addDays: EU DST 2026-10-25 +30 (25h day cannot shift the date)');
    assert.equal(SRS.addDays('2024-02-28', 1), '2024-02-29', 'addDays: leap-day entry');
    assert.equal(SRS.addDays('2024-02-28', 2), '2024-03-01', 'addDays: leap-day skip');
    assert.equal(SRS.addDays('2026-02-28', 1), '2026-03-01', 'addDays: common-year February');
    assert.equal(SRS.addDays('2026-03-01', -1), '2026-02-28', 'addDays: negative common year');
    assert.equal(SRS.addDays('2024-03-01', -1), '2024-02-29', 'addDays: negative into leap day');
    assert.equal(SRS.addDays('2026-09-17', 30), '2026-10-17', 'addDays: L6 interval from golden today');
    assert.throws(() => SRS.addDays('2026-02-30', 1), TypeError, 'addDays: impossible date must throw TypeError');
    assert.throws(() => SRS.addDays(null, 1), TypeError, 'addDays: null date must throw TypeError');
    assert.throws(() => SRS.addDays('nope', 1), TypeError, 'addDays: junk date must throw TypeError');
    assert.throws(() => SRS.addDays('2026-09-17', 'x'), TypeError, 'addDays: non-numeric days must throw TypeError');
    assert.throws(() => SRS.addDays('2026-09-17', NaN), TypeError, 'addDays: NaN days must throw TypeError');
    assert.throws(() => SRS.addDays('2026-09-17', undefined), TypeError, 'addDays: undefined days must throw TypeError');
  });

  test('dates: diffDays sign, zero and null-on-garbage', () => {
    assert.equal(SRS.diffDays('2026-09-18', '2026-09-17'), 1, 'diffDays: tomorrow − today = +1');
    assert.equal(SRS.diffDays('2026-09-17', '2026-09-18'), -1, 'diffDays: today − tomorrow = −1');
    assert.equal(SRS.diffDays('2026-09-17', '2026-09-17'), 0, 'diffDays: same day = 0');
    assert.equal(SRS.diffDays('2026-09-17', '2026-08-26'), 22, 'diffDays: across month boundary');
    assert.equal(SRS.diffDays('2026-03-01', '2026-02-28'), 1, 'diffDays: common-year Feb span');
    assert.equal(SRS.diffDays('2024-03-01', '2024-02-28'), 2, 'diffDays: leap-year Feb span = 2');
    assert.equal(SRS.diffDays('garbage', '2026-09-17'), null, 'diffDays: garbage a → null');
    assert.equal(SRS.diffDays('2026-09-17', null), null, 'diffDays: garbage b → null');
  });

  test('dates: toEpochDays/fromEpochDays round-trip over ±200 years, every day', () => {
    assert.equal(SRS.toEpochDays('1970-01-01'), 0, 'epoch: unix epoch = day 0');
    assert.equal(SRS.fromEpochDays(0), '1970-01-01', 'epoch: day 0 = unix epoch');
    assert.equal(SRS.toEpochDays('2026-09-17'), 20713, 'epoch: golden today = day 20713');
    assert.equal(SRS.toEpochDays('nope'), null, 'epoch: garbage → null');
    assert.equal(SRS.fromEpochDays(NaN), null, 'epoch: NaN → null');
    assert.equal(SRS.fromEpochDays('5'), null, 'epoch: non-number → null');
    const n0 = SRS.toEpochDays('1826-01-01');
    const n1 = SRS.toEpochDays('2226-01-01');
    assert.ok(n1 - n0 > 146000, 'epoch: span must cover ~400 years');
    for (let n = n0; n <= n1; n++) {
      const s = SRS.fromEpochDays(n);
      assert.equal(SRS.toEpochDays(s), n, 'epoch round-trip broke at day ' + n + ' → ' + s);
      assert.equal(SRS.addDays(s, 1), SRS.fromEpochDays(n + 1), 'addDays(+1) must equal next epoch day at ' + s);
    }
  });

  test('dates: seeded fuzz — diffDays(addDays(d,n),d)===n for 500 random (d,n)', () => {
    const rnd = SRS.rngFromSeed(20260917);
    const base = SRS.toEpochDays('1950-01-01');
    for (let i = 0; i < 500; i++) {
      const n = base + Math.floor(rnd() * 109500);            // ~300 years of days
      const d = SRS.fromEpochDays(n);
      const k = Math.floor(rnd() * 4001) - 2000;              // ±2000 days
      assert.equal(SRS.diffDays(SRS.addDays(d, k), d), k, 'fuzz #' + i + ': d=' + d + ' k=' + k);
      assert.equal(SRS.addDays(d, k), SRS.fromEpochDays(n + k), 'fuzz #' + i + ': addDays must equal epoch shift d=' + d + ' k=' + k);
      assert.equal(SRS.diffDays(d, SRS.addDays(d, k)), 0 - k, 'fuzz #' + i + ': diffDays antisymmetry d=' + d + ' k=' + k); // 0-k avoids -0 vs 0 under Object.is
    }
  });

  test('dates: todayString is fully injectable (now + timeZone)', () => {
    assert.equal(SRS.todayString(new Date('2026-09-17T16:00:00Z'), 'UTC'), '2026-09-17', 'todayString: UTC injection');
    assert.equal(SRS.todayString(new Date('2026-09-17T16:00:00Z'), 'Asia/Tokyo'), '2026-09-18', 'todayString: Tokyo (+9) rolls to next day');
    assert.equal(SRS.todayString(new Date('2026-09-17T16:00:00Z'), 'America/New_York'), '2026-09-17', 'todayString: New York stays on the 17th');
    assert.equal(SRS.todayString(new Date('2026-01-01T00:30:00Z'), 'UTC'), '2026-01-01', 'todayString: just past UTC midnight');
    assert.equal(SRS.todayString(new Date('2025-12-31T23:59:59Z'), 'UTC'), '2025-12-31', 'todayString: just before UTC midnight');
    assert.ok(SRS.isDateStr(SRS.todayString()), 'todayString: no-arg call must return a valid Y-M-D string');
    assert.ok(SRS.isDateStr(SRS.todayString('garbage')), 'todayString: invalid now falls back to a real date');
    assert.ok(SRS.isDateStr(SRS.todayString(new Date('nope'))), 'todayString: Invalid Date falls back to a real date');
  });

  test('dates: FIXED-KERNEL-BUG — years <1000 round-trip through fromEpochDays/toEpochDays (zero-padded year + no Date.UTC 2-digit mapping)', () => {
    /* Регрессия на исправленный баг ядра (edge-домен, практического влияния на данные
       карточек не имел, но нарушал rule 17: «даты — строго YYYY-MM-DD» + «целочисленная
       эпоха-дневная арифметика»). Было:
         SRS.fromEpochDays(-354286)                    → '999-12-31'  ← год без дополнения нулём
         SRS.toEpochDays(SRS.fromEpochDays(-354286))   → null         ← round-trip рвался
         SRS.parseYMD('0001-01-01')                    → null         ← честная дата отвергалась
       Причина: parseYMD строил `new Date(Date.UTC(y, m-1, d))`, а JS отображает годы
       0..99 в 1900+y, из-за чего сверка getUTCFullYear() не сходилась; fromEpochDays
       склеивал getUTCFullYear() без дополнения до четырёх цифр.
       Исправление: хелпер utcDate() задаёт год через setUTCFullYear, fromEpochDays
       печатает год через pad4().  */
    assert.deepEqual(J(SRS.parseYMD('0001-01-01')), { y: 1, m: 1, d: 1 },
      'FIXED: 0001-01-01 matches the strict regex and is a real calendar date — parseYMD must accept it');
    assert.equal(SRS.fromEpochDays(-719162), '0001-01-01',
      'FIXED: fromEpochDays must zero-pad the year to YYYY');
    const n999 = SRS.toEpochDays('0999-12-31');
    assert.equal(n999, -354286, 'FIXED: toEpochDays(0999-12-31) keeps its epoch-day value');
    assert.equal(SRS.fromEpochDays(n999), '0999-12-31',
      'FIXED: year 999 round-trips (fromEpochDays must not drop the leading zero)');
    assert.equal(SRS.toEpochDays(SRS.fromEpochDays(n999)), n999,
      'FIXED: toEpochDays∘fromEpochDays identity for year 999');
    // Календарная строгость после правки не ослабла:
    assert.equal(SRS.parseYMD('2026-02-30'), null, 'FIXED: month overflow still rejected');
    assert.equal(SRS.parseYMD('2100-02-29'), null, 'FIXED: non-leap century year still rejected');
    assert.ok(SRS.parseYMD('2400-02-29'), 'FIXED: leap century year still accepted');
  });

  test('dates: identical results under any host TZ (child processes, rule 17)', () => {
    const script = [
      'const SRS = require(' + JSON.stringify(SRS_PATH) + ');',
      'process.stdout.write([',
      "  SRS.addDays('2026-03-07', 1), SRS.addDays('2026-03-08', 30),",
      "  SRS.addDays('2026-10-24', 1), SRS.addDays('2026-10-25', 30),",
      "  SRS.addDays('2024-02-28', 2), String(SRS.diffDays('2026-09-17','2026-08-26')),",
      "  String(SRS.toEpochDays('2026-09-17')), SRS.fromEpochDays(0),",
      "  SRS.todayString(new Date('2026-09-17T16:00:00Z'), 'UTC')",
      "].join('|'));"
    ].join('\n');
    const expected = '2026-03-08|2026-04-07|2026-10-25|2026-11-24|2024-03-01|22|20713|1970-01-01|2026-09-17';
    const tzs = ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Jerusalem', 'Asia/Kolkata'];
    for (const tz of tzs) {
      const out = execFileSync(process.execPath, ['-e', script], {
        env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8'
      });
      assert.equal(out, expected, 'rule 17: TZ=' + tz + ' must not change epoch-day date math');
    }
  });
});

/* ========================================================================== */
/* 4. LEVELS & GROUPS                                                          */
/* ========================================================================== */
describe('levels & groups', () => {

  test('levels: clampLevel/isValidLevel semantics', () => {
    assert.equal(SRS.clampLevel(3), 3, 'clampLevel: in-range passthrough');
    assert.equal(SRS.clampLevel('3'), 3, 'clampLevel: numeric string');
    assert.equal(SRS.clampLevel(7), 6, 'clampLevel: above MAX_LEVEL clamps to 6');
    assert.equal(SRS.clampLevel(-2), 0, 'clampLevel: negative clamps to 0');
    assert.equal(SRS.clampLevel(2.5), 3, 'clampLevel: rounds half up');
    assert.equal(SRS.clampLevel(NaN), 0, 'clampLevel: NaN → 0');
    assert.equal(SRS.clampLevel(undefined), 0, 'clampLevel: undefined → 0');
    assert.equal(SRS.clampLevel('x'), 0, 'clampLevel: junk string → 0');
    assert.equal(SRS.clampLevel(null), 0, 'clampLevel: null → 0');
    for (let i = 0; i <= 6; i++) assert.equal(SRS.isValidLevel(i), true, 'isValidLevel: ' + i + ' valid');
    for (const v of [7, -1, 1.5, '3', null, undefined, NaN, {}]) {
      assert.equal(SRS.isValidLevel(v), false, 'isValidLevel: ' + JSON.stringify(v) + ' invalid');
    }
  });

  test('levels: groupForLevel/intervalForLevel/groupRank/levelsForGroup consistency', () => {
    const groups = ['NEW', 'LEARNING', 'FAMILIAR', 'FAMILIAR', 'CONFIDENT', 'CONFIDENT', 'MASTERED'];
    const ivs = [0, 1, 2, 4, 7, 14, 30];
    for (let L = 0; L <= 6; L++) {
      assert.equal(SRS.groupForLevel(L), groups[L], 'rule 1: groupForLevel(' + L + ')');
      assert.equal(SRS.intervalForLevel(L), ivs[L], 'rule 1: level ' + L + ' ⇒ interval ' + ivs[L] + ' days');
      assert.ok(SRS.levelsForGroup(groups[L]).indexOf(L) !== -1, 'LEVELS_OF_GROUP must contain level ' + L);
    }
    assert.equal(SRS.intervalForLevel(99), 30, 'intervalForLevel clamps above ceiling to 30 (rule 1: no archive)');
    assert.equal(SRS.groupForLevel(-5), 'NEW', 'groupForLevel clamps below 0 to NEW');
    assert.deepEqual(J(SRS.levelsForGroup('FAMILIAR')), [2, 3], 'levelsForGroup FAMILIAR = [2,3]');
    const copy = SRS.levelsForGroup('FAMILIAR');
    copy.push(99);
    assert.deepEqual(J(SRS.LEVELS_OF_GROUP.FAMILIAR), [2, 3], 'levelsForGroup must return a copy, not the frozen original');
    assert.equal(SRS.levelsForGroup('NOPE'), null, 'levelsForGroup: unknown group → null');
    assert.equal(SRS.groupRank('BANK'), -1, 'groupRank BANK = -1');
    assert.equal(SRS.groupRank('MASTERED'), 4, 'groupRank MASTERED = 4');
    assert.equal(SRS.groupRank('NOPE'), 99, 'groupRank: unknown group sinks to 99');
  });
});

/* ========================================================================== */
/* 5. DIRECTIONS & PREDICATES                                                  */
/* ========================================================================== */
describe('directions & predicates', () => {

  test('directions: normalizeDir folds every historical alias to canon', () => {
    const toEn = ['en_ru', 'en-ru', 'en-rus', 'eng-rus', 'ENG-RUS', 'eng2rus', 'eng_rus', 'en', 'eng', 'forward', 'EN_RU', ' en_ru', 'EN_RU '];
    const toRu = ['ru_en', 'ru-en', 'ru-eng', 'rus-eng', 'RUS-ENG', 'rus2eng', 'rus_eng', 'ru', 'rus', 'reverse', 'RU_EN'];
    for (const a of toEn) assert.equal(SRS.normalizeDir(a), 'en_ru', 'normalizeDir(' + JSON.stringify(a) + ') must be en_ru');
    for (const a of toRu) assert.equal(SRS.normalizeDir(a), 'ru_en', 'normalizeDir(' + JSON.stringify(a) + ') must be ru_en');
    for (const bad of ['both', '7', '', 'enru', 'sideways', null, undefined, 7, NaN, true, {}, []]) {
      assert.throws(() => SRS.normalizeDir(bad), TypeError, 'normalizeDir(' + JSON.stringify(bad) + ') must throw TypeError');
    }
  });

  test('directions: otherDir/levelKey/dueKey/sessionKey use canonical suffixes', () => {
    assert.equal(SRS.otherDir('en_ru'), 'ru_en', 'otherDir(en_ru) = ru_en');
    assert.equal(SRS.otherDir('ru_en'), 'en_ru', 'otherDir(ru_en) = en_ru');
    assert.equal(SRS.otherDir('eng-rus'), 'ru_en', 'otherDir accepts aliases');
    assert.equal(SRS.levelKey('en_ru'), 'level_en_ru', 'levelKey en_ru');
    assert.equal(SRS.levelKey('rus-eng'), 'level_ru_en', 'levelKey alias → level_ru_en');
    assert.equal(SRS.dueKey('en_ru'), 'next_review_en_ru', 'dueKey en_ru');
    assert.equal(SRS.dueKey('RUS-ENG'), 'next_review_ru_en', 'dueKey alias → next_review_ru_en');
    assert.equal(SRS.sessionKey('card1', 'eng-rus'), 'card1:en_ru', 'rule 10: sessionKey = cardId:dir with alias normalization');
    assert.equal(SRS.DIRECTION_META.en_ru.ui, 'eng-rus', 'DIRECTION_META ui token en_ru');
    assert.equal(SRS.DIRECTION_META.ru_en.ui, 'rus-eng', 'DIRECTION_META ui token ru_en');
  });

  test('directions: directionLevel/directionDueDate tolerate junk', () => {
    const c = { level_en_ru: '4', level_ru_en: 'x', next_review_en_ru: '2026-09-20', next_review_ru_en: 'garbage' };
    assert.equal(SRS.directionLevel(c, 'en_ru'), 4, 'directionLevel: numeric string clamps to 4');
    assert.equal(SRS.directionLevel(c, 'ru_en'), 0, 'directionLevel: junk → 0');
    assert.equal(SRS.directionLevel(null, 'en_ru'), 0, 'directionLevel: null card → 0');
    assert.equal(SRS.directionDueDate(c, 'en_ru'), '2026-09-20', 'directionDueDate: valid string');
    assert.equal(SRS.directionDueDate(c, 'ru_en'), null, 'directionDueDate: unparseable → null');
    assert.equal(SRS.directionDueDate(c, 'en_ru'), '2026-09-20', 'directionDueDate: stable');
  });

  test('predicates: isBank/isActive null-safety and status semantics', () => {
    assert.equal(SRS.isBank(mkBank('b')), true, 'isBank: BANK card');
    assert.equal(SRS.isBank(mkCard('a')), false, 'isBank: ACTIVE card');
    assert.equal(SRS.isBank(null), true, 'isBank: null treated as bank (fail-safe)');
    assert.equal(SRS.isBank(undefined), true, 'isBank: undefined treated as bank');
    assert.equal(SRS.isActive(mkCard('a')), true, 'isActive: ACTIVE card');
    assert.equal(SRS.isActive(mkBank('b')), false, 'isActive: BANK card');
    assert.equal(SRS.isActive(null), false, 'isActive: null → false');
    assert.equal(SRS.isActive({ status: 'WEIRD' }), false, 'isActive: unknown status → false');
  });

  test('predicates: isDirectionDue boundary + fail-open + bank blindness (rule 6)', () => {
    const c = qCard('c', 'ACTIVE', 2, 2, '2026-09-17', '2026-09-18');
    assert.equal(SRS.isDirectionDue(c, 'en_ru', TODAY), true, 'due exactly today → true');
    assert.equal(SRS.isDirectionDue(c, 'ru_en', TODAY), false, 'due tomorrow → false');
    const past = qCard('p', 'ACTIVE', 2, 2, '2026-09-16', '2026-08-01');
    assert.equal(SRS.isDirectionDue(past, 'en_ru', TODAY), true, 'due yesterday → true');
    assert.equal(SRS.isDirectionDue(past, 'ru_en', TODAY), true, 'deeply overdue → true');
    const nul = qCard('n', 'ACTIVE', 2, 2, null, '2026-09-16');
    assert.equal(SRS.isDirectionDue(nul, 'en_ru', TODAY), true, 'null date on ACTIVE → fail-open due');
    const junk = qCard('j', 'ACTIVE', 2, 2, 'garbage', '2026-12-01');
    assert.equal(SRS.isDirectionDue(junk, 'en_ru', TODAY), true, 'unparseable date → fail-open due');
    assert.equal(SRS.isDirectionDue(junk, 'ru_en', TODAY), false, 'valid future date → not due');
    const bank = qCard('b', 'BANK', 0, 0, '2026-09-01', '2026-09-01');
    assert.equal(SRS.isDirectionDue(bank, 'en_ru', TODAY), false, 'rule 6: BANK never due even with overdue dates');
    assert.equal(SRS.isDirectionDue(null, 'en_ru', TODAY), false, 'null card → not due');
  });

  test('predicates: dueDirections/isDue/derivedGroup weakest link', () => {
    const both = qCard('x', 'ACTIVE', 2, 2, '2026-09-01', '2026-09-17');
    assert.deepEqual(J(SRS.dueDirections(both, TODAY)), ['en_ru', 'ru_en'], 'dueDirections: both due');
    const one = qCard('y', 'ACTIVE', 2, 2, '2026-12-01', '2026-09-17');
    assert.deepEqual(J(SRS.dueDirections(one, TODAY)), ['ru_en'], 'dueDirections: only ru_en due');
    const none = qCard('z', 'ACTIVE', 2, 2, '2026-12-01', '2026-12-01');
    assert.deepEqual(J(SRS.dueDirections(none, TODAY)), [], 'dueDirections: nothing due');
    const nul = qCard('n', 'ACTIVE', 2, 2, null, null);
    assert.deepEqual(J(SRS.dueDirections(nul, TODAY)), ['en_ru', 'ru_en'], 'dueDirections: null dates fail-open both');
    assert.equal(SRS.isDue(one, TODAY), true, 'isDue: one direction due');
    assert.equal(SRS.isDue(none, TODAY), false, 'isDue: nothing due');
    assert.equal(SRS.isDue(mkBank('b', { next_review_en_ru: '2026-09-01', next_review_ru_en: '2026-09-01' }), TODAY), false, 'rule 6: BANK isDue=false regardless of dates');
    const mixed = qCard('m', 'ACTIVE', 5, 2, '2026-12-01', '2026-12-01');
    assert.equal(SRS.derivedGroup(mixed), 'FAMILIAR', 'derivedGroup: weakest direction (L2) decides, not L5');
    assert.equal(SRS.derivedGroup(qCard('m6', 'ACTIVE', 6, 6, null, null)), 'MASTERED', 'derivedGroup: 6/6 → MASTERED');
    assert.equal(SRS.derivedGroup(qCard('m0', 'ACTIVE', 0, 4, null, null)), 'NEW', 'derivedGroup: L0 side → NEW');
    assert.equal(SRS.derivedGroup(mkBank('b')), 'BANK', 'derivedGroup: BANK card → BANK bucket');
    assert.equal(SRS.derivedRank(mixed), 2, 'derivedRank: FAMILIAR rank 2');
    assert.equal(SRS.derivedRank(mkBank('b')), -1, 'derivedRank: BANK rank -1');
  });
});

/* ========================================================================== */
/* 6. ANSWERS — THE FULL 7×2×3 MATRIX (rules 2,3,4,5 + invariants A1,A2,A8)    */
/* ========================================================================== */
describe('applyAnswer matrix', () => {

  const LEVELS = [0, 1, 2, 3, 4, 5, 6];
  const DIRS = ['en_ru', 'ru_en'];
  const ANSWER_LIST = ['again', 'hard', 'easy'];
  const OTHER_LEVEL = 5;
  const OTHER_DUE = '2026-10-01';

  function matrixCard(dir, level) {
    const over = {
      level_en_ru: 2, level_ru_en: 2,
      next_review_en_ru: '2026-09-10', next_review_ru_en: '2026-09-10',
      fail_count: 3, review_count: 10
    };
    over['level_' + dir] = level;
    over['next_review_' + dir] = '2026-09-10';
    const other = SRS.otherDir(dir);
    over['level_' + other] = OTHER_LEVEL;
    over['next_review_' + other] = OTHER_DUE;
    return deepFreeze(mkCard('mtx-' + dir + '-' + level, over));   // frozen: any mutation attempt throws
  }

  test('rules 2+3: full 7 levels × 2 dirs × 3 answers — next level, due, interval, group, outcome', () => {
    for (const dir of DIRS) {
      for (const L of LEVELS) {
        for (const ans of ANSWER_LIST) {
          const c = matrixCard(dir, L);
          const res = SRS.applyAnswer(c, dir, ans, TODAY);
          const m = 'applyAnswer(' + dir + ',L' + L + ',' + ans + ')';
          const exp = expectedNextLevel(L, ans);
          assert.equal(res.next.level, exp, m + ': next level per rules 2+3');
          assert.equal(res.card['level_' + dir], exp, m + ': card level field');
          assert.equal(res.next.due, DUE[exp], m + ': rule 1 — due = today + INTERVALS[' + exp + ']');
          assert.equal(res.card['next_review_' + dir], DUE[exp], m + ': card due field');
          assert.equal(res.next.intervalDays, SRS.INTERVALS[exp], m + ': intervalDays reported');
          assert.equal(res.next.group, SRS.GROUP_OF_LEVEL[exp], m + ': group reported');
          const expOutcome = exp > L ? 'advance' : (exp < L ? 'reset' : 'hold');
          assert.equal(res.outcome, expOutcome, m + ': outcome ' + expOutcome);
          assert.equal(res.promotedFromNew, L === 0, m + ': promotedFromNew only at L0');
          assert.equal(res.activated, false, m + ': ACTIVE card must not report activated');
          assert.equal(res.direction, dir, m + ': canonical direction echoed');
          assert.equal(res.answer, ans, m + ': canonical answer echoed');
          /* invariant A1: never leaves a direction at level 0 */
          assert.ok(res.next.level >= 1, m + ': invariant A1 — answer must never leave level 0');
          /* invariant A2: answered direction is never due again the same day */
          assert.equal(SRS.isDirectionDue(res.card, dir, TODAY), false, m + ': invariant A2 — must not stay due today');
          assert.deepEqual(J(res.warnings), [], m + ': no warnings expected (no level0_retained / still_due_today)');
        }
      }
    }
  });

  test('rule 4/A8: firewall — every matrix cell touches only the 5 scheduling fields, other direction byte-identical, input untouched', () => {
    for (const dir of DIRS) {
      for (const L of LEVELS) {
        for (const ans of ANSWER_LIST) {
          const c = matrixCard(dir, L);              // deep-frozen on purpose
          const before = J(c);
          const res = SRS.applyAnswer(c, dir, ans, TODAY);
          const m = 'A8 applyAnswer(' + dir + ',L' + L + ',' + ans + ')';
          const other = SRS.otherDir(dir);
          /* other direction byte-identical */
          assert.equal(res.card['level_' + other], OTHER_LEVEL, m + ': other level must stay byte-identical');
          assert.equal(res.card['next_review_' + other], OTHER_DUE, m + ': other due must stay byte-identical');
          /* changed-key whitelist */
          const changed = changedKeys(before, res.card);
          // last_review_<dir> добавлен 19.09: штамп дня для same-day anti-inflation guard.
          const allowed = ['level_' + dir, 'next_review_' + dir, 'last_review_' + dir, 'review_count', 'fail_count'].sort();
          for (const k of changed) {
            assert.ok(allowed.indexOf(k) !== -1, m + ': field `' + k + '` changed — A8 allows only ' + allowed.join(','));
          }
          /* rule 5 counters */
          assert.equal(res.card.review_count, before.review_count + 1, m + ': rule 5 — review_count +1 on every answer');
          assert.equal(res.card.fail_count, before.fail_count + (ans === 'again' ? 1 : 0), m + ': rule 5 — fail_count only on again');
          /* clone identity + input immutability (frozen input also proves no write happened) */
          assert.notEqual(res.card, c, m + ': result card must be a fresh clone');
          assert.deepEqual(J(c), before, m + ': input card must never be mutated');
        }
      }
    }
  });

  test('rule 2: reset asymmetry boundaries — again L3→1 vs L4→2, hard freeze, easy step', () => {
    const againRow = [1, 1, 1, 1, 2, 2, 2];        // L0..L6 (L0 via A1)
    const hardRow = [1, 1, 2, 3, 4, 5, 6];          // freeze, except A1 lift at L0
    const easyRow = [1, 2, 3, 4, 5, 6, 6];          // +1, ceiling 6
    for (let L = 0; L <= 6; L++) {
      const cA = mkCard('ra' + L, { level_en_ru: L, next_review_en_ru: '2026-09-10' });
      assert.equal(SRS.applyAnswer(cA, 'en_ru', 'again', TODAY).next.level, againRow[L], 'again at L' + L + ' must land on ' + againRow[L]);
      const cH = mkCard('rh' + L, { level_en_ru: L, next_review_en_ru: '2026-09-10' });
      const rH = SRS.applyAnswer(cH, 'en_ru', 'hard', TODAY);
      assert.equal(rH.next.level, hardRow[L], 'hard at L' + L + ' must freeze at ' + hardRow[L]);
      assert.equal(rH.next.due, DUE[hardRow[L]], 'hard at L' + L + ' repeats the same interval');
      const cE = mkCard('re' + L, { level_en_ru: L, next_review_en_ru: '2026-09-10' });
      assert.equal(SRS.applyAnswer(cE, 'en_ru', 'easy', TODAY).next.level, easyRow[L], 'easy at L' + L + ' must land on ' + easyRow[L]);
    }
    /* the exact asymmetric boundary from the owner rule */
    assert.equal(SRS.applyAnswer(mkCard('b3', { level_ru_en: 3 }), 'ru_en', 'again', TODAY).next.level, 1, 'again at L3 must reset to 1 (≤3 branch)');
    assert.equal(SRS.applyAnswer(mkCard('b4', { level_ru_en: 4 }), 'ru_en', 'again', TODAY).next.level, 2, 'again at L4 must reset to 2 (>3 branch)');
  });

  test('rule 3/A1: at prev.level 0 ALL three answers yield level 1 (termination)', () => {
    for (const ans of ANSWER_LIST) {
      for (const dir of DIRS) {
        const c = mkCard('a1-' + ans + dir, { level_en_ru: 0, level_ru_en: 0, next_review_en_ru: TODAY, next_review_ru_en: TODAY });
        const res = SRS.applyAnswer(c, dir, ans, TODAY);
        const m = 'A1 ' + ans + ' at L0 on ' + dir;
        assert.equal(res.next.level, 1, m + ': must lift to 1, never stay 0 (INTERVALS[0]=0 would re-queue forever)');
        assert.equal(res.next.due, DUE[1], m + ': due tomorrow');
        assert.equal(res.outcome, 'advance', m + ': L0→L1 counts as advance even for hard/again');
        assert.equal(res.promotedFromNew, true, m + ': promotedFromNew true');
        assert.equal(SRS.isDirectionDue(res.card, dir, TODAY), false, m + ': A2 — not due again today');
        /* same-day termination at queue level: the answered pair never re-enters today's queue */
        const q = SRS.buildReviewQueue([res.card], TODAY);
        assert.ok(!q.some((it) => it.direction === dir && it.cardId === res.card.id), m + ': answered direction must not re-enter today\'s review queue');
      }
    }
  });

  test('rule 1: L6 ceiling forever — easy at L6 stays 30 days, no archive exists', () => {
    let c = mkCard('ceil', { level_en_ru: 6, level_ru_en: 6, next_review_en_ru: DUE[6], next_review_ru_en: DUE[6] });
    for (let i = 0; i < 5; i++) {
      const res = SRS.applyAnswer(c, 'en_ru', 'easy', TODAY);
      assert.equal(res.next.level, 6, 'ceiling loop #' + i + ': easy at L6 must stay 6');
      assert.equal(res.next.intervalDays, 30, 'ceiling loop #' + i + ': interval stays 30 days forever');
      assert.equal(res.next.group, 'MASTERED', 'ceiling loop #' + i + ': group stays MASTERED');
      assert.equal(res.outcome, 'hold', 'ceiling loop #' + i + ': outcome hold at ceiling');
      assert.equal(res.next.due, DUE[6], 'ceiling loop #' + i + ': due = today+30');
      c = res.card;
    }
    assert.ok(!('archive' in c), 'rule 1: no archive field may appear');
    assert.ok(!('archived' in c), 'rule 1: no archived field may appear');
  });

  test('answers: normalizeAnswer folds every alias, numeric and boolean form', () => {
    const again = ['again', 'forgot', 'забыл', 'не_помню', 'нет', 'wrong', 'fail', 'AGAIN', ' Forgot ', 'ЗАБЫЛ'];
    const hard = ['hard', 'difficult', 'сложно', 'трудно', 'HARD', ' СЛОЖНО '];
    const easy = ['easy', 'remembered', 'good', 'легко', 'помню', 'да', 'EASY', ' Good '];
    for (const a of again) assert.equal(SRS.normalizeAnswer(a), 'again', 'normalizeAnswer(' + JSON.stringify(a) + ') → again');
    for (const a of hard) assert.equal(SRS.normalizeAnswer(a), 'hard', 'normalizeAnswer(' + JSON.stringify(a) + ') → hard');
    for (const a of easy) assert.equal(SRS.normalizeAnswer(a), 'easy', 'normalizeAnswer(' + JSON.stringify(a) + ') → easy');
    assert.equal(SRS.normalizeAnswer(1), 'again', 'numeric 1 → again (legacy SM-2)');
    assert.equal(SRS.normalizeAnswer(2), 'hard', 'numeric 2 → hard');
    assert.equal(SRS.normalizeAnswer(3), 'easy', 'numeric 3 → easy');
    assert.equal(SRS.normalizeAnswer(4), 'easy', 'numeric 4 → easy');
    assert.equal(SRS.normalizeAnswer(true), 'easy', 'boolean true → easy');
    assert.equal(SRS.normalizeAnswer(false), 'again', 'boolean false → again');
    for (const bad of [0, 5, -1, 2.5, NaN, 'maybe', '', null, undefined, {}, []]) {
      assert.throws(() => SRS.normalizeAnswer(bad), TypeError, 'normalizeAnswer(' + JSON.stringify(bad) + ') must throw TypeError');
    }
    /* alias also flows through applyAnswer */
    const c = mkCard('alias-flow', { level_en_ru: 4, next_review_en_ru: '2026-09-10' });
    const res = SRS.applyAnswer(c, 'eng-rus', 'забыл', TODAY);
    assert.equal(res.direction, 'en_ru', 'applyAnswer must canonicalize the direction alias');
    assert.equal(res.answer, 'again', 'applyAnswer must canonicalize the answer alias');
    assert.equal(res.next.level, 2, '«Забыл» at L4 → 2 through the alias path');
  });

  test('applyAnswer: TypeError on invalid card / today / dir / answer', () => {
    const c = mkCard('throw');
    assert.throws(() => SRS.applyAnswer(null, 'en_ru', 'easy', TODAY), TypeError, 'applyAnswer: null card throws');
    assert.throws(() => SRS.applyAnswer('str', 'en_ru', 'easy', TODAY), TypeError, 'applyAnswer: non-object card throws');
    assert.throws(() => SRS.applyAnswer(c, 'en_ru', 'easy', '2026-9-7'), TypeError, 'applyAnswer: unpadded today throws');
    assert.throws(() => SRS.applyAnswer(c, 'en_ru', 'easy', 'garbage'), TypeError, 'applyAnswer: junk today throws');
    assert.throws(() => SRS.applyAnswer(c, 'en_ru', 'easy', undefined), TypeError, 'applyAnswer: missing today throws');
    assert.throws(() => SRS.applyAnswer(c, 'en_ru', 'easy', null), TypeError, 'applyAnswer: null today throws');
    assert.throws(() => SRS.applyAnswer(c, 'both', 'easy', TODAY), TypeError, 'applyAnswer: unknown direction throws');
    assert.throws(() => SRS.applyAnswer(c, 'en_ru', 'maybe', TODAY), TypeError, 'applyAnswer: unknown answer throws');
  });

  test('applyAnswer: junk level fields coerce via clampLevel before the rules run', () => {
    const c = mkCard('junklvl', { level_en_ru: 'x', level_ru_en: '4', next_review_en_ru: '2026-09-10', next_review_ru_en: '2026-09-10' });
    const r1 = SRS.applyAnswer(c, 'en_ru', 'easy', TODAY);
    assert.equal(r1.prev.level, 0, 'junk level reads as 0');
    assert.equal(r1.next.level, 1, 'A1 still applies to junk levels: any answer → 1');
    assert.equal(r1.promotedFromNew, true, 'junk level counts as promoted-from-new');
    const r2 = SRS.applyAnswer(c, 'ru_en', 'again', TODAY);
    assert.equal(r2.prev.level, 4, "string '4' coerces to level 4");
    assert.equal(r2.next.level, 2, 'again at coerced L4 → 2');
  });

  test('applyAnswer: full result shape on one representative card (deep-equal golden)', () => {
    const c = deepFreeze(mkCard('shape', {
      level_en_ru: 4, level_ru_en: 2,
      next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-09-19',
      fail_count: 1, review_count: 5
    }));
    const res = SRS.applyAnswer(c, 'en_ru', 'again', TODAY);
    assert.deepEqual(J(res.card), J({
      id: 'shape', word: 'word-shape', phonetic: '[fəˈnɛtɪk]',
      translation: 'перевод-shape', example: 'example shape',
      example_translation: 'пример shape', part_of_speech: 'noun',
      partOfSpeech: 'noun', batch_id: 'batch-1', batch_name: 'Batch One',
      created_at: '2026-01-01', status: 'ACTIVE',
      level_en_ru: 2, level_ru_en: 2,
      next_review_en_ru: '2026-09-19', next_review_ru_en: '2026-09-19',
      last_review_en_ru: TODAY,
      fail_count: 2, review_count: 6
    }), 'again at L4: only level/due/last_review/fail/review change, content byte-identical');
    assert.deepEqual(J(res.prev), { level: 4, due: '2026-09-20' }, 'prev snapshot');
    assert.deepEqual(J(res.next), { level: 2, due: '2026-09-19', intervalDays: 2, group: 'FAMILIAR' }, 'next snapshot');
    assert.equal(res.cardGroup, 'FAMILIAR', 'cardGroup = weakest direction after the answer');
    assert.deepEqual(J(res.pendingDirections), [], 'pendingDirections empty: ru_en due 2026-09-19 lies in the future');
  });
});

/* ========================================================================== */
/* 7. BANK LIFECYCLE (rule 6)                                                  */
/* ========================================================================== */
describe('bank lifecycle (rule 6)', () => {

  test('rule 6: BANK isolation — null dates, never due, invisible to review queue', () => {
    const b = mkBank('iso');
    assert.equal(b.next_review_en_ru, null, 'BANK: next_review_en_ru null');
    assert.equal(b.next_review_ru_en, null, 'BANK: next_review_ru_en null');
    assert.equal(SRS.isDue(b, TODAY), false, 'rule 6: BANK isDue() === false');
    assert.deepEqual(J(SRS.dueDirections(b, TODAY)), [], 'rule 6: BANK dueDirections() === []');
    const dirty = mkBank('dirty', { next_review_en_ru: '2026-01-01', next_review_ru_en: '2026-01-01' });
    assert.equal(SRS.isDue(dirty, TODAY), false, 'rule 6: BANK with junk overdue dates still not due');
    const q = SRS.buildReviewQueue([b, dirty, mkCard('act', { next_review_en_ru: '2026-09-01', next_review_ru_en: '2026-12-01' })], TODAY);
    assert.deepEqual(keysOf(q), ['act:en_ru'], 'rule 6: BANK cards never appear in buildReviewQueue, ACTIVE due card does');
    assert.equal(SRS.buildCramQueue([b, dirty], TODAY).length, 0, 'BANK invisible to cram queue too');
    assert.equal(SRS.buildSubsetQueue([b], TODAY, { allDirections: true }).length, 0, 'BANK invisible to subset queue without includeBank');
  });

  test('rule 6: first answer on BANK composes activate-then-grade in one call', () => {
    const b = deepFreeze(mkBank('compose'));
    for (const dir of ['en_ru', 'ru_en']) {
      for (const ans of ['again', 'hard', 'easy']) {
        const other = SRS.otherDir(dir);
        const res = SRS.answerBankCard(b, dir, ans, TODAY);
        const m = 'bank compose ' + dir + '/' + ans;
        assert.equal(res.card.status, 'ACTIVE', m + ': status becomes ACTIVE');
        assert.equal(res.card['level_' + dir], 1, m + ': shown direction graded 0→1 (A1, answer-independent)');
        assert.equal(res.card['next_review_' + dir], DUE[1], m + ': shown direction due tomorrow');
        assert.equal(res.card['level_' + other], 0, m + ': other direction stays at level 0');
        assert.equal(res.card['next_review_' + other], TODAY, m + ': other direction due today (pending)');
        assert.equal(res.activated, true, m + ': activated flag set');
        assert.deepEqual(J(res.pendingDirections), [other], m + ': pendingDirections = [otherDir]');
        assert.equal(res.prev.level, 0, m + ': prev.level 0');
        assert.equal(res.prev.due, TODAY, m + ': prev.due = activation day (activate runs before grading)');
        assert.equal(res.card.review_count, 1, m + ': first review counted');
        assert.equal(res.card.fail_count, ans === 'again' ? 1 : 0, m + ': fail only on again');
        assert.equal(res.cardGroup, 'NEW', m + ': card group = weakest link = the pending L0 side');
        assert.deepEqual(J(b), J(mkBank('compose')), m + ': input bank card never mutated');
        /* applyAnswer on a BANK card must compose identically */
        const direct = SRS.applyAnswer(b, dir, ans, TODAY);
        assert.deepEqual(J(direct.card), J(res.card), m + ': applyAnswer(BANK) === answerBankCard(BANK) card');
        assert.equal(direct.activated, true, m + ': applyAnswer also reports activated on BANK input');
      }
    }
  });

  test('mutations: activateCard idempotent, returnToBank abandons, setCardStatus routes', () => {
    const b = deepFreeze(mkBank('act'));
    const a = SRS.activateCard(b, TODAY);
    assert.equal(a.status, 'ACTIVE', 'activateCard: BANK → ACTIVE');
    assert.equal(a.level_en_ru, 0, 'activateCard: levels start at 0');
    assert.equal(a.level_ru_en, 0, 'activateCard: both levels 0');
    assert.equal(a.next_review_en_ru, TODAY, 'activateCard: en_ru due today');
    assert.equal(a.next_review_ru_en, TODAY, 'activateCard: ru_en due today');
    assert.deepEqual(J(b), J(mkBank('act')), 'activateCard: input untouched');
    const prog = mkCard('prog', { level_en_ru: 4, level_ru_en: 2, next_review_en_ru: '2026-10-01', next_review_ru_en: '2026-09-20', review_count: 7 });
    const re = SRS.activateCard(prog, TODAY);
    assert.equal(re.level_en_ru, 4, 'activateCard: already-ACTIVE card keeps progress (no rollback)');
    assert.equal(re.next_review_en_ru, '2026-10-01', 'activateCard: already-ACTIVE keeps dates');
    assert.equal(re.review_count, 7, 'activateCard: counters kept');

    const back = SRS.returnToBank(prog);
    assert.equal(back.status, 'BANK', 'returnToBank: status BANK');
    assert.equal(back.level_en_ru, 0, 'returnToBank: levels zeroed');
    assert.equal(back.level_ru_en, 0, 'returnToBank: both levels zeroed');
    assert.equal(back.next_review_en_ru, null, 'returnToBank: dates nulled');
    assert.equal(back.next_review_ru_en, null, 'returnToBank: both dates nulled');
    assert.equal(back.review_count, 7, 'returnToBank: history counters preserved (abandonment is not amnesia)');
    assert.equal(SRS.isDue(back, TODAY), false, 'returnToBank: card is invisible again');
    assert.equal(prog.level_en_ru, 4, 'returnToBank: input level untouched');
    assert.equal(prog.next_review_en_ru, '2026-10-01', 'returnToBank: input date untouched');

    assert.equal(SRS.setCardStatus(prog, 'bank', TODAY).status, 'BANK', 'setCardStatus: "bank" routes to returnToBank');
    assert.equal(SRS.setCardStatus(prog, 'BANK', TODAY).status, 'BANK', 'setCardStatus: case-insensitive BANK');
    const up = SRS.setCardStatus(mkBank('up'), 'active', TODAY);
    assert.equal(up.status, 'ACTIVE', 'setCardStatus: anything else activates');
    assert.equal(up.next_review_en_ru, TODAY, 'setCardStatus: activation dates both directions today');

    const sdl = SRS.setDirectionLevel(mkBank('sdl'), 'ru_en', 3, TODAY);
    assert.equal(sdl.status, 'ACTIVE', 'setDirectionLevel: manual edit activates the card');
    assert.equal(sdl.level_ru_en, 3, 'setDirectionLevel: target direction set to 3');
    assert.equal(sdl.next_review_ru_en, DUE[3], 'setDirectionLevel: due = today + INTERVALS[3]');
    assert.equal(sdl.level_en_ru, 0, 'setDirectionLevel: other direction untouched');
    assert.equal(sdl.next_review_en_ru, null, 'setDirectionLevel: other due untouched (fail-open will show it)');
    assert.throws(() => SRS.setDirectionLevel(mkCard('sd'), 'both', 3, TODAY), TypeError, 'setDirectionLevel: unknown dir throws');
  });

  test('newCardSkeleton: strict bank defaults, deterministic id, array POS, junk dropped', () => {
    const src = { word: 'hello', translation: 'привет', part_of_speech: ['noun', 'verb'], batch_id: 'b1', batch_name: 'B1', created_at: '2026-01-01' };
    const s1 = SRS.newCardSkeleton(src, { salt: 's1' });
    const s2 = SRS.newCardSkeleton(src, { salt: 's1' });
    const s3 = SRS.newCardSkeleton(src, { salt: 'different' });
    assert.equal(s1.id, s2.id, 'skeleton: same word+translation+salt → same id');
    assert.notEqual(s1.id, s3.id, 'skeleton: different salt → different id');
    assert.ok(/^card_[0-9a-z]+$/.test(s1.id), 'skeleton: generated id shape');
    assert.equal(s1.status, 'BANK', 'rule 6: skeleton starts in BANK');
    assert.equal(s1.level_en_ru, 0, 'skeleton: level_en_ru 0');
    assert.equal(s1.level_ru_en, 0, 'skeleton: level_ru_en 0');
    assert.equal(s1.next_review_en_ru, null, 'skeleton: no dates');
    assert.equal(s1.next_review_ru_en, null, 'skeleton: no dates (both)');
    assert.deepEqual(J(s1.part_of_speech), ['noun', 'verb'], 'rule 16: array part_of_speech preserved, never flattened');
    assert.equal(s1.partOfSpeech, 'noun / verb', 'skeleton: camel spelling gap-filled as display text');
    assert.equal(s1.created_at, '2026-01-01', 'skeleton: created_at kept');
    assert.equal(s1.fail_count, 0, 'skeleton: counters zero');
    assert.equal(s1.review_count, 0, 'skeleton: counters zero (both)');

    const keep = SRS.newCardSkeleton({ id: 'keepme', word: 'w', translation: 't', box: 3, level: 5, knowledge_group: 'X', extra: { deep: 1 } }, { today: TODAY });
    assert.equal(keep.id, 'keepme', 'skeleton: explicit id preserved');
    assert.ok(!('box' in keep), 'rule 15: deprecated box dropped from skeleton');
    assert.ok(!('level' in keep), 'rule 15: deprecated level dropped');
    assert.ok(!('knowledge_group' in keep), 'rule 15: knowledge_group never stored');
    assert.deepEqual(J(keep.extra), { deep: 1 }, 'skeleton: unknown extras preserved');
    assert.equal(keep.created_at, TODAY, 'skeleton: created_at falls back to opts.today');

    const bare = SRS.newCardSkeleton();
    assert.equal(bare.status, 'BANK', 'skeleton: no-arg still BANK');
    assert.equal(bare.word, '', 'skeleton: no-arg word empty string');
    assert.ok(bare.id.startsWith('card_'), 'skeleton: no-arg still gets an id');

    const arrKeep = SRS.newCardSkeleton({ word: 'w', translation: 't', partOfSpeech: ['gerund'] }, {});
    assert.deepEqual(J(arrKeep.partOfSpeech), ['gerund'], 'rule 16: array partOfSpeech preserved as array');
    assert.equal(arrKeep.part_of_speech, 'gerund', 'skeleton: snake spelling gap-filled as display text');
  });
});

/* ========================================================================== */
/* 8. DETERMINISM PRIMITIVES (rule 9)                                          */
/* ========================================================================== */
describe('determinism primitives', () => {

  test('fnv1a: standard FNV-1a 32-bit vectors and stability', () => {
    assert.equal(SRS.fnv1a(''), 2166136261, 'fnv1a: offset basis for empty string');
    assert.equal(SRS.fnv1a('a'), 3826002220, 'fnv1a: standard vector "a"');
    assert.equal(SRS.fnv1a('foobar'), 3214735720, 'fnv1a: standard vector "foobar"');
    assert.equal(SRS.fnv1a('x'), SRS.fnv1a('x'), 'fnv1a: stable across calls');
    const h = SRS.fnv1a('any');
    assert.ok(Number.isInteger(h) && h >= 0 && h < 4294967296, 'fnv1a: uint32 range');
  });

  test('rngFromSeed: same seed → same stream, different seed → different stream, [0,1)', () => {
    const a = SRS.rngFromSeed('abc'), b = SRS.rngFromSeed('abc'), c = SRS.rngFromSeed('abd');
    const sa = [], sb = [], sc = [];
    for (let i = 0; i < 20; i++) { sa.push(a()); sb.push(b()); sc.push(c()); }
    assert.deepEqual(sa, sb, 'rng: identical seeds produce identical streams');
    assert.notDeepEqual(sa, sc, 'rng: different seeds produce different streams');
    for (const v of sa) {
      assert.ok(v >= 0 && v < 1, 'rng: values in [0,1)');
    }
    const n1 = SRS.rngFromSeed(7), n2 = SRS.rngFromSeed(7);
    assert.equal(n1(), n2(), 'rng: numeric seed determinism');
  });

  test('seededShuffle: preserves multiset, never mutates input, seed-sensitive order', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ key: 'k' + i, cardId: 'c' + i }));
    const frozenIn = J(items);
    const s1 = SRS.seededShuffle(items, 'seed-1');
    const s2 = SRS.seededShuffle(items, 'seed-1');
    const s3 = SRS.seededShuffle(items, 'seed-2');
    assert.deepEqual(J(s1), J(s2), 'shuffle: same seed → byte-identical order');
    assert.notDeepEqual(keysOf(s1).sort(), keysOf(s1), 'shuffle sanity: order actually permuted for this seed');
    assert.deepEqual(keysOf(s1).sort(), keysOf(s3).sort(), 'shuffle: seed changes order, not content');
    assert.deepEqual(J(items), frozenIn, 'shuffle: input array never mutated');
    assert.deepEqual(J(SRS.seededShuffle([], 'x')), [], 'shuffle: empty in → empty out');
    assert.deepEqual(J(SRS.seededShuffle(null, 'x')), [], 'shuffle: null in → empty out');
  });

  test('rule 8: spreadSameCard NEVER drops entries and honors the gap when possible', () => {
    const it = (id, dir) => ({ key: id + ':' + dir, cardId: id, direction: dir });
    /* length + multiset invariant across adversarial configurations */
    const rnd = SRS.rngFromSeed('spread-fuzz');
    for (let round = 0; round < 60; round++) {
      const n = 1 + Math.floor(rnd() * 25);
      const ids = ['a', 'b', 'c', 'd', 'e'];
      const list = [];
      for (let i = 0; i < n; i++) list.push(it(ids[Math.floor(rnd() * ids.length)], rnd() < 0.5 ? 'en_ru' : 'ru_en'));
      const gap = [undefined, 1, 2, 3, 5][Math.floor(rnd() * 5)];
      const out = SRS.spreadSameCard(list, gap);
      assert.equal(out.length, list.length, 'spread fuzz #' + round + ': output length must equal input length (never drop entries)');
      assert.deepEqual(keysOf(out).sort(), keysOf(list).sort(), 'spread fuzz #' + round + ': multiset of keys preserved');
    }
    /* unique cardIds → order must be preserved exactly (greedy first-candidate) */
    const uniq = [it('a', 'en_ru'), it('b', 'en_ru'), it('c', 'en_ru'), it('d', 'en_ru')];
    assert.deepEqual(keysOf(SRS.spreadSameCard(uniq)), keysOf(uniq), 'spread: unique cardIds keep input order');
    /* degenerate: only one word in the pool → cannot spread, but must not drop or throw */
    const degen = [it('a', 'en_ru'), it('a', 'ru_en')];
    const outD = SRS.spreadSameCard(degen);
    assert.equal(outD.length, 2, 'spread degenerate: both entries survive');
    assert.deepEqual(keysOf(outD).sort(), ['a:en_ru', 'a:ru_en'], 'spread degenerate: multiset intact');
    const solo = [it('a', 'en_ru'), it('a', 'ru_en'), it('a', 'en_ru')];
    assert.equal(SRS.spreadSameCard(solo).length, 3, 'spread degenerate: three same-card entries survive');
    /* gap honored when the queue is long enough */
    const mix = [it('a', 'en_ru'), it('a', 'ru_en'), it('b', 'en_ru'), it('c', 'en_ru'), it('d', 'en_ru'), it('e', 'en_ru')];
    const outM = SRS.spreadSameCard(mix, 3);
    assert.equal(outM.length, 6, 'spread mix: length preserved');
    const ai = outM.map((x, i) => (x.cardId === 'a' ? i : -1)).filter((i) => i >= 0);
    assert.ok(ai[1] - ai[0] >= 3, 'spread mix: the two sides of word "a" are separated by at least gap=3');
    for (let i = 1; i < outM.length; i++) {
      assert.notEqual(outM[i].cardId, outM[i - 1].cardId, 'spread mix: no same-card adjacency at position ' + i);
    }
    /* empty/null inputs */
    assert.deepEqual(J(SRS.spreadSameCard([])), [], 'spread: empty → empty');
    assert.deepEqual(J(SRS.spreadSameCard(null)), [], 'spread: null → empty');
    assert.deepEqual(keysOf(SRS.spreadSameCard(uniq, 'junk-gap')), keysOf(uniq), 'spread: junk gap falls back to the default without changing unique-id order');
  });
});

/* ========================================================================== */
/* 9. QUEUE BUILDERS (rules 7,8,9,10)                                          */
/* ========================================================================== */
describe('queue builders', () => {

  /* Fixture from the owner-rule 7 example:
     c1: L6 en_ru 40 days overdue + L3 ru_en due today
     c2: L3 en_ru due today, ru_en not due
     c3: BANK with stale overdue dates (must never appear)
     c4: L1/L1 both 16 days overdue                                            */
  const C1 = qCard('c1', 'ACTIVE', 6, 3, '2026-08-08', '2026-09-17');
  const C2 = qCard('c2', 'ACTIVE', 3, 3, '2026-09-17', '2026-09-30');
  const C3 = qCard('c3', 'BANK', 0, 0, '2026-09-01', '2026-09-01');
  const C4 = qCard('c4', 'ACTIVE', 1, 1, '2026-09-01', '2026-09-01');
  const FIXTURE = [C1, C2, C3, C4];
  const EXPECTED_ORDER = ['c4:en_ru', 'c1:ru_en', 'c2:en_ru', 'c4:ru_en', 'c1:en_ru'];

  test('rule 7: buildReviewQueue membership — ACTIVE with due<=today, one entry per due direction, BANK never', () => {
    const q = SRS.buildReviewQueue(FIXTURE, TODAY);
    assert.deepEqual(keysOf(q), EXPECTED_ORDER, 'rule 7: exact weakest-first order for the canonical fixture');
    assert.ok(!q.some((x) => x.cardId === 'c3'), 'rule 6: BANK card with overdue dates never enters the review queue');
    assert.ok(!q.some((x) => x.key === 'c2:ru_en'), 'future direction (2026-09-30) must not be queued');
    assert.equal(q.filter((x) => x.cardId === 'c1').length, 2, 'both due directions of c1 produce two entries');
    assert.equal(q.length, SRS.summarize(FIXTURE, TODAY).dueEntries, 'rule 7: queue length === summarize().dueEntries');
    /* due today (delta 0) counts as due; tomorrow does not */
    const edge = [qCard('e1', 'ACTIVE', 2, 2, TODAY, '2026-09-18')];
    assert.deepEqual(keysOf(SRS.buildReviewQueue(edge, TODAY)), ['e1:en_ru'], 'due === today is queued, tomorrow is not');
    /* fail-open: ACTIVE with null/garbage date is queued */
    const fo = [qCard('f1', 'ACTIVE', 2, 2, null, 'garbage')];
    assert.deepEqual(keysOf(SRS.buildReviewQueue(fo, TODAY)).sort(), ['f1:en_ru', 'f1:ru_en'], 'fail-open: null and garbage dates both queue');
    /* cards without id / junk rows ignored */
    assert.equal(SRS.buildReviewQueue([{ status: 'ACTIVE' }, null, 42], TODAY).length, 0, 'id-less and junk rows ignored');
    assert.deepEqual(J(SRS.buildReviewQueue([], TODAY)), [], 'empty input → empty queue');
    assert.deepEqual(J(SRS.buildReviewQueue(null, TODAY)), [], 'null input → empty queue');
  });

  test('rule 7: ordering — weakest-first; L6 40d overdue sorts AFTER L3 due today; overdue desc within rank', () => {
    const q = SRS.buildReviewQueue(FIXTURE, TODAY);
    const keys = keysOf(q);
    assert.ok(keys.indexOf('c1:en_ru') > keys.indexOf('c2:en_ru'), 'rule 7: L6 (40 days overdue) sorts after L3 due today');
    assert.ok(keys.indexOf('c1:en_ru') > keys.indexOf('c1:ru_en'), 'rule 7: L6 sorts after the L3 side of its own card');
    assert.equal(keys[0], 'c4:en_ru', 'rule 7: LEARNING (rank 1) leads the queue despite L3 entries being due');
    /* within same rank: more overdue first */
    const sameRank = [
      qCard('r1', 'ACTIVE', 2, 2, '2026-09-16', '2026-12-01'),   // 1 day overdue
      qCard('r2', 'ACTIVE', 3, 2, '2026-09-01', '2026-12-01')    // 16 days overdue, same FAMILIAR rank
    ];
    const qs = SRS.buildReviewQueue(sameRank, TODAY, { gap: 1 });
    assert.equal(qs[0].key, 'r2:en_ru', 'rule 7: within equal rank, larger overdue goes first');
    /* item anatomy */
    const it4 = q.find((x) => x.key === 'c4:en_ru');
    assert.equal(it4.level, 1, 'makeItem: level of shown direction');
    assert.equal(it4.intervalDays, 1, 'makeItem: intervalDays = INTERVALS[level]');
    assert.equal(it4.entryGroup, 'LEARNING', 'makeItem: entryGroup from shown level');
    assert.equal(it4.entryRank, 1, 'makeItem: entryRank = group rank');
    assert.equal(it4.cardGroup, 'LEARNING', 'makeItem: cardGroup = weakest link');
    assert.equal(it4.dueDate, '2026-09-01', 'makeItem: dueDate echoed');
    assert.equal(it4.overdue, 16, 'makeItem: overdue days');
    assert.equal(it4.kind, 'review', 'makeItem: default kind review');
    const it1 = q.find((x) => x.key === 'c1:en_ru');
    assert.equal(it1.entryGroup, 'MASTERED', 'makeItem: L6 entry group MASTERED');
    assert.equal(it1.cardGroup, 'FAMILIAR', 'makeItem: c1 cardGroup is FAMILIAR (L3 side weaker)');
    assert.equal(it1.overdue, 40, 'makeItem: 40 days overdue');
  });

  test('rule 8: two due directions of one word are never adjacent (and never dropped) in the review queue', () => {
    const q = SRS.buildReviewQueue(FIXTURE, TODAY);
    for (let i = 1; i < q.length; i++) {
      assert.notEqual(q[i].cardId, q[i - 1].cardId, 'rule 8: same-card adjacency at queue position ' + i);
    }
    assert.equal(q.length, 5, 'rule 8: all 5 due entries survive the spread');
    /* degraded case: queue of exactly one word — adjacency unavoidable, length preserved */
    const only = [qCard('solo', 'ACTIVE', 2, 2, '2026-09-01', '2026-09-01')];
    const qs = SRS.buildReviewQueue(only, TODAY);
    assert.equal(qs.length, 2, 'rule 8 degradation: both entries survive even when spread is impossible');
    assert.deepEqual(keysOf(qs).sort(), ['solo:en_ru', 'solo:ru_en'], 'rule 8 degradation: multiset intact');
  });

  test('rule 10: queue builders de-dupe by key cardId:direction', () => {
    const dup = [J(C4), J(C4), J(C4)];
    const q = SRS.buildReviewQueue(dup, TODAY);
    assert.equal(q.length, 2, 'dedupe: three copies of one card → two entries (one per direction)');
    assert.deepEqual(keysOf(q).sort(), ['c4:en_ru', 'c4:ru_en'], 'dedupe: keys are unique');
    const cq = SRS.buildCramQueue(dup, TODAY);
    assert.equal(cq.length, 2, 'dedupe: cram queue also unique by key');
    const sq = SRS.buildSubsetQueue(dup, TODAY, { allDirections: true });
    assert.equal(sq.length, 2, 'dedupe: subset queue also unique by key');
  });

  test('rule 9: determinism — same seed byte-identical, different seed reorders but preserves the multiset', () => {
    const many = [];
    for (let i = 0; i < 12; i++) many.push(qCard('s' + i, 'ACTIVE', 2, 2, TODAY, '2026-12-01'));
    const a1 = SRS.buildReviewQueue(many, TODAY, { seed: 'A' });
    const a2 = SRS.buildReviewQueue(many, TODAY, { seed: 'A' });
    const b1 = SRS.buildReviewQueue(many, TODAY, { seed: 'B' });
    assert.equal(JSON.stringify(a1), JSON.stringify(a2), 'rule 9: same seed + same input → byte-identical order');
    assert.notDeepEqual(keysOf(a1), keysOf(b1), 'rule 9: different seed → different order');
    assert.deepEqual(keysOf(a1).sort(), keysOf(b1).sort(), 'rule 9: seed changes order only, never the multiset of keys');
    const d1 = SRS.buildReviewQueue(many, TODAY);
    const d2 = SRS.buildReviewQueue(many, TODAY);
    assert.equal(JSON.stringify(d1), JSON.stringify(d2), 'rule 9: default salt (today-derived) is deterministic across calls');
    assert.equal(d1.length, 12, 'determinism fixture sanity: 12 due entries');
  });

  test('queue opts: limit, excludeIds (array + Set), direction alias, group filter', () => {
    const q = SRS.buildReviewQueue(FIXTURE, TODAY);
    const lim = SRS.buildReviewQueue(FIXTURE, TODAY, { limit: 3 });
    assert.deepEqual(keysOf(lim), EXPECTED_ORDER.slice(0, 3), 'limit: truncates AFTER ordering/spread');
    assert.equal(SRS.buildReviewQueue(FIXTURE, TODAY, { limit: 0 }).length, 5, 'limit 0 means unlimited');
    const exArr = SRS.buildReviewQueue(FIXTURE, TODAY, { excludeIds: ['c4'] });
    assert.deepEqual(keysOf(exArr), ['c1:ru_en', 'c2:en_ru', 'c1:en_ru'], 'excludeIds array removes every entry of the card');
    const exSet = SRS.buildReviewQueue(FIXTURE, TODAY, { excludeIds: new Set(['c1']) });
    assert.deepEqual(keysOf(exSet), ['c4:en_ru', 'c2:en_ru', 'c4:ru_en'], 'excludeIds Set works too');
    const dirQ = SRS.buildReviewQueue(FIXTURE, TODAY, { direction: 'eng-rus' });
    assert.deepEqual(keysOf(dirQ), ['c4:en_ru', 'c2:en_ru', 'c1:en_ru'], 'direction filter accepts aliases and keeps order');
    const grpQ = SRS.buildReviewQueue(FIXTURE, TODAY, { group: 'learning' });
    assert.deepEqual(keysOf(grpQ), ['c4:en_ru', 'c4:ru_en'], 'group filter (lowercase) matches derivedGroup LEARNING');
    const grpAll = SRS.buildReviewQueue(FIXTURE, TODAY, { group: 'all' });
    assert.equal(grpAll.length, 5, 'group:"all" disables the filter');
    assert.throws(() => SRS.buildReviewQueue(FIXTURE, TODAY, { direction: 'both' }), TypeError, 'queue: unknown direction opt throws');
  });

  test('buildLearnQueue: BANK only, both directions per word, word limit, spread, seed', () => {
    const bank = [];
    for (let i = 0; i < 25; i++) bank.push(mkBank('lb' + i));
    bank.push(qCard('active1', 'ACTIVE', 1, 1, TODAY, TODAY));
    const lq = SRS.buildLearnQueue(bank, TODAY);
    assert.equal(lq.length, 40, 'learn: default limit = 20 words × 2 directions');
    assert.equal(new Set(lq.map((x) => x.cardId)).size, 20, 'learn: 20 distinct words chosen');
    assert.ok(lq.every((x) => x.kind === 'learn'), 'learn: every entry kind=learn');
    assert.ok(!lq.some((x) => x.cardId === 'active1'), 'learn: ACTIVE cards never enter the learn queue');
    for (let i = 1; i < lq.length; i++) {
      assert.notEqual(lq[i].cardId, lq[i - 1].cardId, 'learn: the two sides of a word are not adjacent at ' + i);
    }
    const l5 = SRS.buildLearnQueue(bank, TODAY, { limit: 5 });
    assert.equal(l5.length, 10, 'learn: limit counts WORDS (5 → 10 entries)');
    const lex = SRS.buildLearnQueue(bank, TODAY, { limit: 30, excludeIds: ['lb0', 'lb1'] });
    assert.ok(!lex.some((x) => x.cardId === 'lb0' || x.cardId === 'lb1'), 'learn: excludeIds drops both directions');
    assert.equal(lex.length, 46, 'learn: 23 remaining words × 2');
    const s1 = SRS.buildLearnQueue(bank, TODAY, { seed: 'A', limit: 30 });
    const s2 = SRS.buildLearnQueue(bank, TODAY, { seed: 'A', limit: 30 });
    const s3 = SRS.buildLearnQueue(bank, TODAY, { seed: 'B', limit: 30 });
    assert.equal(JSON.stringify(s1), JSON.stringify(s2), 'learn: same seed byte-identical');
    assert.deepEqual(keysOf(s1).sort(), keysOf(s3).sort(), 'learn: with limit ≥ bank size, seeds share the same multiset');
    assert.notDeepEqual(keysOf(s1), keysOf(s3), 'learn: different seeds reorder');
    assert.equal(SRS.buildLearnQueue([], TODAY).length, 0, 'learn: empty bank → empty queue');
  });

  test('buildCramQueue: every ACTIVE card, both directions, due-status ignored, BANK excluded', () => {
    const cq = SRS.buildCramQueue(FIXTURE, TODAY);
    assert.equal(cq.length, 6, 'cram: 3 ACTIVE cards × 2 directions regardless of due dates');
    assert.ok(cq.every((x) => x.kind === 'cram'), 'cram: kind=cram on every entry');
    assert.ok(!cq.some((x) => x.cardId === 'c3'), 'cram: BANK excluded');
    assert.ok(cq.some((x) => x.key === 'c2:ru_en'), 'cram: not-due direction c2:ru_en included (no due filter)');
    assert.ok(cq.some((x) => x.key === 'c1:en_ru'), 'cram: L6 direction included');
    const cd = SRS.buildCramQueue(FIXTURE, TODAY, { direction: 'rus-eng' });
    assert.deepEqual(keysOf(cd).sort(), ['c1:ru_en', 'c2:ru_en', 'c4:ru_en'], 'cram: direction alias filter');
    const cg = SRS.buildCramQueue(FIXTURE, TODAY, { group: 'CONFIDENT' });
    assert.deepEqual(keysOf(cg).sort(), [], 'cram: group filter — no CONFIDENT card in fixture (c1 is FAMILIAR by weakest link)');
    const cl = SRS.buildCramQueue(FIXTURE, TODAY, { limit: 2 });
    assert.equal(cl.length, 2, 'cram: limit respected');
  });

  test('buildSubsetQueue: due-only default, allDirections, fallback, includeBank, filters', () => {
    const future = qCard('z1', 'ACTIVE', 2, 2, '2026-10-01', '2026-10-01');
    const dueOne = qCard('z2', 'ACTIVE', 2, 2, '2026-09-10', '2026-10-01');
    const bank = mkBank('z3');
    assert.equal(SRS.buildSubsetQueue([future], TODAY).length, 0, 'subset: default = due directions only');
    assert.deepEqual(keysOf(SRS.buildSubsetQueue([dueOne], TODAY)), ['z2:en_ru'], 'subset: only the due direction');
    const all = SRS.buildSubsetQueue([future], TODAY, { allDirections: true });
    assert.deepEqual(keysOf(all).sort(), ['z1:en_ru', 'z1:ru_en'], 'subset: allDirections overrides due filter');
    assert.ok(all.every((x) => x.kind === 'review'), 'subset: ACTIVE entries kind=review');
    const fb = SRS.buildSubsetQueue([future, dueOne], TODAY, { fallbackAllDirections: true });
    assert.equal(fb.length, 3, 'subset: fallback adds both directions only for cards with nothing due');
    const ib = SRS.buildSubsetQueue([bank], TODAY, { includeBank: true, allDirections: true });
    assert.deepEqual(keysOf(ib).sort(), ['z3:en_ru', 'z3:ru_en'], 'subset: includeBank + allDirections queues the bank card');
    assert.ok(ib.every((x) => x.kind === 'learn'), 'subset: BANK entries kind=learn');
    assert.equal(SRS.buildSubsetQueue([bank], TODAY, { includeBank: true }).length, 0, 'subset: includeBank without directions yields nothing (bank is never due)');
    const dm = SRS.buildSubsetQueue([dueOne, future], TODAY, { allDirections: true, direction: 'en_ru', limit: 1 });
    assert.deepEqual(keysOf(dm), ['z2:en_ru'], 'subset: direction filter + limit compose');
  });

  test('makeItem + compareItems: field contract and comparator semantics', () => {
    const c = qCard('m1', 'ACTIVE', 1, 1, '2025-08-13', TODAY);
    const mi = SRS.makeItem(c, 'eng-rus', TODAY, 'salt');
    assert.equal(mi.key, 'm1:en_ru', 'makeItem: key = cardId:dir (alias normalized)');
    assert.equal(mi.cardId, 'm1', 'makeItem: cardId');
    assert.equal(mi.direction, 'en_ru', 'makeItem: canonical direction');
    assert.equal(mi.kind, 'review', 'makeItem: default kind');
    assert.equal(mi.level, 1, 'makeItem: level');
    assert.equal(mi.intervalDays, 1, 'makeItem: intervalDays');
    assert.equal(mi.entryGroup, 'LEARNING', 'makeItem: entryGroup');
    assert.equal(mi.entryRank, 1, 'makeItem: entryRank');
    assert.equal(mi.cardGroup, 'LEARNING', 'makeItem: cardGroup');
    assert.equal(mi.dueDate, '2025-08-13', 'makeItem: dueDate');
    assert.equal(mi.overdue, 400, 'makeItem: overdue days (400)');
    assert.equal(mi.overdueDisplay, 365, 'makeItem: overdueDisplay capped at DEFAULTS.maxOverdueDisplay=365');
    assert.ok(Number.isInteger(mi.tieBreak) && mi.tieBreak >= 0 && mi.tieBreak < 4294967296, 'makeItem: tieBreak uint32');
    assert.equal(SRS.makeItem(qCard('m2', 'ACTIVE', 2, 2, null, null), 'en_ru', TODAY, 's').overdue, 0, 'makeItem: null due → overdue 0');

    const A = { entryRank: 2, overdue: 5, tieBreak: 100, cardId: 'a', direction: 'en_ru' };
    const B = { entryRank: 2, overdue: 5, tieBreak: 200, cardId: 'b', direction: 'en_ru' };
    const C = { entryRank: 1, overdue: 99, tieBreak: 1, cardId: 'c', direction: 'en_ru' };
    const A2 = { entryRank: 2, overdue: 5, tieBreak: 100, cardId: 'a', direction: 'ru_en' };
    const A3 = { entryRank: 2, overdue: 6, tieBreak: 999, cardId: 'z', direction: 'en_ru' };
    assert.ok(SRS.compareItems(C, A) < 0, 'compareItems: lower rank wins even against huge overdue (rule 7)');
    assert.ok(SRS.compareItems(A3, A) < 0, 'compareItems: bigger overdue wins within rank');
    assert.ok(SRS.compareItems(A, B) < 0, 'compareItems: smaller tieBreak wins within rank+overdue');
    assert.ok(SRS.compareItems(A, A2) < 0, 'compareItems: en_ru before ru_en as last resort');
    assert.equal(SRS.compareItems(A, J(A)), 0, 'compareItems: equal items → 0');
  });
});

/* ========================================================================== */
/* 10. ANALYTICS — summarize / describe (internal consistency)                 */
/* ========================================================================== */
describe('analytics', () => {

  /* Hand-computed fixture (today = 2026-09-17):
     A ACTIVE L1/L1 en due 09-10 (7d overdue)   ru due 09-20 (not due)
     B ACTIVE L6/L4 en due 09-17 (today, od 0)  ru due 10-01 (not due)
     C ACTIVE L2/L2 both due 09-01 (16d overdue)
     D BANK
     E ACTIVE L3/L5 en due 'garbage' (fail-open, od 0) ru due 09-16 (1d overdue)
     F ACTIVE L6/L6 both due 10-01 (not due)                                     */
  const FIX = [
    qCard('A', 'ACTIVE', 1, 1, '2026-09-10', '2026-09-20'),
    qCard('B', 'ACTIVE', 6, 4, '2026-09-17', '2026-10-01'),
    qCard('C', 'ACTIVE', 2, 2, '2026-09-01', '2026-09-01'),
    qCard('D', 'BANK', 0, 0, null, null),
    qCard('E', 'ACTIVE', 3, 5, 'garbage', '2026-09-16'),
    qCard('F', 'ACTIVE', 6, 6, '2026-10-01', '2026-10-01')
  ];

  test('summarize: every internal consistency invariant on the hand-computed fixture', () => {
    const s = SRS.summarize(FIX, TODAY);
    assert.equal(s.total, 6, 'summarize: total counts all id-bearing cards');
    assert.equal(s.bank, 1, 'summarize: bank count');
    assert.equal(s.active, 5, 'summarize: active count');
    assert.equal(s.total, s.bank + s.active, 'summarize invariant: total === bank + active');
    assert.equal(s.dueEntries, 6, 'summarize: due entries A-en,B-en,C-en,C-ru,E-en,E-ru');
    assert.equal(s.dueCards, 4, 'summarize: cards with ≥1 due direction (A,B,C,E)');
    assert.equal(s.overdueEntries, 4, 'summarize: strictly-past due entries (A-en 7d, C×2 16d, E-ru 1d)');
    assert.equal(s.brokenDates, 1, "summarize: E's garbage date counted once");
    assert.deepEqual(J(s.dueByDirection), { en_ru: 4, ru_en: 2 }, 'summarize: due by direction');
    assert.equal(s.dueByDirection.en_ru + s.dueByDirection.ru_en, s.dueEntries, 'summarize invariant: dueByDirection sums to dueEntries');
    assert.deepEqual(J(s.groups), { BANK: 1, NEW: 0, LEARNING: 1, FAMILIAR: 2, CONFIDENT: 1, MASTERED: 1 }, 'summarize: group buckets (weakest-link derivation)');
    const gSum = Object.keys(s.groups).reduce((a, k) => a + s.groups[k], 0);
    assert.equal(gSum, s.total, 'summarize invariant: groups sum to total');
    assert.equal(s.groups.BANK, s.bank, 'summarize invariant: groups.BANK === bank');
    assert.deepEqual(J(s.levels.en_ru), [0, 1, 1, 1, 0, 0, 2], 'summarize: en_ru level histogram (ACTIVE only)');
    assert.deepEqual(J(s.levels.ru_en), [0, 1, 1, 0, 1, 1, 1], 'summarize: ru_en level histogram (ACTIVE only)');
    for (const dir of ['en_ru', 'ru_en']) {
      const sum = s.levels[dir].reduce((a, b) => a + b, 0);
      assert.equal(sum, s.active, 'summarize invariant: ' + dir + ' histogram sums to active');
      assert.equal(s.levels[dir].length, 7, 'summarize: ' + dir + ' histogram has 7 slots');
    }
    assert.equal(s.asymmetry.lagGe2, 2, 'summarize: B (6-4) and E (5-3) have gap ≥2');
    assert.equal(s.asymmetry.pairs, s.asymmetry.lagGe2, 'summarize: pairs mirrors lagGe2');
    assert.equal(s.asymmetry.lagGe3, 0, 'summarize: no gap ≥3 in fixture');
    assert.deepEqual(J(s.asymmetry.worst), [], 'summarize: worst list only holds gap ≥3');
    assert.equal(s.masteredShare, 20, 'summarize: masteredShare = round(1/5×100) = 20');
    assert.equal(s.today, TODAY, 'summarize: today echoed');
    /* queue cross-check (rule 7): dueEntries === review queue length */
    assert.equal(SRS.buildReviewQueue(FIX, TODAY).length, s.dueEntries, 'summarize invariant: dueEntries === buildReviewQueue().length');
  });

  test('summarize: asymmetry.worst ranks by gap desc; empty input gives clean zeros', () => {
    const asym = [
      qCard('G1', 'ACTIVE', 0, 3, '2026-12-01', '2026-12-01'),   // gap 3
      qCard('G2', 'ACTIVE', 2, 6, '2026-12-01', '2026-12-01')     // gap 4
    ];
    const s = SRS.summarize(asym, TODAY);
    assert.equal(s.asymmetry.lagGe3, 2, 'asymmetry: both cards gap ≥3');
    assert.equal(s.asymmetry.worst.length, 2, 'asymmetry: worst lists both');
    assert.equal(s.asymmetry.worst[0].id, 'G2', 'asymmetry: worst sorted by gap desc (G2 gap 4 first)');
    assert.deepEqual(J(s.asymmetry.worst[0]), { id: 'G2', word: 'wG2', gap: 4, en: 2, ru: 6 }, 'asymmetry: worst entry shape');
    const e = SRS.summarize([], TODAY);
    assert.equal(e.total, 0, 'summarize empty: total 0');
    assert.equal(e.active, 0, 'summarize empty: active 0');
    assert.equal(e.dueEntries, 0, 'summarize empty: dueEntries 0');
    assert.equal(e.masteredShare, 0, 'summarize empty: masteredShare 0 (no division by zero)');
    assert.deepEqual(J(e.levels.en_ru), [0, 0, 0, 0, 0, 0, 0], 'summarize empty: zero histograms');
    assert.deepEqual(J(SRS.summarize(null, TODAY).groups), J(e.groups), 'summarize: null input behaves like empty');
  });

  test('describeDirection/describeCard: buckets, phrases, pips, labels', () => {
    const c = qCard('dd', 'ACTIVE', 4, 1, '2026-09-10', '2026-09-20');
    const od = SRS.describeDirection(c, 'en_ru', TODAY, 'ru');
    assert.equal(od.bucket, 'overdue', 'describe: 7 days past → overdue');
    assert.equal(od.overdueDays, 7, 'describe: overdueDays 7');
    assert.equal(od.phrase, 'просрочено на 7 дней', 'describe: Russian overdue phrase with plural');
    assert.equal(od.levelLabel, 'L4', 'describe: levelLabel');
    assert.equal(od.group, 'CONFIDENT', 'describe: group of shown level');
    assert.equal(od.groupLabel, 'Уверенные', 'describe: Russian group label');
    assert.equal(od.pips, '●●●●●○○', 'describe: pips for L4');
    assert.equal(od.cssClass, 'grp-confident', 'describe: css class');
    assert.equal(od.label, 'АНГ → РУС', 'describe: ru label for en_ru');
    assert.equal(od.short, 'EN → RU', 'describe: short label');
    assert.equal(od.flag, '🇬🇧', 'describe: flag');
    const odEn = SRS.describeDirection(c, 'eng-rus', TODAY, 'en');
    assert.equal(odEn.phrase, '7d overdue', 'describe: English overdue phrase (alias dir accepted)');
    assert.equal(odEn.label, 'EN → RU', 'describe: en lang uses short label');
    const fut = SRS.describeDirection(c, 'ru_en', TODAY, 'ru');
    assert.equal(fut.bucket, 'future', 'describe: due in 3 days → future');
    assert.equal(fut.phrase, 'вернётся через 3 дня', 'describe: Russian future phrase');
    assert.equal(SRS.describeDirection(c, 'ru_en', TODAY, 'en').phrase, 'back in 3d', 'describe: English future phrase');
    const todayDue = SRS.describeDirection(qCard('td', 'ACTIVE', 2, 2, TODAY, TODAY), 'en_ru', TODAY, 'ru');
    assert.equal(todayDue.bucket, 'today', 'describe: due exactly today → today bucket');
    assert.equal(todayDue.phrase, 'повтори сегодня', 'describe: today phrase ru');
    assert.equal(SRS.describeDirection(qCard('td2', 'ACTIVE', 2, 2, TODAY, TODAY), 'en_ru', TODAY, 'en').phrase, 'review today', 'describe: today phrase en');
    const nul = SRS.describeDirection(qCard('nd', 'ACTIVE', 2, 2, null, null), 'en_ru', TODAY, 'ru');
    assert.equal(nul.bucket, 'today', 'describe: ACTIVE with null date → today (fail-open)');
    const bk = SRS.describeDirection(mkBank('bk'), 'en_ru', TODAY, 'ru');
    assert.equal(bk.bucket, 'bank', 'describe: BANK → bank bucket');
    assert.equal(bk.phrase, 'в банке', 'describe: bank phrase ru');
    assert.equal(SRS.describeDirection(mkBank('bk2'), 'en_ru', TODAY, 'en').phrase, 'in the bank', 'describe: bank phrase en');

    const dc = SRS.describeCard(c, TODAY, 'ru');
    assert.equal(dc.group, 'LEARNING', 'describeCard: card group = weakest direction (L1)');
    assert.equal(dc.groupLabel, 'Учимся', 'describeCard: Russian group label');
    assert.deepEqual(J(dc.dueNow), ['en_ru'], 'describeCard: dueNow lists due directions');
    assert.equal(dc.enRu.direction, 'en_ru', 'describeCard: enRu side present');
    assert.equal(dc.ruEn.direction, 'ru_en', 'describeCard: ruEn side present');
    assert.equal(dc.ruEn.level, 1, 'describeCard: ruEn level');
    assert.equal(SRS.describeCard(c, TODAY, 'en').groupLabel, 'Learning', 'describeCard: English group label');
    assert.equal(SRS.describeCard(mkBank('bkc'), TODAY, 'ru').groupLabel, 'Банк', 'describeCard: BANK label');
  });
});

/* ========================================================================== */
/* 11. MIGRATION — normalizeCard matrix (rules 11,12,13,15,16)                 */
/* ========================================================================== */
describe('migration: normalizeCard', () => {

  const EV_NONE = {};
  const EV_EN = { last_tested_eng: '2026-01-05' };
  const EV_RU = { last_tested_rus: '2026-01-05' };
  const EV_BOTH = { last_tested_eng: '2026-01-05', last_tested_rus: '2026-01-05' };
  const EVS = [['none', EV_NONE, false, false], ['en', EV_EN, true, false], ['ru', EV_RU, false, true], ['both', EV_BOTH, true, true]];
  const RULE11_BASE = { '0': 0, '1': 1, '2': 2, '3': 4, '4': 5, '5': 6, '6': 6, 'archive': 6, 'bank': 0 };

  /* Independent implementation of owner rule 11 (the SPEC, not the kernel code). */
  function rule11(boxKey, evEn, evRu, penalizeArchive) {
    const base = RULE11_BASE[boxKey];
    if (base === 0) return { status: 'BANK', en: 0, ru: 0 };
    const archive = (boxKey === '6' || boxKey === 'archive');
    if (archive && !penalizeArchive) return { status: 'ACTIVE', en: 6, ru: 6 };
    return {
      status: 'ACTIVE',
      en: evEn ? base : Math.max(1, base - 1),
      ru: evRu ? base : Math.max(1, base - 1)
    };
  }

  let seq = 0;
  function legacyRaw(boxVal, ev, extra) {
    seq++;
    return Object.assign({ id: 'leg' + seq, word: 'слово' + seq, translation: 'mean' + seq, box: boxVal }, ev, extra || {});
  }

  test('rule 11: full box × evidence × penalizeArchive matrix (string and numeric boxes)', () => {
    const boxKeys = ['0', '1', '2', '3', '4', '5', '6', 'archive', 'bank'];
    let rows = 0;
    for (const boxKey of boxKeys) {
      for (const boxVal of (boxKey === 'archive' || boxKey === 'bank' ? [boxKey, boxKey.toUpperCase()] : [boxKey, Number(boxKey)])) {
        for (const evRow of EVS) {
          for (const pen of [false, true]) {
            const raw = legacyRaw(boxVal, evRow[1]);
            const res = SRS.normalizeCard(raw, TODAY, { penalizeArchive: pen });
            const exp = rule11(boxKey, evRow[2], evRow[3], pen);
            const m = 'rule11 box=' + JSON.stringify(boxVal) + ' ev=' + evRow[0] + ' pen=' + pen;
            rows++;
            assert.equal(res.source, 'legacy', m + ': source legacy');
            assert.equal(res.migrated, true, m + ': migrated flag');
            assert.equal(res.card.status, exp.status, m + ': status');
            assert.equal(res.card.level_en_ru, exp.en, m + ': level_en_ru = evidence ? base : max(1, base-1)');
            assert.equal(res.card.level_ru_en, exp.ru, m + ': level_ru_en = evidence ? base : max(1, base-1)');
            if (exp.status === 'BANK') {
              assert.equal(res.card.next_review_en_ru, null, m + ': rule 6 — BANK dates null');
              assert.equal(res.card.next_review_ru_en, null, m + ': rule 6 — BANK dates null (both)');
            } else {
              assert.equal(res.card.next_review_en_ru, DUE[exp.en], m + ': rule 1 — fresh cadence en_ru');
              assert.equal(res.card.next_review_ru_en, DUE[exp.ru], m + ': rule 1 — fresh cadence ru_en');
            }
            /* penalized issue bookkeeping */
            const penEn = res.issues.indexOf('penalized:en_ru') !== -1;
            const penRu = res.issues.indexOf('penalized:ru_en') !== -1;
            assert.equal(penEn, exp.status === 'ACTIVE' && exp.en !== RULE11_BASE[boxKey], m + ': penalized:en_ru issue iff level differs from base');
            assert.equal(penRu, exp.status === 'ACTIVE' && exp.ru !== RULE11_BASE[boxKey], m + ': penalized:ru_en issue iff level differs from base');
          }
        }
      }
    }
    assert.ok(rows >= 140, 'rule 11 matrix must cover ≥140 rows (got ' + rows + ')');
    /* archive exemption is the ONLY case where evidence is ignored */
    const arch = SRS.normalizeCard(legacyRaw('archive', EV_NONE), TODAY);
    assert.equal(arch.card.level_en_ru, 6, 'rule 11: archive/box6 exempt from the penalty (both directions → 6)');
    assert.equal(arch.card.level_ru_en, 6, 'rule 11: archive exemption covers ru_en too');
    assert.deepEqual(J(arch.issues), [], 'rule 11: exempt archive logs no penalized issues');
    const archPen = SRS.normalizeCard(legacyRaw('archive', EV_EN), TODAY, { penalizeArchive: true });
    assert.equal(archPen.card.level_en_ru, 6, 'penalizeArchive: evidenced direction keeps base');
    assert.equal(archPen.card.level_ru_en, 5, 'penalizeArchive: unevidenced direction drops to max(1,6-1)=5');
    assert.ok(archPen.issues.indexOf('penalized:ru_en') !== -1, 'penalizeArchive: logs penalized:ru_en');
  });

  test('rule 11: out-of-range, negative, unparseable, missing box and srsStage rows', () => {
    const b11 = SRS.normalizeCard(legacyRaw(11, EV_BOTH), TODAY);
    assert.equal(b11.card.level_en_ru, 5, 'box 11 clamps to base 5');
    assert.ok(b11.issues.indexOf('box-out-of-range:11') !== -1, 'box 11 logs box-out-of-range:11');
    const b11n = SRS.normalizeCard(legacyRaw(11, EV_NONE), TODAY);
    assert.equal(b11n.card.level_en_ru, 4, 'box 11 without evidence → max(1,5-1)=4');
    const b7 = SRS.normalizeCard(legacyRaw(7, EV_BOTH), TODAY);
    assert.equal(b7.card.level_en_ru, 5, 'box 7 also clamps to base 5');
    const bneg = SRS.normalizeCard(legacyRaw(-1, EV_NONE), TODAY);
    assert.equal(bneg.card.level_en_ru, 1, 'box -1 → base MIN_REST_LEVEL=1');
    assert.equal(bneg.card.level_ru_en, 1, 'box -1 no evidence → max(1,0)=1');
    assert.ok(bneg.issues.indexOf('box-negative:-1') !== -1, 'box -1 logs box-negative:-1');
    const bxyz = SRS.normalizeCard(legacyRaw('xyz', EV_BOTH), TODAY);
    assert.equal(bxyz.card.status, 'BANK', 'unparseable box → BANK');
    assert.ok(bxyz.issues.indexOf('box-unparseable:"xyz"') !== -1, 'unparseable box logs box-unparseable');
    assert.ok(bxyz.issues.indexOf('no-evidence:banked') !== -1, 'unparseable box logs no-evidence:banked');
    seq++;
    const noBox = { id: 'nb' + seq, word: 'w', translation: 't', next_review_date: '2026-01-01' };
    const nb = SRS.normalizeCard(noBox, TODAY);
    assert.equal(nb.card.status, 'BANK', 'rule 11: missing box (legacy marker only) → BANK');
    assert.equal(nb.source, 'legacy', 'missing box with a v1 marker still migrates as legacy');
    assert.ok(nb.issues.indexOf('no-evidence:banked') !== -1, 'missing box logs no-evidence:banked');
    seq++;
    const flagOnly = { id: 'fo' + seq, word: 'w', translation: 't', eng_to_rus: true };
    const foRes = SRS.normalizeCard(flagOnly, TODAY);
    assert.equal(foRes.card.status, 'BANK', 'documented behaviour: missing box WITH flag evidence still banks (owner rule covers only "missing without evidence")');
    const sp = SRS.normalizeCard(legacyRaw(' 3 ', EV_BOTH), TODAY);
    assert.equal(sp.card.level_en_ru, 4, 'whitespace-padded box " 3 " trims to base 4');

    const stages = [
      ['new', 'BANK', 0, 0],
      ['learning', 'ACTIVE', 1, 1],
      ['review', 'ACTIVE', 3, 3],
      ['mastered', 'ACTIVE', 6, 6],
      ['bank', 'BANK', 0, 0]
    ];
    for (const row of stages) {
      seq++;
      const r = SRS.normalizeCard({ id: 'st' + seq, word: 'w', translation: 't', srsStage: row[0] }, TODAY);
      const m = 'srsStage ' + row[0];
      assert.equal(r.card.status, row[1], m + ': status');
      assert.equal(r.card.level_en_ru, row[2], m + ': level_en_ru (no evidence → penalty applies, mastered exempt)');
      assert.equal(r.card.level_ru_en, row[3], m + ': level_ru_en');
      assert.equal(r.source, 'legacy', m + ': source legacy');
    }
    seq++;
    const bogus = SRS.normalizeCard({ id: 'sb' + seq, word: 'w', translation: 't', srsStage: 'bogus' }, TODAY);
    assert.equal(bogus.card.status, 'BANK', 'bogus stage → BANK');
    assert.ok(bogus.issues.indexOf('stage-unparseable:bogus') !== -1, 'bogus stage logs stage-unparseable');
  });

  test('migration: hasEvidence — primary tested-date, secondary flag, junk tolerance', () => {
    assert.equal(SRS.hasEvidence({ last_tested_eng: '2026-01-05' }, 'en_ru'), true, 'hasEvidence: non-empty tested date (primary)');
    assert.equal(SRS.hasEvidence({ last_tested_eng: '   ' }, 'en_ru'), false, 'hasEvidence: whitespace-only date is NOT evidence');
    assert.equal(SRS.hasEvidence({ last_tested_eng: '' }, 'en_ru'), false, 'hasEvidence: empty string is NOT evidence');
    assert.equal(SRS.hasEvidence({ last_tested_eng: 123 }, 'en_ru'), true, 'hasEvidence: truthy non-string tested value counts');
    assert.equal(SRS.hasEvidence({ eng_to_rus: true }, 'en_ru'), true, 'hasEvidence: truthy legacy flag (secondary)');
    assert.equal(SRS.hasEvidence({ eng_to_rus: false }, 'en_ru'), false, 'hasEvidence: false flag is no evidence');
    assert.equal(SRS.hasEvidence({}, 'ru_en'), false, 'hasEvidence: nothing → false');
    assert.equal(SRS.hasEvidence({ last_tested_rus: '2026-01-05' }, 'rus-eng'), true, 'hasEvidence: direction alias accepted');
    assert.equal(SRS.hasEvidence({ last_tested_eng: '2026-01-05' }, 'ru_en'), false, 'hasEvidence: fields are direction-specific');
  });

  test('migration: counters — repetitions when present, base fallback, bank row', () => {
    const withRep = SRS.normalizeCard(legacyRaw(3, EV_BOTH, { repetitions: 9 }), TODAY);
    assert.equal(withRep.card.review_count, 9, 'review_count taken from legacy repetitions');
    const noRep = SRS.normalizeCard(legacyRaw(3, EV_BOTH), TODAY);
    assert.equal(noRep.card.review_count, 4, 'review_count falls back to max(0, base) = 4 for box 3');
    const bankRep = SRS.normalizeCard(legacyRaw(0, EV_NONE, { repetitions: 5 }), TODAY);
    assert.equal(bankRep.card.review_count, 5, 'BANK row keeps repetitions as review_count');
    const attest = SRS.normalizeCard(legacyRaw('bank', EV_EN), TODAY);
    assert.ok(attest.issues.indexOf('bank_with_attestation') !== -1, 'bank box WITH evidence logs bank_with_attestation');
    assert.equal(attest.card.status, 'BANK', 'bank box with evidence still BANK');
  });

  test('rule 12: stagger charges the overdue legacy date EXACTLY ONCE onto the weaker direction', () => {
    const DEBT = '2026-09-10';
    /* tie (4/4) → debt goes to en_ru */
    const tie = SRS.normalizeCard(legacyRaw(3, EV_BOTH, { next_review_date: DEBT }), TODAY);
    assert.equal(tie.card.level_en_ru, 4, 'stagger tie: en level 4');
    assert.equal(tie.card.level_ru_en, 4, 'stagger tie: ru level 4');
    assert.equal(tie.card.next_review_en_ru, DEBT, 'rule 12: tie → debt charged onto en_ru');
    assert.equal(tie.card.next_review_ru_en, DUE[4], 'rule 12: stronger side gets fresh today+INTERVALS[4]');
    assert.ok(tie.issues.indexOf('overdue-carried:' + DEBT) !== -1, 'rule 12: overdue-carried issue logged once');
    assert.equal(tie.issues.filter((i) => i.indexOf('overdue-carried') === 0).length, 1, 'rule 12: debt charged exactly once per card');
    /* asymmetric: only ru evidenced → en penalized to 3 → en is weaker → debt onto en_ru */
    const asym1 = SRS.normalizeCard(legacyRaw(3, EV_RU, { next_review_date: DEBT }), TODAY);
    assert.equal(asym1.card.level_en_ru, 3, 'stagger asym: penalized en = 3');
    assert.equal(asym1.card.level_ru_en, 4, 'stagger asym: evidenced ru = 4');
    assert.equal(asym1.card.next_review_en_ru, DEBT, 'rule 12: weaker (en L3) absorbs the debt');
    assert.equal(asym1.card.next_review_ru_en, DUE[4], 'rule 12: stronger fresh');
    /* only en evidenced → ru penalized to 3 → ru weaker → debt onto ru_en */
    const asym2 = SRS.normalizeCard(legacyRaw(3, EV_EN, { next_review_date: DEBT }), TODAY);
    assert.equal(asym2.card.level_ru_en, 3, 'stagger asym2: penalized ru = 3');
    assert.equal(asym2.card.next_review_ru_en, DEBT, 'rule 12: weaker (ru L3) absorbs the debt');
    assert.equal(asym2.card.next_review_en_ru, DUE[4], 'rule 12: stronger fresh (asym2)');
    /* not overdue: today / future / garbage / missing → both fresh, no debt issue */
    for (const due of [TODAY, '2026-10-01', 'garbage', undefined]) {
      const extra = due === undefined ? {} : { next_review_date: due };
      const r = SRS.normalizeCard(legacyRaw(3, EV_BOTH, extra), TODAY);
      const m = 'rule 12 non-overdue due=' + JSON.stringify(due);
      assert.equal(r.card.next_review_en_ru, DUE[4], m + ': fresh cadence en');
      assert.equal(r.card.next_review_ru_en, DUE[4], m + ': fresh cadence ru');
      assert.ok(!r.issues.some((i) => i.indexOf('overdue-carried') === 0), m + ': no overdue-carried issue');
    }
    /* duePolicy fresh forgives the debt */
    const fresh = SRS.normalizeCard(legacyRaw(3, EV_BOTH, { next_review_date: DEBT }), TODAY, { duePolicy: 'fresh' });
    assert.equal(fresh.card.next_review_en_ru, DUE[4], 'rule 12 fresh: en gets fresh cadence');
    assert.equal(fresh.card.next_review_ru_en, DUE[4], 'rule 12 fresh: ru gets fresh cadence');
    /* explicit stagger equals default */
    const stag = SRS.normalizeCard(legacyRaw(3, EV_BOTH, { next_review_date: DEBT }), TODAY, { duePolicy: 'stagger' });
    assert.equal(stag.card.next_review_en_ru, DEBT, 'rule 12: explicit stagger === default');
  });

  test('rule 13: hybrid v2-wins — box discarded WITHOUT recomputation', () => {
    const raw = deepFreeze({
      id: 'hy1', word: 'w', translation: 't', status: 'ACTIVE',
      level_en_ru: 4, level_ru_en: 2,
      next_review_en_ru: '2026-10-01', next_review_ru_en: '2026-09-20',
      box: 1, repetitions: 3
    });
    const res = SRS.normalizeCard(raw, TODAY);
    assert.equal(res.source, 'hybrid', 'hybrid: v2 fields + junk box → source hybrid');
    assert.equal(res.migrated, true, 'hybrid: counts as migrated');
    assert.equal(res.card.level_en_ru, 4, 'rule 13: v2 levels WIN (box 1 must NOT drag en_ru down)');
    assert.equal(res.card.level_ru_en, 2, 'rule 13: v2 levels WIN (ru_en untouched by box)');
    assert.equal(res.card.next_review_en_ru, '2026-10-01', 'rule 13: valid v2 dates kept verbatim');
    assert.equal(res.card.next_review_ru_en, '2026-09-20', 'rule 13: valid v2 dates kept verbatim (both)');
    assert.ok(!('box' in res.card), 'rule 15: junk box discarded');
    assert.ok(!('repetitions' in res.card), 'rule 15: repetitions discarded');
    assert.ok(res.issues.indexOf('half-migrated:v2-wins') !== -1, 'hybrid: logs half-migrated:v2-wins');
    assert.equal(raw.box, 1, 'hybrid: frozen input survived (box still on the INPUT, dropped from output)');

    const broken = SRS.normalizeCard({ id: 'hy2', word: 'w', translation: 't', status: 'ACTIVE', level_en_ru: 'x', level_ru_en: 3, next_review_en_ru: 'nope', next_review_ru_en: '2026-09-20', box: 5 }, TODAY);
    assert.equal(broken.card.level_en_ru, 0, 'hybrid: invalid v2 level resets to 0 (never recomputed from box 5!)');
    assert.equal(broken.card.level_ru_en, 3, 'hybrid: valid v2 level kept');
    assert.equal(broken.card.next_review_en_ru, TODAY, 'hybrid: broken date repaired to today');
    assert.ok(broken.issues.indexOf('level_en_ru:reset') !== -1, 'hybrid: logs level_en_ru:reset');

    const bankHy = SRS.normalizeCard({ id: 'hy3', word: 'w', translation: 't', status: 'BANK', level_en_ru: 3, level_ru_en: 3, next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-09-20', box: 2 }, TODAY);
    assert.equal(bankHy.card.status, 'BANK', 'hybrid BANK stays BANK');
    assert.equal(bankHy.card.next_review_en_ru, null, 'rule 6: hybrid BANK dates nulled');
    assert.equal(bankHy.card.level_en_ru, 3, 'hybrid BANK keeps v2 levels');
  });

  test('migration: native v2 passthrough, clamping, date repair, BANK normalization', () => {
    const good = deepFreeze({
      id: 'n1', word: 'w', translation: 't', phonetic: 'p', example: 'e',
      example_translation: 'et', part_of_speech: 'noun', batch_id: 'b', batch_name: 'bn',
      created_at: '2026-01-01', status: 'ACTIVE', level_en_ru: 3, level_ru_en: 5,
      next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-10-01',
      fail_count: 2, review_count: 8
    });
    const nat = SRS.normalizeCard(good, TODAY);
    assert.equal(nat.source, 'native', 'native: pure v2 → source native');
    assert.equal(nat.migrated, false, 'native: NOT counted as migrated (idempotency fuel)');
    assert.deepEqual(J(nat.card), Object.assign(J(good), { partOfSpeech: 'noun' }), 'native: card content byte-identical (finalizeContent only gap-fills the missing camel POS spelling)');
    assert.equal(nat.card.partOfSpeech, 'noun', 'native: partOfSpeech gap-filled from part_of_speech');
    assert.deepEqual(J(nat.issues), [], 'native: no issues');
    assert.deepEqual(J(good), J({
      id: 'n1', word: 'w', translation: 't', phonetic: 'p', example: 'e',
      example_translation: 'et', part_of_speech: 'noun', batch_id: 'b', batch_name: 'bn',
      created_at: '2026-01-01', status: 'ACTIVE', level_en_ru: 3, level_ru_en: 5,
      next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-10-01',
      fail_count: 2, review_count: 8
    }), 'native: frozen input never mutated');

    const clamp = SRS.normalizeCard({ id: 'n2', word: 'w', translation: 't', status: 'ACTIVE', level_en_ru: 9, level_ru_en: -3, next_review_en_ru: TODAY, next_review_ru_en: TODAY }, TODAY);
    assert.equal(clamp.card.level_en_ru, 6, 'native: level 9 clamps to MAX_LEVEL');
    assert.equal(clamp.card.level_ru_en, 0, 'native: level -3 clamps to 0');
    const rep = SRS.normalizeCard({ id: 'n3', word: 'w', translation: 't', status: 'ACTIVE', level_en_ru: 2, level_ru_en: 2, next_review_en_ru: 'garbage', next_review_ru_en: '2026-09-20', created_at: '2026-01-01' }, TODAY);
    assert.equal(rep.card.next_review_en_ru, TODAY, 'native: unparseable date repaired to today');
    assert.ok(rep.issues.indexOf('date-repaired:next_review_en_ru') !== -1, 'native: repair logged');
    const repFut = SRS.normalizeCard({ id: 'n4', word: 'w', translation: 't', status: 'ACTIVE', level_en_ru: 2, level_ru_en: 2, next_review_en_ru: null, next_review_ru_en: TODAY, created_at: '2026-12-01' }, TODAY);
    assert.equal(repFut.card.next_review_en_ru, '2026-12-01', 'native: future created_at wins the date repair');
    const bankV2 = SRS.normalizeCard({ id: 'n5', word: 'w', translation: 't', status: 'BANK', level_en_ru: 3, level_ru_en: 3, next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-09-20' }, TODAY);
    assert.equal(bankV2.card.next_review_en_ru, null, 'rule 6: native BANK gets dates nulled');
    assert.equal(bankV2.source, 'native', 'BANK v2 is native');
    const weird = SRS.normalizeCard({ id: 'n6', word: 'w', translation: 't', status: 'WEIRD', level_en_ru: 1, level_ru_en: 1 }, TODAY);
    assert.equal(weird.card.status, 'BANK', 'native: unknown status demotes to BANK');
    assert.equal(weird.card.next_review_en_ru, null, 'demoted BANK: dates nulled');
    const extra = SRS.normalizeCard({ id: 'n7', word: 'w', translation: 't', status: 'ACTIVE', level_en_ru: 1, level_ru_en: 1, next_review_en_ru: TODAY, next_review_ru_en: TODAY, custom_note: 'keep', tags: ['a'] }, TODAY);
    assert.equal(extra.card.custom_note, 'keep', 'native: unknown extras preserved');
    assert.deepEqual(J(extra.card.tags), ['a'], 'native: unknown array extras preserved');
  });

  test('migration: synth (content-only) → BANK; junk → card null; bad today throws', () => {
    const syn = SRS.normalizeCard({ id: 'sy1', word: 'fresh', translation: 'свежее', created_at: '2026-09-01' }, TODAY);
    assert.equal(syn.source, 'synth', 'synth: no schedule fields at all → source synth');
    assert.equal(syn.migrated, true, 'synth: counts as migrated');
    assert.equal(syn.card.status, 'BANK', 'rule 6: fresh content lands strictly in BANK');
    assert.equal(syn.card.level_en_ru, 0, 'synth: levels 0');
    assert.equal(syn.card.next_review_en_ru, null, 'synth: dates null');
    assert.equal(syn.card.fail_count, 0, 'synth: counters zeroed');
    assert.ok(syn.issues.indexOf('no-schedule-fields:banked') !== -1, 'synth: issue logged');
    const empty = SRS.normalizeCard({}, TODAY);
    assert.equal(empty.source, 'synth', 'empty object → synth');
    assert.ok(String(empty.card.id).startsWith('card_mig_'), 'synth: id-less card gets a deterministic card_mig_* id');
    for (const junk of [null, undefined, 42, 'string', true, [], [{ id: 'x' }]]) {
      const r = SRS.normalizeCard(junk, TODAY);
      assert.equal(r.card, null, 'junk ' + JSON.stringify(junk) + ': card null');
      assert.equal(r.source, 'junk', 'junk ' + JSON.stringify(junk) + ': source junk');
      assert.equal(r.migrated, false, 'junk: not migrated');
      assert.deepEqual(J(r.issues), ['not-an-object'], 'junk: issue not-an-object');
    }
    assert.throws(() => SRS.normalizeCard({}, 'bad-today'), TypeError, 'normalizeCard: junk today throws TypeError');
    assert.throws(() => SRS.normalizeCard({}, undefined), TypeError, 'normalizeCard: missing today throws TypeError');
  });

  test('migration: frozen legacy input is never mutated', () => {
    const raw = deepFreeze({ id: 'fz1', word: 'w', translation: 't', box: 4, last_tested_eng: '2026-01-01', next_review_date: '2026-09-10', repetitions: 2 });
    const snap = J(raw);
    SRS.normalizeCard(raw, TODAY);
    assert.deepEqual(J(raw), snap, 'normalizeCard: deep-frozen legacy input survives untouched');
  });

  test('rules 15+16: dead fields stripped, content preserved byte-for-byte, arrays never flattened', () => {
    const raw = {
      id: 'cp1', word: '  Spaced  Word  ', phonetic: '[p]', translation: 'Перевод — «тест»',
      example: '', example_translation: 'пример', part_of_speech: ['noun', 'verb'],
      batch_id: 'bid-9', batch_name: 'Девятая партия', created_at: '2025-12-31',
      custom_note: 'keep me',
      box: 3, srsStage: 'review', interval: 7, easeFactor: 2.5, repetitions: 4,
      dueDate: '2026-01-01', eng_to_rus: true, rus_to_eng: false,
      last_tested: '2026-01-01', last_tested_eng: '2026-01-05', last_tested_rus: '2026-01-06',
      next_review_date: '2026-09-10', knowledge_group: 'FAMILIAR', level: 9, stage: 'x'
    };
    const snap = J(raw);
    const res = SRS.normalizeCard(raw, TODAY);
    for (const f of SRS.DEPRECATED_FIELDS) {
      assert.ok(!(f in res.card), 'rule 15: deprecated field `' + f + '` must be absent from the normalized card');
    }
    assert.ok(!('knowledge_group' in res.card), 'rule 15: knowledge_group is derived, never stored');
    assert.equal(res.card.word, snap.word, 'rule 16: word byte-for-byte (spaces kept)');
    assert.equal(res.card.translation, snap.translation, 'rule 16: translation byte-for-byte (unicode kept)');
    assert.equal(res.card.phonetic, '[p]', 'rule 16: phonetic kept');
    assert.equal(res.card.example, '', 'rule 16: empty-string example preserved as empty string');
    assert.equal(res.card.example_translation, 'пример', 'rule 16: example_translation kept');
    assert.equal(res.card.batch_id, 'bid-9', 'rule 16: batch_id kept');
    assert.equal(res.card.batch_name, 'Девятая партия', 'rule 16: batch_name kept');
    assert.equal(res.card.created_at, '2025-12-31', 'rule 16: created_at kept');
    assert.equal(res.card.custom_note, 'keep me', 'rule 16: unknown extras kept');
    assert.ok(Array.isArray(res.card.part_of_speech), 'rule 16: array part_of_speech stays an ARRAY');
    assert.deepEqual(J(res.card.part_of_speech), ['noun', 'verb'], 'rule 16: array contents byte-for-byte');
    assert.deepEqual(J(res.card.partOfSpeech), ['noun', 'verb'], 'rule 16: gap-filled camel spelling copies the ARRAY, never flattens it');
    assert.equal(res.card.review_count, 4, 'repetitions folded into review_count before being dropped');
    assert.deepEqual(J(raw), snap, 'rules 15/16: input object never mutated');

    /* the other gap-fill direction: camel array → snake */
    const camel = SRS.normalizeCard({ id: 'cp2', word: 'w', translation: 't', partOfSpeech: ['gerund'], box: 1, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' }, TODAY);
    assert.ok(Array.isArray(camel.card.part_of_speech), 'rule 16: snake spelling gap-filled from camel ARRAY stays an array');
    assert.deepEqual(J(camel.card.part_of_speech), ['gerund'], 'rule 16: gap-fill copies array verbatim');
    /* string gap-fill */
    const strFill = SRS.normalizeCard({ id: 'cp3', word: 'w', translation: 't', part_of_speech: '', partOfSpeech: 'noun / verb', box: 1, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' }, TODAY);
    assert.equal(strFill.card.part_of_speech, 'noun / verb', 'POS gap-fill: empty snake takes the camel string');
    /* content preservation through the NATIVE and HYBRID paths too */
    const natArr = SRS.normalizeCard({ id: 'cp4', word: 'w', translation: 't', part_of_speech: ['noun', 'verb'], status: 'ACTIVE', level_en_ru: 1, level_ru_en: 1, next_review_en_ru: TODAY, next_review_ru_en: TODAY }, TODAY);
    assert.deepEqual(J(natArr.card.part_of_speech), ['noun', 'verb'], 'rule 16: native path keeps the array');
    const hybArr = SRS.normalizeCard({ id: 'cp5', word: 'w', translation: 't', part_of_speech: ['noun', 'verb'], status: 'ACTIVE', level_en_ru: 1, level_ru_en: 1, next_review_en_ru: TODAY, next_review_ru_en: TODAY, box: 0 }, TODAY);
    assert.deepEqual(J(hybArr.card.part_of_speech), ['noun', 'verb'], 'rule 16: hybrid path keeps the array');
  });

  test('rule 13: normalizeCard idempotency — second and third passes are native no-ops', () => {
    const cases = [
      ['legacy-active', legacyRaw(3, EV_BOTH, { next_review_date: '2026-09-10' }), {}],
      ['legacy-bank', legacyRaw(0, EV_NONE), {}],
      ['legacy-archive', legacyRaw('archive', EV_NONE), {}],
      ['legacy-pen-archive', legacyRaw(6, EV_EN), { penalizeArchive: true }],
      ['hybrid', { id: 'idem-h', word: 'w', translation: 't', status: 'ACTIVE', level_en_ru: 4, level_ru_en: 2, next_review_en_ru: '2026-10-01', next_review_ru_en: '2026-09-20', box: 1 }, {}],
      ['synth', { id: 'idem-s', word: 'w', translation: 't' }, {}]
    ];
    for (const row of cases) {
      const p1 = SRS.normalizeCard(row[1], TODAY, row[2]);
      const p2 = SRS.normalizeCard(p1.card, TODAY, row[2]);
      const p3 = SRS.normalizeCard(p2.card, TODAY, row[2]);
      const m = 'idempotency[' + row[0] + ']';
      assert.equal(p2.source, 'native', m + ': pass 2 recognizes v2 as native');
      assert.equal(p2.migrated, false, m + ': pass 2 migrated=false');
      assert.deepEqual(J(p2.card), J(p1.card), m + ': pass 2 card deep-equals pass 1');
      assert.equal(p3.source, 'native', m + ': pass 3 native');
      assert.equal(p3.migrated, false, m + ': pass 3 migrated=false');
      assert.deepEqual(J(p3.card), J(p1.card), m + ': pass 3 card deep-equals pass 1');
    }
  });
});

/* ========================================================================== */
/* 12. MIGRATION — migrateState / mergeRecords / loss guard (rules 13,14)      */
/* ========================================================================== */
describe('migration: migrateState', () => {

  function st(cards, extraRoot) {
    return Object.assign({ cards: cards, schema_version: 1, settings: { theme: 'dark' }, deleted_ids: ['zz'], history: [{ d: 1 }] }, extraRoot || {});
  }

  test('rule 14: de-dupe only on word AND translation; homographs both survive', () => {
    const s = st([
      { id: 'd1', word: 'Run', translation: 'бежать', box: 2, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' },
      { id: 'd2', word: 'run ', translation: 'БЕЖАТЬ', box: 4, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' },
      { id: 'h1', word: 'resilience', translation: 'устойчивость', box: 1, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' },
      { id: 'h2', word: 'resilience', translation: 'жизнестойкость', box: 0 },
      { id: 't1', word: 'unique1', translation: 'shared', box: 1, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' },
      { id: 't2', word: 'unique2', translation: 'shared', box: 1, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' },
      null, 42
    ]);
    const m = SRS.migrateState(s, TODAY);
    const ids = m.state.cards.map((c) => c.id);
    assert.equal(m.report.scanned, 8, 'migrateState: scanned counts every input row');
    assert.equal(m.report.junk, 2, 'migrateState: null and 42 counted as junk');
    assert.equal(m.report.bySource.junk, 2, 'migrateState: bySource.junk');
    assert.equal(m.state.cards.length, 5, 'rule 14: d1+d2 merge; homographs h1/h2 and same-translation t1/t2 all survive');
    assert.deepEqual(J(ids), ['d1', 'h1', 'h2', 't1', 't2'], 'rule 14: winner keeps its id and position');
    assert.deepEqual(J(m.report.lostIds), ['d2'], 'rule 14: lostIds lists the id absorbed by the merge');
    const explainedIds = new Set();
    m.report.collisions.forEach((col) => col.ids.forEach((x) => explainedIds.add(x)));
    for (const lost of m.report.lostIds) {
      assert.ok(explainedIds.has(lost), 'rule 14: every lost id must be explained by a collision (no unexplained loss)');
    }
    assert.equal(m.report.collisions.length, 1, 'rule 14: exactly one collision logged');
    assert.deepEqual(J(m.report.collisions[0]), { kind: 'word+translation', word: 'run ', ids: ['d1', 'd2'] }, 'rule 14: collision names the merged pair');
    const merged = m.state.cards[0];
    assert.equal(merged.level_en_ru, 5, 'rule 14 merge: progress survives — max level per direction (box4+ev → 5)');
    assert.equal(merged.level_ru_en, 5, 'rule 14 merge: max level ru_en');
    assert.equal(merged.word, 'Run', 'rule 14 merge: winner content kept (not overwritten by loser)');
    assert.ok(m.report.issues.some((i) => i.indexOf('junk@6') !== -1), 'migrateState: junk@index logged');
    /* word+translation matching is case/whitespace-normalized */
    const h1 = m.state.cards.find((c) => c.id === 'h1');
    const h2 = m.state.cards.find((c) => c.id === 'h2');
    assert.equal(h1.status, 'ACTIVE', 'homograph h1 stays ACTIVE');
    assert.equal(h2.status, 'BANK', 'homograph h2 (box 0) stays BANK — different meaning, different fate');
  });

  test('rule 14: duplicate ids merge with collision kind "id"', () => {
    const s = st([
      { id: 'same', word: 'a', translation: 'b', status: 'ACTIVE', level_en_ru: 1, level_ru_en: 1, next_review_en_ru: TODAY, next_review_ru_en: TODAY },
      { id: 'same', word: 'a', translation: 'b', status: 'ACTIVE', level_en_ru: 3, level_ru_en: 0, next_review_en_ru: TODAY, next_review_ru_en: TODAY }
    ]);
    const m = SRS.migrateState(s, TODAY);
    assert.equal(m.state.cards.length, 1, 'duplicate ids collapse to one card');
    assert.equal(m.state.cards[0].level_en_ru, 3, 'duplicate-id merge keeps max level en_ru');
    assert.equal(m.state.cards[0].level_ru_en, 1, 'duplicate-id merge keeps max level ru_en');
    assert.deepEqual(J(m.report.collisions), [{ kind: 'id', word: 'a', ids: ['same', 'same'] }], 'duplicate-id collision logged');
    assert.deepEqual(J(m.report.lostIds), [], 'no unexplained loss');
  });

  test('rule 14: migrateState throws CARD LOSS DETECTED on unexplained id loss', () => {
    const withIdJunk = ['elem'];
    withIdJunk.id = 'arr1';                    // array raw = junk, but it carries an id → unexplained loss
    assert.throws(
      () => SRS.migrateState({ cards: [{ id: 'ok1', word: 'w', translation: 't', box: 1, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' }, withIdJunk] }, TODAY),
      /CARD LOSS DETECTED/,
      'rule 14: junk row with an id must trip the loss guard');
    assert.throws(() => SRS.assertNoCardLoss(['a', 'b'], [{ id: 'a' }]), /CARD LOSS DETECTED/, 'assertNoCardLoss: missing id throws');
    assert.throws(() => SRS.assertNoCardLoss(['a', 'a'], [{ id: 'a' }]), /CARD COUNT CHANGED/, 'assertNoCardLoss: count change throws');
    assert.equal(SRS.assertNoCardLoss(['a'], [{ id: 'a' }]), true, 'assertNoCardLoss: clean pass → true');
    assert.equal(SRS.assertNoCardLoss([], []), true, 'assertNoCardLoss: empty pass → true');
    assert.throws(() => SRS.migrateState(null, TODAY), TypeError, 'migrateState: null state throws TypeError');
    assert.throws(() => SRS.migrateState({ cards: [] }, 'nope'), TypeError, 'migrateState: junk today throws TypeError');
  });

  test('migrateState: root rebuild via spread — unknown keys survive, schema/migrated_at stamped', () => {
    const s = st([
      { id: 'p1', word: 'p1', translation: 't', box: 3, next_review_date: '2026-09-10' },
      { id: 'p2', word: 'p2', translation: 't', box: 2, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01', next_review_date: '2026-09-01' }
    ]);
    const m = SRS.migrateState(s, TODAY);
    assert.equal(m.state.schema_version, 2, 'root: schema_version stamped to 2');
    assert.equal(m.state.migrated_at, TODAY, 'root: migrated_at stamped on first migration');
    assert.deepEqual(J(m.state.settings), { theme: 'dark' }, 'root: unknown key settings survives the spread');
    assert.deepEqual(J(m.state.deleted_ids), ['zz'], 'root: tombstones survive');
    assert.deepEqual(J(m.state.history), [{ d: 1 }], 'root: history survives');
    assert.equal(m.migratedCount, 2, 'both legacy rows counted as migrated');
    assert.equal(m.report.keptCount, 2, 'keptCount');
    /* report counters */
    assert.deepEqual(J(m.report.penalized), { en_ru: 1, ru_en: 1 }, 'report: p1 (box3, no evidence) penalizes both directions');
    assert.equal(m.report.overdueCarried, 2, 'report: both cards carried an overdue legacy date');
    assert.deepEqual(J(m.report.byStatus), { ACTIVE: 2, BANK: 0 }, 'report: byStatus');
    assert.deepEqual(J(m.report.byGroup), { BANK: 0, NEW: 0, LEARNING: 0, FAMILIAR: 2, CONFIDENT: 0, MASTERED: 0 }, 'report: byGroup (3/3 → FAMILIAR, 2/2 → FAMILIAR)');
    assert.deepEqual(J(m.report.levelHist.en_ru), [0, 0, 1, 1, 0, 0, 0], 'report: en_ru histogram');
    assert.deepEqual(J(m.report.levelHist.ru_en), [0, 0, 1, 1, 0, 0, 0], 'report: ru_en histogram');
    assert.deepEqual(J(m.report.droppedFields), { box: 2, next_review_date: 2, last_tested_eng: 1, last_tested_rus: 1 }, 'report: droppedFields counts per dead field');
    const p1 = m.state.cards[0];
    assert.equal(p1.next_review_en_ru, '2026-09-10', 'rule 12: p1 debt onto weaker en_ru (3/3 tie)');
    assert.equal(p1.next_review_ru_en, DUE[3], 'rule 12: p1 stronger side fresh today+4');
    assert.ok(m.report.issues.indexOf('p1: penalized:en_ru') !== -1, 'report: issues prefixed with card id');
    /* independent recompute consistency */
    const sum = SRS.summarize(m.state.cards, TODAY);
    assert.equal(sum.active, m.report.byStatus.ACTIVE, 'report vs summarize: active agrees');
  });

  test('rule 13: migrateState idempotency — pass 2/3 native, deep-equal, migratedCount 0', () => {
    const s = st([
      { id: 'i1', word: 'w1', translation: 't1', box: 5, last_tested_eng: '2026-01-01', next_review_date: '2026-09-10' },
      { id: 'i2', word: 'w2', translation: 't2', box: 0 },
      { id: 'i3', word: 'w3', translation: 't3', status: 'ACTIVE', level_en_ru: 2, level_ru_en: 4, next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-10-01' },
      { id: 'i4', word: 'w4', translation: 't4', part_of_speech: ['noun', 'verb'] }
    ]);
    const p1 = SRS.migrateState(s, TODAY);
    const p2 = SRS.migrateState(p1.state, TODAY);
    const p3 = SRS.migrateState(p2.state, TODAY);
    assert.equal(p1.migratedCount, 3, 'pass 1: i1,i2 legacy + i4 synth migrate; i3 native');
    assert.equal(p1.report.bySource.native, 1, 'pass 1: one native row');
    assert.equal(p2.migratedCount, 0, 'rule 13: pass 2 migratedCount === 0');
    assert.equal(p2.report.bySource.native, p1.state.cards.length, 'rule 13: pass 2 bySource.native === cards.length');
    assert.deepEqual(J(p2.state.cards), J(p1.state.cards), 'rule 13: pass 2 cards deep-equal pass 1');
    assert.equal(p3.migratedCount, 0, 'rule 13: pass 3 migratedCount === 0');
    assert.deepEqual(J(p3.state.cards), J(p1.state.cards), 'rule 13: pass 3 cards deep-equal pass 1');
    assert.equal(p2.state.migrated_at, TODAY, 'migrated_at not re-stamped when already a date');
    assert.deepEqual(J(p1.state.cards[3].part_of_speech), ['noun', 'verb'], 'rule 16: array POS survives migration');
    assert.deepEqual(J(p2.state.cards[3].part_of_speech), ['noun', 'verb'], 'rule 16: array POS survives pass 2');
    const stamped = SRS.migrateState(st([{ id: 'x1', word: 'w', translation: 't', box: 1 }], { migrated_at: '2020-05-05' }), TODAY);
    assert.equal(stamped.state.migrated_at, '2020-05-05', 'pre-existing migrated_at is never overwritten');
    /* input state object untouched */
    const input = st([{ id: 'y1', word: 'w', translation: 't', box: 1, last_tested_eng: '2026-01-01', last_tested_rus: '2026-01-01' }]);
    const snap = J(input);
    SRS.migrateState(input, TODAY);
    assert.deepEqual(J(input), snap, 'migrateState: input state never mutated');
  });

  test('mergeRecords: max levels, winner dates, earlier on tie, gap-fill, counters, junk tolerance', () => {
    const A = deepFreeze({ id: 'A', status: 'ACTIVE', level_en_ru: 2, level_ru_en: 5, next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-10-01', word: 'w', translation: 't', fail_count: 3, review_count: 9, created_at: '2026-01-05' });
    const B = deepFreeze({ id: 'B', status: 'BANK', level_en_ru: 4, level_ru_en: 1, next_review_en_ru: null, next_review_ru_en: null, word: 'w', translation: 't', phonetic: 'p', fail_count: 1, review_count: 12, created_at: '2026-01-02', box: 3 });
    const m = SRS.mergeRecords(A, B, TODAY);
    assert.equal(m.id, 'A', 'merge: winner id kept');
    assert.equal(m.status, 'ACTIVE', 'merge: ACTIVE beats BANK');
    assert.equal(m.level_en_ru, 4, 'merge: max level en_ru');
    assert.equal(m.level_ru_en, 5, 'merge: max level ru_en');
    assert.equal(m.next_review_en_ru, '2026-09-24', 'merge: winning level 4 came from B whose date was null → fresh today+INTERVALS[4]');
    assert.equal(m.next_review_ru_en, '2026-10-01', 'merge: winning level 5 came from A → A date kept');
    assert.equal(m.fail_count, 3, 'merge: max fail_count');
    assert.equal(m.review_count, 12, 'merge: max review_count');
    assert.equal(m.created_at, '2026-01-02', 'merge: earlier created_at wins');
    assert.equal(m.phonetic, 'p', 'merge: empty content gap-filled from loser');
    assert.ok(!('box' in m), 'rule 15: merge strips deprecated fields');
    assert.equal(m.example, '', 'merge: finalizeContent gap-fills missing example with empty string');
    assert.deepEqual(J(A).level_en_ru === 2 && true, true, 'merge: frozen A untouched');
    assert.equal(A.next_review_en_ru, '2026-09-20', 'merge: frozen A date untouched');

    /* level tie → earlier date wins */
    const T1 = { id: 'T1', status: 'ACTIVE', level_en_ru: 2, level_ru_en: 2, next_review_en_ru: '2026-09-25', next_review_ru_en: '2026-09-25', word: 'w', translation: 't' };
    const T2 = { id: 'T2', status: 'ACTIVE', level_en_ru: 2, level_ru_en: 2, next_review_en_ru: '2026-09-20', next_review_ru_en: '2026-09-30', word: 'w', translation: 't' };
    const mt = SRS.mergeRecords(T1, T2, TODAY);
    assert.equal(mt.next_review_en_ru, '2026-09-20', 'merge: level tie → earlier date (so the review is not missed)');
    assert.equal(mt.next_review_ru_en, '2026-09-25', 'merge: level tie → earlier date (ru side)');
    /* both BANK → BANK with null dates */
    const mb = SRS.mergeRecords(
      { id: 'B1', status: 'BANK', level_en_ru: 2, level_ru_en: 0, next_review_en_ru: null, next_review_ru_en: null, word: 'w', translation: 't' },
      { id: 'B2', status: 'BANK', level_en_ru: 0, level_ru_en: 3, next_review_en_ru: null, next_review_ru_en: null, word: 'w', translation: 't' },
      TODAY);
    assert.equal(mb.status, 'BANK', 'merge: BANK+BANK stays BANK');
    assert.equal(mb.level_en_ru, 2, 'merge: BANK keeps max levels for when it reactivates');
    assert.equal(mb.level_ru_en, 3, 'merge: BANK max levels (ru)');
    assert.equal(mb.next_review_en_ru, null, 'rule 6: merged BANK dates null');
    /* junk tolerance */
    assert.equal(SRS.mergeRecords(null, B, TODAY), B, 'merge: null a → b');
    assert.equal(SRS.mergeRecords(A, null, TODAY), A, 'merge: null b → a');
  });
});

/* ========================================================================== */
/* 13. REAL-DATA GOLDENS — data/leitner_data.json, 198 cards, today 2026-09-17 */
/* ========================================================================== */
describe('real-data golden (198 cards)', () => {

  function needReal(t) {
    const real = loadReal();
    if (!real) { t.skip('data/leitner_data.json missing or unreadable — real-data golden skipped'); return null; }
    return real;
  }

  test('golden: the legacy source keeps its UTF-8 BOM so stripBom stays covered', (t) => {
    const real = needReal(t); if (!real) return;
    if (real.raw.charCodeAt(0) === 0xFEFF) {
      assert.throws(() => JSON.parse(real.raw), 'golden: JSON.parse without stripBom must fail (main.js contract)');
      assert.equal(SRS.stripBom(real.raw).charCodeAt(0), '{'.charCodeAt(0), 'stripBom removes exactly the BOM');
    } else {
      // Снапшот leitner_data.pre-srs.json пишется уже без BOM — тогда stripBom
      // покрывается отдельными тестами модуля, а здесь проверяем только содержимое.
      assert.doesNotThrow(() => JSON.parse(real.raw), 'a BOM-free legacy source must parse directly');
    }
    assert.equal(real.state.cards.length, 198, 'golden: the legacy base holds exactly 198 cards');
    for (const k of ['history', 'streak', 'custom_groups']) {
      assert.ok(k in real.state, 'golden: legacy root carries ' + k);
    }
  });

  test('golden: migrateState report matches the executed reference numbers exactly', (t) => {
    const real = needReal(t); if (!real) return;
    const m = realMigration();
    const r = m.report;
    assert.equal(m.state.cards.length, 198, 'golden: 198 cards out, none lost');
    assert.equal(m.migratedCount, 198, 'golden: every legacy card counts as migrated');
    assert.deepEqual(J(r.bySource), { native: 0, legacy: 198, hybrid: 0, synth: 0, junk: 0 }, 'golden: all rows are legacy');
    assert.deepEqual(J(r.byStatus), { ACTIVE: 109, BANK: 89 }, 'golden: byStatus {ACTIVE:109, BANK:89}');
    assert.deepEqual(J(r.byGroup), { BANK: 89, NEW: 0, LEARNING: 41, FAMILIAR: 41, CONFIDENT: 27, MASTERED: 0 }, 'golden: byGroup');
    assert.deepEqual(J(r.levelHist.en_ru), [89, 40, 42, 0, 12, 9, 6], 'golden: levelHist.en_ru');
    assert.deepEqual(J(r.levelHist.ru_en), [89, 41, 41, 0, 12, 11, 4], 'golden: levelHist.ru_en');
    assert.equal(r.overdueCarried, 96, 'golden: 96 overdue legacy dates charged exactly once');
    assert.deepEqual(J(r.collisions), [], 'golden: no duplicates in the real base');
    assert.deepEqual(J(r.lostIds), [], 'golden: zero lost ids');
    assert.equal(r.scanned, 198, 'golden: scanned');
    assert.equal(r.keptCount, 198, 'golden: keptCount');
    assert.equal(m.state.schema_version, 2, 'golden: schema stamped to 2');
    assert.equal(m.state.migrated_at, TODAY, 'golden: migrated_at = golden today');
    assert.deepEqual(J(m.state.history), J(real.state.history), 'golden: root history survives migration byte-for-byte');
    assert.deepEqual(J(m.state.streak), J(real.state.streak), 'golden: root streak survives');
    assert.deepEqual(J(m.state.custom_groups), J(real.state.custom_groups), 'golden: root custom_groups survives');
  });

  test('golden: level-pair histogram {0/0:89, 1/1:40, 2/1:1, 2/2:41, 4/4:12, 5/5:5, 5/6:4, 6/5:6}', (t) => {
    const real = needReal(t); if (!real) return;
    const m = realMigration();
    const pairs = {};
    for (const c of m.state.cards) {
      const k = c.level_en_ru + '/' + c.level_ru_en;
      pairs[k] = (pairs[k] || 0) + 1;
    }
    assert.deepEqual(J(pairs), { '0/0': 89, '1/1': 40, '2/1': 1, '2/2': 41, '4/4': 12, '5/5': 5, '5/6': 4, '6/5': 6 }, 'golden: exact level-pair histogram');
    const sum = Object.keys(pairs).reduce((a, k) => a + pairs[k], 0);
    assert.equal(sum, 198, 'golden: pairs sum to 198');
  });

  test('golden: review queue = 96 entries; summarize dueByDirection {en_ru:95, ru_en:1}', (t) => {
    const real = needReal(t); if (!real) return;
    const m = realMigration();
    const q = SRS.buildReviewQueue(m.state.cards, TODAY);
    assert.equal(q.length, 96, 'golden: buildReviewQueue length 96');
    const s = SRS.summarize(m.state.cards, TODAY);
    assert.deepEqual(J(s.dueByDirection), { en_ru: 95, ru_en: 1 }, 'golden: dueByDirection');
    assert.equal(s.dueEntries, 96, 'golden: dueEntries 96');
    assert.equal(s.dueEntries, q.length, 'golden invariant: dueEntries === queue length');
    assert.equal(s.total, 198, 'golden: summarize total');
    assert.equal(s.total, s.bank + s.active, 'golden invariant: total === bank + active');
    assert.equal(s.bank, 89, 'golden: summarize bank 89');
    const byId = new Map(m.state.cards.map((c) => [c.id, c]));
    for (const it of q) {
      const c = byId.get(it.cardId);
      assert.equal(c.status, 'ACTIVE', 'golden: no BANK entry in the real queue (' + it.key + ')');
      assert.equal(SRS.isDirectionDue(c, it.direction, TODAY), true, 'golden: every queued entry is genuinely due (' + it.key + ')');
    }
    for (let i = 1; i < q.length; i++) {
      assert.notEqual(q[i].cardId, q[i - 1].cardId, 'golden rule 8: no same-card adjacency in the real 96-entry queue (position ' + i + ')');
    }
    const q2 = SRS.buildReviewQueue(m.state.cards, TODAY);
    assert.equal(JSON.stringify(q), JSON.stringify(q2), 'golden rule 9: real queue is byte-identical across runs (default salt)');
    const qSeed = SRS.buildReviewQueue(m.state.cards, TODAY, { seed: 'golden' });
    assert.equal(qSeed.length, 96, 'golden: seeded queue keeps all 96 entries');
    assert.deepEqual(keysOf(qSeed).sort(), keysOf(q).sort(), 'golden: seeded queue is a permutation of the default queue');
  });

  test('golden: both «resilience» homographs survive with their documented state', (t) => {
    const real = needReal(t); if (!real) return;
    const m = realMigration();
    const rows = m.state.cards.filter((c) => String(c.word || '').toLowerCase() === 'resilience');
    assert.equal(rows.length, 2, 'golden rule 14: both resilience rows survive (translations differ)');
    const active = rows.find((c) => c.id.endsWith('zjjmbn'));
    const bank = rows.find((c) => c.id.endsWith('mugz3w'));
    assert.ok(active && bank, 'golden: ids ending zjjmbn and mugz3n… mugz3w both present');
    assert.equal(active.status, 'ACTIVE', 'golden: …zjjmbn is ACTIVE');
    assert.equal(active.level_en_ru, 1, 'golden: …zjjmbn L1 en_ru');
    assert.equal(active.level_ru_en, 1, 'golden: …zjjmbn L1 ru_en');
    assert.equal(bank.status, 'BANK', 'golden: …mugz3w is BANK');
    assert.equal(bank.level_en_ru, 0, 'golden: …mugz3w L0 en_ru');
    assert.equal(bank.level_ru_en, 0, 'golden: …mugz3w L0 ru_en');
    assert.notEqual(active.translation, bank.translation, 'golden: the two rows really are different meanings');
  });

  test('golden: exactly 9 cards keep an ARRAY part_of_speech, byte-identical to the legacy file', (t) => {
    const real = needReal(t); if (!real) return;
    const m = realMigration();
    const EXPECTED_WORDS = ['Desert', 'copycat', 'distress', 'hustle', 'polar-opposite', 'pivot', 'regret', 'rental', 'scratch'].sort();
    const arrCards = m.state.cards.filter((c) => Array.isArray(c.part_of_speech));
    assert.equal(arrCards.length, 9, 'golden rule 16: 9 array part_of_speech cards');
    assert.deepEqual(J(arrCards.map((c) => c.word).sort()), J(EXPECTED_WORDS), 'golden rule 16: exact word set keeps array POS');
    const rawById = new Map(real.state.cards.map((c) => [c.id, c]));
    for (const c of arrCards) {
      const raw = rawById.get(c.id);
      assert.deepEqual(J(c.part_of_speech), J(raw.part_of_speech), 'golden rule 16: array POS byte-identical for ' + c.word);
    }
  });

  test('golden: idempotency — passes 2 and 3 are native no-ops, deep-equal cards', (t) => {
    const real = needReal(t); if (!real) return;
    const m1 = realMigration();
    const m2 = SRS.migrateState(m1.state, TODAY);
    const m3 = SRS.migrateState(m2.state, TODAY);
    assert.equal(m2.migratedCount, 0, 'golden rule 13: pass 2 migratedCount 0');
    assert.equal(m2.report.bySource.native, 198, 'golden rule 13: pass 2 bySource.native === 198');
    assert.deepEqual(J(m2.state.cards), J(m1.state.cards), 'golden rule 13: pass 2 cards deep-equal pass 1');
    assert.equal(m3.migratedCount, 0, 'golden rule 13: pass 3 migratedCount 0');
    assert.deepEqual(J(m3.state.cards), J(m1.state.cards), 'golden rule 13: pass 3 cards deep-equal pass 1');
    assert.equal(m2.state.migrated_at, TODAY, 'golden: migrated_at stable across passes');
  });

  test('golden: no deprecated field anywhere; every card validates; state passes its own guard; serialization is clean and stable', (t) => {
    const real = needReal(t); if (!real) return;
    const m = realMigration();
    for (const c of m.state.cards) {
      for (const f of SRS.DEPRECATED_FIELDS) {
        assert.ok(!(f in c), 'golden rule 15: card ' + c.id + ' must not carry deprecated field `' + f + '`');
      }
      const v = SRS.validateCard(c, TODAY);
      assert.deepEqual(J(v.errors), [], 'golden: validateCard(' + c.id + '/' + c.word + ') must be error-free');
    }
    const vs = SRS.validateState(m.state, m.state, { today: TODAY });
    assert.equal(vs.ok, true, 'golden: migrated state passes validateState against itself — errors: ' + J(vs.errors).join('; '));
    const ser1 = SRS.serializeState(m.state, { savedAt: '2026-09-17T21:00:00Z' });
    const ser2 = SRS.serializeState(m.state, { savedAt: '2026-09-17T21:00:00Z' });
    assert.equal(ser1, ser2, 'golden: serializeState byte-stable');
    const parsed = JSON.parse(ser1);
    assert.equal(parsed.schema_version, 2, 'golden: serialized schema_version 2');
    assert.equal(parsed.cards.length, 198, 'golden: serialized card count');
    for (const c of parsed.cards) {
      for (const f of SRS.DEPRECATED_FIELDS) {
        assert.ok(!(f in c), 'golden rule 15: serialized card ' + c.id + ' must not carry `' + f + '`');
      }
    }
  });
});

/* ========================================================================== */
/* 14. VALIDATION (rule 18) & SERIALIZATION (rule 15)                          */
/* ========================================================================== */
describe('validation & serialization', () => {

  const GOOD = () => ({ id: 'v1', status: 'ACTIVE', level_en_ru: 2, level_ru_en: 2, next_review_en_ru: '2026-09-19', next_review_ru_en: '2026-09-19', word: 'w', translation: 't' });
  const BANK_OK = () => ({ id: 'v2', status: 'BANK', level_en_ru: 0, level_ru_en: 0, next_review_en_ru: null, next_review_ru_en: null, word: 'w', translation: 't' });

  test('validateCard: accept paths', () => {
    const a = SRS.validateCard(GOOD(), TODAY);
    assert.equal(a.ok, true, 'validateCard: valid ACTIVE card accepted — ' + J(a.errors).join(';'));
    assert.deepEqual(J(a.errors), [], 'validateCard: no errors');
    assert.deepEqual(J(a.warnings), [], 'validateCard: no warnings');
    const b = SRS.validateCard(BANK_OK(), TODAY);
    assert.equal(b.ok, true, 'validateCard: valid BANK card accepted');
    const c = SRS.validateCard({ id: 'v3', status: 'BANK', level_en_ru: 0, level_ru_en: 0, word: 'w', translation: 't' }, TODAY);
    assert.equal(c.ok, true, 'validateCard: BANK with undefined (absent) dates accepted');
  });

  test('validateCard: refuse paths — every error kind', () => {
    assert.deepEqual(J(SRS.validateCard(null, TODAY).errors), ['not-an-object'], 'validateCard: null → not-an-object');
    assert.deepEqual(J(SRS.validateCard('x', TODAY).errors), ['not-an-object'], 'validateCard: string → not-an-object');
    const noId = SRS.validateCard(Object.assign(GOOD(), { id: '' }), TODAY);
    assert.ok(noId.errors.indexOf('id-missing') !== -1, 'validateCard: empty id → id-missing');
    const badStatus = SRS.validateCard(Object.assign(GOOD(), { status: 'WEIRD' }), TODAY);
    assert.ok(badStatus.errors.indexOf('status-invalid:WEIRD') !== -1, 'validateCard: bad status refused');
    for (const lv of [7, -1, 1.5, '3', null, undefined]) {
      const r = SRS.validateCard(Object.assign(GOOD(), { level_en_ru: lv }), TODAY);
      assert.ok(r.errors.some((e) => e.indexOf('level_en_ru-invalid') === 0), 'validateCard: level ' + JSON.stringify(lv) + ' refused (non-integer/out-of-range)');
      assert.equal(r.ok, false, 'validateCard: level ' + JSON.stringify(lv) + ' → ok false');
    }
    const badDue = SRS.validateCard(Object.assign(GOOD(), { next_review_en_ru: 'not-a-date' }), TODAY);
    assert.ok(badDue.errors.indexOf('next_review_en_ru-unparseable:"not-a-date"') !== -1, 'rule 18: ACTIVE with unparseable next_review refused');
    const nullDue = SRS.validateCard(Object.assign(GOOD(), { next_review_ru_en: null }), TODAY);
    assert.ok(nullDue.errors.indexOf('next_review_ru_en-unparseable:null') !== -1, 'rule 18: ACTIVE with null next_review refused');
    const bankDue = SRS.validateCard(Object.assign(BANK_OK(), { next_review_en_ru: '2026-09-19' }), TODAY);
    assert.ok(bankDue.errors.indexOf('next_review_en_ru-must-be-null-in-bank') !== -1, 'rule 18: BANK with non-null date refused');
    const dep = SRS.validateCard(Object.assign(GOOD(), { box: 2 }), TODAY);
    assert.ok(dep.errors.indexOf('deprecated-field:box') !== -1, 'rule 18: deprecated field presence refused');
    const dep2 = SRS.validateCard(Object.assign(GOOD(), { knowledge_group: 'X' }), TODAY);
    assert.ok(dep2.errors.indexOf('deprecated-field:knowledge_group') !== -1, 'rule 18: stored knowledge_group refused');
  });

  test('validateCard: warning paths (ok stays true)', () => {
    const far = SRS.validateCard(Object.assign(GOOD(), { next_review_en_ru: '2026-11-01' }), TODAY);
    assert.equal(far.ok, true, 'warnings do not refuse');
    assert.ok(far.warnings.indexOf('next_review_en_ru-too-far:2026-11-01') !== -1, 'due > 30 days ahead warns too-far');
    const before = SRS.validateCard(Object.assign(GOOD(), { created_at: '2026-09-20', next_review_en_ru: '2026-09-18' }), TODAY);
    assert.ok(before.warnings.indexOf('next_review_en_ru-before-created') !== -1, 'due before created_at warns');
    const emptyW = SRS.validateCard(Object.assign(GOOD(), { word: '' }), TODAY);
    assert.ok(emptyW.warnings.indexOf('word-empty') !== -1, 'empty word warns');
    const emptyT = SRS.validateCard(Object.assign(GOOD(), { translation: '' }), TODAY);
    assert.ok(emptyT.warnings.indexOf('translation-empty') !== -1, 'empty translation warns');
  });

  function stateN(n, mut) {
    const cards = [];
    for (let i = 0; i < n; i++) cards.push(Object.assign(GOOD(), { id: 'p' + i }, mut ? mut(i) : {}));
    return { schema_version: 2, cards: cards };
  }

  test('rule 18: validateState accept path and field contract', () => {
    const prev = stateN(10);
    const next = stateN(10);
    const v = SRS.validateState(next, prev, { today: TODAY });
    assert.equal(v.ok, true, 'validateState: identical 10-card state accepted — ' + J(v.errors).join(';'));
    assert.equal(v.shrinkRatio, 1, 'validateState: shrinkRatio 1');
    assert.deepEqual(J(v.removedIds), [], 'validateState: removedIds empty');
    assert.equal(v.count, 10, 'validateState: count');
    assert.deepEqual(J(v.errors), [], 'validateState: no errors');
    const noPrev = SRS.validateState(stateN(3), null, { today: TODAY });
    assert.equal(noPrev.ok, true, 'validateState: without prev only card validity is checked');
    assert.equal(noPrev.shrinkRatio, null, 'validateState: shrinkRatio null without prev');
    assert.equal(SRS.DEFAULTS.shrinkThreshold, 0.8, 'rule 18: DEFAULTS.shrinkThreshold = 0.8');
  });

  test('rule 18: validateState refuse paths — loss, shrink, dupes, broken cards, schema', () => {
    const prev = stateN(10);
    const v9 = SRS.validateState(stateN(9), prev, { today: TODAY });
    assert.equal(v9.ok, false, 'validateState: 10→9 unexplained refuses');
    assert.ok(v9.errors.some((e) => e.indexOf('UNEXPLAINED-LOSS:1') === 0), 'rule 18: UNEXPLAINED-LOSS error — got ' + J(v9.errors));
    assert.deepEqual(J(v9.removedIds), ['p9'], 'validateState: removedIds names the loss');
    assert.ok(!v9.errors.some((e) => e.indexOf('SHRINK') === 0), 'validateState: 90% ≥ 80% threshold → no shrink error');

    const v7 = SRS.validateState(stateN(7), prev, { today: TODAY });
    assert.equal(v7.ok, false, 'validateState: 10→7 refuses');
    assert.ok(v7.errors.some((e) => e.indexOf('UNEXPLAINED-LOSS:3') === 0), 'rule 18: UNEXPLAINED-LOSS:3');
    assert.ok(v7.errors.some((e) => e.indexOf('SHRINK-OVER-LIMIT:10→7 (70%)') === 0), 'rule 18: SHRINK-OVER-LIMIT at 70% < 80%');

    const explained = SRS.validateState(stateN(7), prev, { today: TODAY, removedIds: ['p7', 'p8', 'p9'] });
    assert.equal(explained.ok, false, 'validateState: explained removals still refuse when ratio < threshold');
    assert.ok(!explained.errors.some((e) => e.indexOf('UNEXPLAINED') === 0), 'validateState: removedIds explains the loss');
    assert.ok(explained.errors.some((e) => e.indexOf('SHRINK-OVER-LIMIT') === 0), 'rule 18: SHRINK-OVER-LIMIT still fires');

    const allowed = SRS.validateState(stateN(7), prev, { today: TODAY, removedIds: ['p7', 'p8', 'p9'], allowShrink: true });
    assert.equal(allowed.ok, true, 'rule 18: allowShrink + removedIds makes an intentional deletion pass');
    assert.deepEqual(J(allowed.errors), [], 'rule 18: no errors on intentional deletion');
    assert.ok(allowed.warnings.some((w) => w.indexOf('count-shrank:10→7') === 0), 'rule 18: intentional deletion produces a count-shrank WARNING');

    const custom = SRS.validateState(stateN(9), prev, { today: TODAY, removedIds: ['p9'], shrinkThreshold: 0.95 });
    assert.equal(custom.ok, false, 'validateState: custom shrinkThreshold 0.95 refuses 90%');
    assert.ok(custom.errors.some((e) => e.indexOf('SHRINK-OVER-LIMIT') === 0), 'custom threshold fires SHRINK-OVER-LIMIT');

    const dup = SRS.validateState({ cards: [GOOD(), Object.assign(GOOD(), { id: 'dup' }), Object.assign(GOOD(), { id: 'dup' })] }, null, { today: TODAY });
    assert.equal(dup.ok, false, 'validateState: duplicate ids refuse');
    assert.ok(dup.errors.indexOf('duplicate-id:dup') !== -1, 'rule 18: duplicate-id error');

    const broken = SRS.validateState({ cards: [Object.assign(GOOD(), { id: 'bad1', status: 'X' })] }, null, { today: TODAY });
    assert.equal(broken.ok, false, 'validateState: broken card refuses');
    assert.ok(broken.errors.indexOf('card[0](bad1): status-invalid:X') !== -1, 'rule 18: card errors carry card[i](id) prefix');

    const schema = SRS.validateState(Object.assign(stateN(1), { schema_version: 3 }), null, { today: TODAY });
    assert.equal(schema.ok, false, 'validateState: schema too new refuses');
    assert.ok(schema.errors.indexOf('schema-too-new:3') !== -1, 'schema-too-new error text');

    assert.deepEqual(J(SRS.validateState(null, null, {}).errors), ['state-not-object'], 'validateState: null next → state-not-object');
    assert.deepEqual(J(SRS.validateState({}, null, {}).errors), ['cards-not-array'], 'validateState: missing cards → cards-not-array');

    const grew = SRS.validateState(stateN(3), stateN(2), { today: TODAY });
    assert.equal(grew.ok, true, 'validateState: growth accepted');
    assert.ok(grew.warnings.some((w) => w.indexOf('count-grew:2→3') === 0), 'validateState: growth warns count-grew');

    const many = [];
    for (let i = 0; i < 30; i++) many.push(Object.assign(GOOD(), { id: 'm' + i, status: 'X' }));
    const capped = SRS.validateState({ cards: many }, null, { today: TODAY });
    assert.equal(capped.ok, false, 'validateState: mass-broken state refuses');
    assert.equal(capped.errors.length, 25, 'validateState: default maxErrors caps the error list at 25');
  });

  test('rule 15: serializeState — stable key order, schema 2, dead fields never emitted', () => {
    const messy = {
      zzz: 1, settings: { x: 1 }, schema_version: 1,
      cards: [{
        status: 'ACTIVE', id: 'k1', box: 2, knowledge_group: 'LEARNING', level: 4,
        word: 'w', translation: 't', level_en_ru: 1, level_ru_en: 1,
        next_review_en_ru: '2026-09-18', next_review_ru_en: '2026-09-18',
        zebra: 'z', alpha: 'a'
      }]
    };
    const snap = J(messy);
    const out = SRS.serializeState(messy, { savedAt: '2026-09-17T10:00:00Z' });
    assert.deepEqual(J(messy), snap, 'serializeState: input state never mutated (dead fields stay on the INPUT)');
    const parsed = JSON.parse(out);
    assert.deepEqual(J(Object.keys(parsed)), ['schema_version', 'saved_at', 'cards', 'settings', 'zzz'], 'serialize: root key order = ROOT_KEY_ORDER first, then extras alphabetically');
    assert.equal(parsed.schema_version, 2, 'rule 15: schema_version forced to 2 (input said 1)');
    assert.equal(parsed.saved_at, '2026-09-17T10:00:00Z', 'serialize: opts.savedAt lands in saved_at');
    assert.deepEqual(J(Object.keys(parsed.cards[0])),
      ['id', 'word', 'translation', 'status', 'level_en_ru', 'next_review_en_ru', 'level_ru_en', 'next_review_ru_en', 'alpha', 'zebra'],
      'serialize: card key order = CARD_KEY_ORDER (present fields) then extras alphabetically');
    for (const f of SRS.DEPRECATED_FIELDS) {
      assert.ok(!(f in parsed.cards[0]), 'rule 15: serialized card must not carry `' + f + '`');
    }
    assert.ok(out.indexOf('\n  "') !== -1, 'serialize: pretty-printed with 2-space indent (git-diff friendly)');
    const again = SRS.serializeState(messy, { savedAt: '2026-09-17T10:00:00Z' });
    assert.equal(out, again, 'serialize: byte-stable across calls');
    const noCards = JSON.parse(SRS.serializeState({}));
    assert.deepEqual(J(noCards.cards), [], 'serialize: missing cards array normalizes to []');
    assert.equal(noCards.schema_version, 2, 'serialize: schema stamped even on an empty root');
    assert.ok(!('saved_at' in noCards), 'serialize: no saved_at without opts.savedAt');
    const noJunk = SRS.serializeState(null);
    assert.equal(JSON.parse(noJunk).schema_version, 2, 'serialize: null state tolerated');
  });
});

/* ========================================================================== */
/* 15. SESSION CONTAINER (rule 19)                                             */
/* ========================================================================== */
describe('session container', () => {

  const it = (id, dir) => ({ key: id + ':' + (dir || 'en_ru'), cardId: id, direction: dir || 'en_ru', kind: 'review' });
  const six = () => [it('a'), it('b'), it('c'), it('d'), it('e'), it('f')];

  test('createSession: shape, item-array copy, today validation', () => {
    const items = six();
    const s = SRS.createSession(items, { today: TODAY, mode: 'learn', seed: 7, startedAt: 'x' });
    assert.equal(s.mode, 'learn', 'session: mode from opts');
    assert.equal(s.today, TODAY, 'session: valid today kept');
    assert.equal(s.seed, 7, 'session: seed kept');
    assert.equal(s.startedAt, 'x', 'session: startedAt kept');
    assert.equal(s.cursor, 0, 'session: cursor starts at 0');
    assert.deepEqual(J(s.order), keysOf(items), 'session: order mirrors item keys');
    assert.deepEqual(J(s.items), J(items), 'session: items copied in');
    items.push(it('g'));
    assert.equal(s.items.length, 6, 'session: input array mutation does not leak into the session');
    const d = SRS.createSession([]);
    assert.equal(d.mode, 'review', 'session: default mode review');
    assert.equal(d.today, null, 'session: missing today → null');
    const bad = SRS.createSession([], { today: 'garbage' });
    assert.equal(bad.today, null, 'session: invalid today → null');
    const none = SRS.createSession(null);
    assert.deepEqual(J(none.items), [], 'session: non-array items → empty');
    assert.equal(SRS.sessionCurrent(none), null, 'session: current on empty → null');
    assert.equal(SRS.sessionRemaining(none), 0, 'session: remaining on empty → 0');
  });

  test('rule 19: sessionCurrent skips already-graded keys; advance/remaining bookkeeping', () => {
    const s = SRS.createSession(six(), { today: TODAY });
    assert.equal(SRS.sessionCurrent(s).key, 'a:en_ru', 'session: current = first ungraded');
    assert.equal(SRS.sessionRemaining(s), 6, 'session: remaining 6');
    SRS.sessionMarkGraded(s, 'a:en_ru', 'easy', 'en_ru');
    assert.equal(SRS.sessionIsGraded(s, 'a:en_ru'), true, 'session: graded flag set');
    assert.equal(SRS.sessionCurrent(s).key, 'b:en_ru', 'rule 19: current skips the graded key');
    assert.equal(SRS.sessionRemaining(s), 5, 'session: remaining drops after grading');
    SRS.sessionMarkGraded(s, 'b:en_ru', 'hard', 'en_ru');
    SRS.sessionMarkGraded(s, 'c:en_ru', 'again', 'en_ru');
    assert.equal(SRS.sessionCurrent(s).key, 'd:en_ru', 'rule 19: current skips a run of graded keys');
    assert.equal(SRS.sessionRemaining(s), 3, 'session: remaining 3');
    SRS.sessionAdvance(s);
    assert.equal(SRS.sessionCurrent(s).key, 'e:en_ru', 'sessionAdvance moves the cursor');
    s.cursor = 6;
    assert.equal(SRS.sessionCurrent(s), null, 'session: past the end → null');
    assert.equal(SRS.sessionRemaining(s), 0, 'session: past the end → remaining 0');
    /* prototype-pollution safety of the graded map */
    const fresh = SRS.createSession(six(), { today: TODAY });
    assert.equal(SRS.sessionIsGraded(fresh, 'toString'), false, 'session: inherited Object keys must not look graded');
    assert.equal(SRS.sessionIsGraded(fresh, '__proto__'), false, 'session: __proto__ must not look graded');
    SRS.sessionMarkGraded(fresh, '__proto__', 'easy', 'en_ru');
    assert.equal(SRS.sessionIsGraded(fresh, '__proto__'), true, 'session: null-prototype map stores even __proto__');
  });

  test('rule 19: sessionRequeue — delay position, repeat counter, maxRepeatsPerSession cap', () => {
    const s = SRS.createSession(six(), { today: TODAY });
    const r1 = SRS.sessionRequeue(s, s.items[0]);
    assert.equal(r1, 'requeued', 'session: first requeue accepted');
    assert.equal(s.items.length, 7, 'session: requeue inserts a copy');
    assert.equal(s.items[4].key, 'a:en_ru', 'session: default requeueDelay=4 → inserted at cursor+4');
    assert.equal(s.items[4].kind, 'requeue', 'session: requeued copy kind=requeue');
    assert.equal(s.items[4].repeat, 1, 'session: repeat counter 1');
    assert.equal(s.order[4], 'a:en_ru', 'session: order tracks the insertion');
    const r2 = SRS.sessionRequeue(s, { key: 'a:en_ru' });
    assert.equal(r2, 'capped', 'rule 19: second requeue of the same key hits maxRepeatsPerSession=1 → capped');
    assert.equal(s.items.length, 7, 'session: capped requeue inserts nothing');
    /* opts overrides */
    const s2 = SRS.createSession(six(), { today: TODAY });
    assert.equal(SRS.sessionRequeue(s2, s2.items[0], { maxRepeats: 2, delay: 2 }), 'requeued', 'session: opts.maxRepeats raises the cap');
    assert.equal(s2.items[2].key, 'a:en_ru', 'session: opts.delay=2 → inserted at cursor+2');
    assert.equal(SRS.sessionRequeue(s2, s2.items[0], { maxRepeats: 2, delay: 2 }), 'requeued', 'session: second repeat allowed under cap 2');
    assert.equal(s2.items.filter((x) => x.key === 'a:en_ru' && x.kind === 'requeue').length, 2, 'session: two requeue copies present');
    assert.equal(SRS.sessionRequeue(s2, s2.items[0], { maxRepeats: 2 }), 'capped', 'session: third requeue capped at maxRepeats 2');
    /* tail clamp + null tolerance */
    const s3 = SRS.createSession([it('a'), it('b'), it('c')], { today: TODAY });
    SRS.sessionRequeue(s3, s3.items[0]);
    assert.equal(s3.items[3].key, 'a:en_ru', 'session: cursor+delay beyond the end clamps to append');
    assert.equal(SRS.sessionRequeue(null, it('x')), 'capped', 'session: null session → capped');
    assert.equal(SRS.sessionRequeue(s3, null), 'capped', 'session: null item → capped');
  });

  test('rule 19: sessionSkip — first skip moves to tail, second removes', () => {
    const s = SRS.createSession([it('a'), it('b'), it('c')], { today: TODAY });
    const r1 = SRS.sessionSkip(s, 'a:en_ru');
    assert.equal(r1, 'moved-to-tail', 'rule 19: first skip → moved-to-tail');
    assert.deepEqual(keysOf(s.items), ['b:en_ru', 'c:en_ru', 'a:en_ru'], 'session: skipped item sits at the tail');
    assert.equal(s.order[s.order.length - 1], 'a:en_ru', 'session: order records the tail move');
    s.cursor = 2;                                  // cursor now points at the tail copy
    const r2 = SRS.sessionSkip(s, 'a:en_ru');
    assert.equal(r2, 'removed', 'rule 19: second skip → removed (word stays due tomorrow)');
    assert.deepEqual(keysOf(s.items), ['b:en_ru', 'c:en_ru'], 'session: removed item is gone from items');
    assert.equal(SRS.sessionRemaining(s), 0, 'session: nothing left from cursor');
    assert.equal(SRS.sessionSkip(s, 'zz:en_ru'), 'absent', 'session: unknown key → absent');
    assert.equal(SRS.sessionSkip(null, 'a:en_ru'), 'ignored', 'session: null session → ignored');
    assert.equal(SRS.sessionSkip(s, ''), 'ignored', 'session: empty key → ignored');
  });

  test('rule 19/A4: sessionEnsure is idempotent, alias-normalizing, graded-aware', () => {
    const s = SRS.createSession([it('a')], { today: TODAY, seed: 5 });
    const card = qCard('gx', 'ACTIVE', 0, 0, TODAY, TODAY);
    const added1 = SRS.sessionEnsure(s, card, ['en_ru', 'rus-eng'], TODAY);
    assert.deepEqual(J(added1), ['gx:en_ru', 'gx:ru_en'], 'sessionEnsure: returns the added keys (alias normalized)');
    assert.equal(s.items.length, 3, 'sessionEnsure: two items inserted');
    const added2 = SRS.sessionEnsure(s, card, ['en_ru', 'ru_en'], TODAY);
    assert.deepEqual(J(added2), [], 'rule 19: second ensure adds nothing (idempotent)');
    assert.equal(s.items.length, 3, 'rule 19: never creates a duplicate key');
    assert.equal(s.items.filter((x) => x.key === 'gx:en_ru').length, 1, 'sessionEnsure: exactly one gx:en_ru entry');
    SRS.sessionMarkGraded(s, 'gx:ru_en', 'again', 'ru_en');
    const added3 = SRS.sessionEnsure(s, card, ['ru_en'], TODAY);
    assert.deepEqual(J(added3), [], 'sessionEnsure: already-graded pair is never re-added (A3/A7)');
    const big = SRS.createSession(six(), { today: TODAY });
    SRS.sessionEnsure(big, qCard('ins', 'ACTIVE', 0, 0, TODAY, TODAY), ['en_ru'], TODAY);
    assert.equal(big.items[3].key, 'ins:en_ru', 'sessionEnsure: inserted at cursor + sameCardGap(3)');
    assert.deepEqual(J(SRS.sessionEnsure(null, card, ['en_ru'], TODAY)), [], 'sessionEnsure: null session → []');
    assert.deepEqual(J(SRS.sessionEnsure(s, null, ['en_ru'], TODAY)), [], 'sessionEnsure: null card → []');
  });

  test('sessionStats: aggregates answers, directions, unique cards, skips, requeues', () => {
    const s = SRS.createSession([it('a'), it('b', 'ru_en'), it('c')], { today: TODAY });
    SRS.sessionMarkGraded(s, 'a:en_ru', 'easy', 'en_ru');
    SRS.sessionMarkGraded(s, 'b:ru_en', 'again', 'ru_en');
    SRS.sessionSkip(s, 'c:en_ru');
    SRS.sessionRequeue(s, s.items[0]);
    const st = SRS.sessionStats(s);
    assert.equal(st.entries, s.items.length, 'stats: entries mirrors items length');
    assert.equal(st.graded, 2, 'stats: graded count');
    assert.equal(st.cards, 2, 'stats: unique card ids from graded keys');
    assert.equal(st.remaining, 1, 'stats: only c:en_ru ungraded ahead of the cursor');
    assert.deepEqual(J(st.byAnswer), { again: 1, hard: 0, easy: 1 }, 'stats: byAnswer');
    assert.deepEqual(J(st.byDirection), { en_ru: 1, ru_en: 1 }, 'stats: byDirection');
    assert.equal(st.skipped, 1, 'stats: skipped keys count');
    assert.equal(st.requeued, 1, 'stats: requeued keys count');
    const empty = SRS.sessionStats(SRS.createSession([]));
    assert.equal(empty.graded, 0, 'stats: empty session graded 0');
    assert.equal(empty.cards, 0, 'stats: empty session cards 0');
    assert.deepEqual(J(empty.byAnswer), { again: 0, hard: 0, easy: 0 }, 'stats: empty byAnswer');
  });
});

/* ========================================================================== */
/* 16. CROSS-CUTTING INVARIANTS                                                */
/* ========================================================================== */
describe('cross-cutting invariants', () => {

  test('A2 at queue level: after ANY answer, the answered pair never re-enters the same-day queue', () => {
    for (const dir of ['en_ru', 'ru_en']) {
      for (let L = 0; L <= 6; L++) {
        for (const ans of ['again', 'hard', 'easy']) {
          const c = mkCard('term-' + L + '-' + ans + '-' + dir, {
            level_en_ru: L, level_ru_en: L,
            next_review_en_ru: '2026-09-01', next_review_ru_en: '2026-09-01'
          });
          const before = SRS.buildReviewQueue([c], TODAY);
          assert.ok(before.some((x) => x.key === c.id + ':' + dir), 'fixture sanity: pair is queued before the answer');
          const res = SRS.applyAnswer(c, dir, ans, TODAY);
          const after = SRS.buildReviewQueue([res.card], TODAY);
          assert.ok(!after.some((x) => x.key === c.id + ':' + dir),
            'A2 termination: ' + ans + ' at L' + L + ' on ' + dir + ' must remove the pair from today\'s queue');
          const other = SRS.otherDir(dir);
          assert.ok(after.some((x) => x.key === c.id + ':' + other),
            'A8 firewall: the OTHER direction stays queued on its own schedule');
        }
      }
    }
  });

  test('rule 1 over time: easy-ladder simulation climbs 0→1→…→6 and parks at 30 days forever, ru_en untouched', () => {
    let c = mkCard('ladder', { level_en_ru: 0, level_ru_en: 0, next_review_en_ru: TODAY, next_review_ru_en: TODAY });
    let day = TODAY;
    const seenLevels = [];
    for (let step = 0; step < 9; step++) {
      assert.equal(SRS.isDirectionDue(c, 'en_ru', day), true, 'ladder step ' + step + ': card is due on its own due date');
      const res = SRS.applyAnswer(c, 'en_ru', 'easy', day);
      seenLevels.push(res.next.level);
      assert.equal(res.next.due, SRS.addDays(day, [0, 1, 2, 4, 7, 14, 30][res.next.level]), 'ladder step ' + step + ': rule 1 — due = answer day + INTERVALS[level]');
      assert.equal(res.card.level_ru_en, 0, 'A8 over time: ru_en level never moves during the en_ru ladder');
      assert.equal(res.card.next_review_ru_en, TODAY, 'A8 over time: ru_en date never moves');
      assert.equal(res.card.review_count, step + 1, 'review_count accumulates');
      c = res.card;
      day = res.next.due;
    }
    assert.deepEqual(J(seenLevels), [1, 2, 3, 4, 5, 6, 6, 6, 6], 'ladder: 0→1→2→3→4→5→6 then ceiling forever (no archive)');
    assert.equal(day, SRS.addDays(SRS.addDays(SRS.addDays(SRS.addDays(SRS.addDays(TODAY, 1), 2), 4), 7), 14 + 30 + 30 + 30 + 30), 'ladder: final day = cumulative intervals');
    const reset = SRS.applyAnswer(c, 'en_ru', 'again', day);
    assert.equal(reset.next.level, 2, 'again at the L6 ceiling → 2 (>3 branch)');
    const frozen = SRS.applyAnswer(reset.card, 'en_ru', 'hard', day);
    assert.equal(frozen.next.level, 2, 'hard after the reset freezes at 2');
    assert.equal(frozen.next.due, SRS.addDays(day, 2), 'hard repeats the level-2 interval');
  });
});

/* ========================================================================== */
/* 17. LIVE MIGRATED BASE — data/leitner_data.json уже в schema 2             */
/*    Золотые числа выше считаются из legacy-фикстура; этот блок закрепляет    */
/*    результат ВЫПОЛНЕННОЙ миграции, чтобы её нельзя было потерять молча.     */
/* ========================================================================== */
describe('live migrated base (data/leitner_data.json)', () => {

  function needLive(t) {
    const live = loadLive();
    if (!live) { t.skip('data/leitner_data.json missing or unreadable — live-base checks skipped'); return null; }
    return live;
  }

  test('live: file is schema 2, BOM-free and parses without stripBom', (t) => {
    const live = needLive(t); if (!live) return;
    assert.notEqual(live.raw.charCodeAt(0), 0xFEFF,
      'live: migrated base must be written WITHOUT a BOM (BOM ломал JSON.parse в прежнем add_words.js)');
    assert.doesNotThrow(() => JSON.parse(live.raw), 'live: migrated base parses directly');
    assert.equal(Number(live.state.schema_version), SRS.SCHEMA_VERSION, 'live: schema_version is 2');
  });

  test('live: 198 cards survived, none lost, status/group split matches the reference', (t) => {
    const live = needLive(t); if (!live) return;
    const cards = live.state.cards;
    assert.equal(cards.length, 198, 'live: exactly 198 cards');
    const ids = new Set(cards.map(c => String(c.id)));
    assert.equal(ids.size, 198, 'live: all ids unique');
    const sum = SRS.summarize(cards, TODAY);
    assert.deepEqual(J(sum.groups), { BANK: 89, NEW: 0, LEARNING: 41, FAMILIAR: 41, CONFIDENT: 27, MASTERED: 0 },
      'live: byGroup of the executed migration');
    assert.equal(sum.bank, 89, 'live: 89 words stay isolated in the Bank (RULE 1)');
    assert.equal(sum.active, 109, 'live: 109 words are ACTIVE');
  });

  test('live: no deprecated field survives on any card', (t) => {
    const live = needLive(t); if (!live) return;
    const offenders = [];
    for (const c of live.state.cards) {
      for (const f of SRS.DEPRECATED_FIELDS) {
        if (c && Object.prototype.hasOwnProperty.call(c, f)) offenders.push(`${c.id}:${f}`);
      }
    }
    assert.deepEqual(offenders, [], 'live: box/eng_to_rus/next_review_date/… must be gone (RULE 15)');
  });

  test('live: every card has both direction vectors with valid dates or null', (t) => {
    const live = needLive(t); if (!live) return;
    for (const c of live.state.cards) {
      for (const dir of SRS.DIRECTIONS) {
        const lv = c[SRS.levelKey(dir)];
        assert.ok(Number.isInteger(lv) && lv >= 0 && lv <= SRS.MAX_LEVEL,
          `live: ${c.id} ${dir} level must be an integer 0..6, got ${lv}`);
        const due = c[SRS.dueKey(dir)];
        if (SRS.isBank(c)) {
          assert.ok(due === null || due === '' || due === undefined,
            `live: banked ${c.id} ${dir} must not carry a review date, got ${due}`);
        } else {
          assert.ok(SRS.isDateStr(due), `live: active ${c.id} ${dir} needs a YYYY-MM-DD date, got ${due}`);
        }
      }
    }
  });

  test('live: content survived byte-for-byte — both resilience rows and all 9 array-POS cards', (t) => {
    const live = needLive(t); if (!live) return;
    const cards = live.state.cards;
    const resilience = cards.filter(c => String(c.word).toLowerCase() === 'resilience');
    assert.equal(resilience.length, 2, 'live: both homograph rows survive (they have different translations)');
    const translations = resilience.map(c => c.translation).sort();
    assert.notEqual(translations[0], translations[1], 'live: the two resilience rows keep distinct translations');
    const arrayPos = cards.filter(c => Array.isArray(c.part_of_speech));
    assert.equal(arrayPos.length, 9, 'live: 9 cards keep an ARRAY part_of_speech (RULE 16 — never flatten)');
  });

  test('live: re-migrating is a no-op (idempotency of the executed migration)', (t) => {
    const live = needLive(t); if (!live) return;
    const res = SRS.migrateState(J(live.state), TODAY);
    assert.equal(res.migratedCount, 0, 'live: second pass migrates nothing');
    assert.equal(res.report.bySource.native, 198, 'live: every row is recognized as native schema 2');
    assert.deepEqual(J(res.state.cards), J(live.state.cards), 'live: cards are byte-identical after the second pass');
  });

  test('live: the daily review queue is non-empty and its keys are unique (A3)', (t) => {
    const live = needLive(t); if (!live) return;
    const q = SRS.buildReviewQueue(live.state.cards, TODAY, { seed: TODAY });
    assert.equal(q.length, 96, 'live: 96 due entries on the reference date');
    const keys = q.map(i => i.key);
    assert.equal(new Set(keys).size, keys.length, 'live: invariant A3 — queue keys `${cardId}:${dir}` are unique');
    for (const item of q) {
      assert.ok(SRS.DIRECTIONS.indexOf(item.direction) !== -1, `live: queue direction must be known, got ${item.direction}`);
      const card = live.state.cards.find(c => String(c.id) === String(item.cardId));
      assert.ok(card, `live: queue entry ${item.key} points at an existing card`);
      assert.ok(SRS.isActive(card), `live: no BANK card may enter the review queue (RULE 1): ${item.key}`);
      assert.ok(SRS.isDirectionDue(card, item.direction, TODAY), `live: queue entry must actually be due: ${item.key}`);
    }
  });

  test('live: validateState accepts the persisted state as-is', (t) => {
    const live = needLive(t); if (!live) return;
    const check = SRS.validateState(live.state, live.state, { today: TODAY });
    assert.equal(check.ok, true, 'live: validateState(self) must be ok — errors: ' + J(check.errors).join('; '));
    assert.deepEqual(J(check.errors), [], 'live: no validation errors');
  });

  test('live: serializeState round-trips the persisted file without changing cards', (t) => {
    const live = needLive(t); if (!live) return;
    const text = SRS.serializeState(live.state, { savedAt: live.state.saved_at });
    const again = JSON.parse(text);
    assert.deepEqual(J(again.cards), J(live.state.cards), 'live: serialization is lossless for cards');
    assert.equal(Number(again.schema_version), SRS.SCHEMA_VERSION, 'live: serialization keeps schema 2');
  });
});

/* ============ Антиинфляционный guard: EASY дважды за день НЕ поднимает уровень ============
   Проблема пользователя (19.09): повторная сессия в тот же день — слова «легко
   вспоминаются» из краткосрочной памяти и неправомерно уезжают на недельные
   интервалы. Guard в applyAnswer: last_review_<dir> === today ⇒ EASY держит уровень. */
describe('same-day anti-inflation guard (Easy twice in one day holds the level)', () => {
  const D = 'en_ru';
  const tomorrow = SRS.addDays(TODAY, 1);

  test('первый EASY дня поднимает уровень и ставит штамп last_review', () => {
    const r1 = SRS.applyAnswer(mkCard('sd1', { level_en_ru: 2, next_review_en_ru: TODAY }), D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r1.next.level, 3, 'L2 --easy--> L3');
    assert.equal(r1.outcome, 'advance');
    assert.equal(r1.card.last_review_en_ru, TODAY, 'last_review_en_ru штампуется днём ответа');
    assert.equal(r1.sameDayRepeat, false, 'до ответа сегодня повторов не было');
  });

  test('второй EASY того же дня ЗАМОРАЖИВАЕТ уровень (hold + warning)', () => {
    const r1 = SRS.applyAnswer(mkCard('sd2', { level_en_ru: 2, next_review_en_ru: TODAY }), D, SRS.ANSWERS.EASY, TODAY);
    const r2 = SRS.applyAnswer(r1.card, D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r2.next.level, 3, 'уровень не вырос: 3 осталось 3');
    assert.equal(r2.outcome, 'hold');
    assert.equal(r2.sameDayRepeat, true);
    assert.ok(r2.warnings.includes('same_day_easy_hold'), 'warning для UI-тоста');
    assert.equal(r2.card.next_review_en_ru, SRS.addDays(TODAY, SRS.INTERVALS[3]), 'due пересчитан от сегодня по ТЕКУЩЕМУ уровню');
    assert.equal(r2.card.last_review_en_ru, TODAY, 'same-day hold: штамп остаётся днём первого (честного) ответа');
  });

  test('EASY назавтра рано (hold), а на сроке продвигает — guard не вечная заморозка', () => {
    const r1 = SRS.applyAnswer(mkCard('sd3', { level_en_ru: 2, next_review_en_ru: TODAY }), D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r1.next.level, 3, 'день 0: L2→L3');
    // Назавтра после подъёма для L3 (интервал 4) вспоминание РАННЕЕ — early-guard держит.
    const r2 = SRS.applyAnswer(r1.card, D, SRS.ANSWERS.EASY, tomorrow);
    assert.equal(r2.next.level, 3, 'день 1: elapsed 1 < 4 → hold (это и есть защита от ежедневного cram)');
    assert.equal(r2.sameDayRepeat, false);
    assert.equal(r2.earlyReview, true);
    // На сроке (4 дня от последнего честного ответа) — нормальный рост.
    const r3 = SRS.applyAnswer(r2.card, D, SRS.ANSWERS.EASY, SRS.addDays(TODAY, 4));
    assert.equal(r3.next.level, 4, 'день 4: интервал созрел → рост 3→4');
    assert.equal(r3.earlyReview, false);
  });

  test('Forgot →Easy в той же сессии НЕ взбирается обратно по лестнице', () => {
    const r1 = SRS.applyAnswer(mkCard('sd4', { level_en_ru: 4, next_review_en_ru: TODAY }), D, SRS.ANSWERS.AGAIN, TODAY);
    assert.equal(r1.next.level, 2, 'AGAIN на L4 сбрасывает до L2 (существующее правило)');
    const r2 = SRS.applyAnswer(r1.card, D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r2.next.level, 2, 'сразу после провала «Легко» держит L2 — слово вернётся через 2 дня, а не через 4');
    assert.equal(r2.outcome, 'hold');
    assert.ok(r2.warnings.includes('same_day_easy_hold'));
    assert.equal(r2.card.next_review_en_ru, SRS.addDays(TODAY, 2));
  });

  test('A8 не сломан: guard трогает только отвеченный вектор', () => {
    const c0 = mkCard('sd5', { level_en_ru: 3, level_ru_en: 3 });
    const before = JSON.stringify({ l: c0.level_ru_en, due: c0.next_review_ru_en, last: c0.last_review_ru_en });
    const r1 = SRS.applyAnswer(c0, D, SRS.ANSWERS.EASY, TODAY);
    const r2 = SRS.applyAnswer(r1.card, D, SRS.ANSWERS.EASY, TODAY);
    const after = JSON.stringify({ l: r2.card.level_ru_en, due: r2.card.next_review_ru_en, last: r2.card.last_review_ru_en });
    assert.equal(after, before, 'ru_en вектор байт-в-байт прежний');
  });

  test('HARD и AGAIN в тот же день работают как раньше', () => {
    const c0 = mkCard('sd6', { level_en_ru: 3, next_review_en_ru: TODAY });
    const rH1 = SRS.applyAnswer(c0, D, SRS.ANSWERS.HARD, TODAY);
    const rH2 = SRS.applyAnswer(rH1.card, D, SRS.ANSWERS.HARD, TODAY);
    assert.equal(rH2.next.level, 3, 'hard по-прежнему морозит');
    assert.ok(!rH2.warnings.includes('same_day_easy_hold'), 'warning только для EASY');
    const rA = SRS.applyAnswer(rH2.card, D, SRS.ANSWERS.AGAIN, TODAY);
    assert.equal(rA.next.level, 1, 'AGAIN L3→L1 без изменений (lowMaxLevel=3)');
  });
});

/* ============ Early-review guard: EASY до срока не поднимает уровень ============
   Обобщение same-day guard (19.09): ежедневный cram группы поднимал слово по
   ступени за сутки, ни разу не проверив его на настоящем интервале. Правило:
   EASY продвигает только если elapsed >= INTERVALS[prevLevel] (слово созрело).
   Due-очереди показывают карточку не раньше срока — обычная тренировка не затронута. */
describe('early-review guard (Easy before the due day holds the level)', () => {
  const D = 'en_ru';

  test('ранний EASY (elapsed < интервала) держит уровень + warning + daysEarly', () => {
    // L3: интервал 4 дня. Отвечали 2 дня назад → срок ещё не наступил.
    const c = mkCard('er1', {
      level_en_ru: 3,
      next_review_en_ru: SRS.addDays(TODAY, 2),
      last_review_en_ru: SRS.addDays(TODAY, -2)
    });
    const r = SRS.applyAnswer(c, D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r.next.level, 3, 'ранний Easy не поднимает L3');
    assert.equal(r.outcome, 'hold');
    assert.equal(r.earlyReview, true);
    assert.equal(r.daysEarly, 2, 'INTERVALS[3]=4 − elapsed 2');
    assert.ok(r.warnings.includes('early_easy_hold'), 'warning для UI-тоста');
    assert.equal(r.card.next_review_en_ru, SRS.addDays(TODAY, 4), 'due пересчитан от сегодня по текущему уровню');
    assert.equal(r.card.last_review_en_ru, SRS.addDays(TODAY, -2), 'held-ранний EASY штамп НЕ двигает: плановые часы идут от последнего честного ответа');
  });

  test('EASY ровно на сроке (elapsed === интервал) продвигает как обычно', () => {
    const c = mkCard('er2', {
      level_en_ru: 3,
      next_review_en_ru: TODAY,
      last_review_en_ru: SRS.addDays(TODAY, -4)
    });
    const r = SRS.applyAnswer(c, D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r.next.level, 4, 'созревшее слово растёт L3→L4');
    assert.equal(r.outcome, 'advance');
    assert.equal(r.earlyReview, false);
    assert.ok(!r.warnings.includes('early_easy_hold'));
  });

  test('просроченный EASY (elapsed > интервала) тоже продвигает', () => {
    const c = mkCard('er3', {
      level_en_ru: 3,
      next_review_en_ru: SRS.addDays(TODAY, -2),
      last_review_en_ru: SRS.addDays(TODAY, -6)
    });
    const r = SRS.applyAnswer(c, D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r.next.level, 4, 'вспомнил позже срока — тем более рост');
    assert.equal(r.earlyReview, false);
  });

  test('ежедневный cram больше не надувает лестницу: L2 держится при elapsed 1 < 2', () => {
    const day0 = SRS.applyAnswer(mkCard('er4', { level_en_ru: 2, next_review_en_ru: TODAY }), D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(day0.next.level, 3, 'день 0: созрело (due сегодня) → L3');
    const day1 = SRS.applyAnswer(day0.card, D, SRS.ANSWERS.EASY, SRS.addDays(TODAY, 1));
    assert.equal(day1.next.level, 3, 'день 1: L3 требует 4 дня, elapsed 1 → hold');
    const day2 = SRS.applyAnswer(day1.card, D, SRS.ANSWERS.EASY, SRS.addDays(TODAY, 2));
    assert.equal(day2.next.level, 3, 'день 2: elapsed 2 < 4 → hold');
    const day4 = SRS.applyAnswer(day2.card, D, SRS.ANSWERS.EASY, SRS.addDays(TODAY, 4));
    assert.equal(day4.next.level, 4, 'день 4: от последнего ЧЕСТНОГО ответа (день 0) прошло 4 = INTERVALS[3] → L4');
    assert.equal(day4.card.last_review_en_ru, SRS.addDays(TODAY, 4), 'зачтённый ответ двигает штамп');
  });

  test('ранний HARD морозит без early-warning (прежнее поведение)', () => {
    const c = mkCard('er5', {
      level_en_ru: 4,
      next_review_en_ru: SRS.addDays(TODAY, 5),
      last_review_en_ru: SRS.addDays(TODAY, -2)
    });
    const r = SRS.applyAnswer(c, D, SRS.ANSWERS.HARD, TODAY);
    assert.equal(r.next.level, 4, 'hard всегда морозит');
    assert.ok(!r.warnings.includes('early_easy_hold'), 'warning только для EASY');
  });

  test('ранний AGAIN сбрасывает как обычно — провал guard не отменяет', () => {
    const c = mkCard('er6', {
      level_en_ru: 4,
      next_review_en_ru: SRS.addDays(TODAY, 5),
      last_review_en_ru: SRS.addDays(TODAY, -2)
    });
    const r = SRS.applyAnswer(c, D, SRS.ANSWERS.AGAIN, TODAY);
    assert.equal(r.next.level, 2, 'AGAIN L4→L2 независимо от срока');
    assert.equal(r.outcome, 'reset');
  });

  test('без штампа last_review (старые данные) guard не срабатывает — совместимость', () => {
    const c = mkCard('er7', { level_en_ru: 3, next_review_en_ru: SRS.addDays(TODAY, 3) });
    const r = SRS.applyAnswer(c, D, SRS.ANSWERS.EASY, TODAY);
    assert.equal(r.next.level, 4, 'нет истории — обычный подъём');
    assert.equal(r.earlyReview, false);
  });

  test('same-day повтор имеет приоритет: same_day_easy_hold, не early', () => {
    const c = mkCard('er8', { level_en_ru: 3, next_review_en_ru: TODAY, last_review_en_ru: TODAY });
    const r = SRS.applyAnswer(c, D, SRS.ANSWERS.EASY, TODAY);
    assert.ok(r.warnings.includes('same_day_easy_hold'));
    assert.ok(!r.warnings.includes('early_easy_hold'), 'два hold-warning одновременно не выдаются');
    assert.equal(r.sameDayRepeat, true);
  });
});

/* ============ Инвариант «order зеркалит items» живёт и после мутаций сессии ============
   Регрессия 19.09: sessionSkip при первом скипе двигал item в хвост, но ключ в order
   оставался на старой позиции + дублировался в хвосте — массивы разъезжались. */
describe('session order/items mirror invariant', () => {
  const mirror = (s) => JSON.stringify(s.order) === JSON.stringify(s.items.map((i) => i.key));

  test('skip → хвост, оба массива синхронны; второй skip → удаление, тоже синхронны', () => {
    const items = [
      SRS.makeItem({ id: 'a', word: 'a' }, 'en_ru', TODAY),
      SRS.makeItem({ id: 'b', word: 'b' }, 'en_ru', TODAY),
      SRS.makeItem({ id: 'c', word: 'c' }, 'en_ru', TODAY)
    ];
    const s = SRS.createSession(items, { today: TODAY });
    assert.ok(mirror(s), 'после createSession order === items keys');
    const r1 = SRS.sessionSkip(s, 'a:en_ru');
    assert.equal(r1, 'moved-to-tail');
    assert.ok(mirror(s), 'после первого skip order зеркалит items (регрессия призрака)');
    assert.equal(s.order[s.order.length - 1], 'a:en_ru', 'ключ в хвосте order');
    const r2 = SRS.sessionSkip(s, 'a:en_ru');
    assert.equal(r2, 'removed');
    assert.ok(mirror(s), 'после второго skip (removed) зеркало цело');
    assert.equal(s.items.length, 2);
  });

  test('requeue и ensure тоже сохраняют зеркало', () => {
    const items = [
      SRS.makeItem({ id: 'a', word: 'a' }, 'en_ru', TODAY),
      SRS.makeItem({ id: 'b', word: 'b' }, 'en_ru', TODAY)
    ];
    const s = SRS.createSession(items, { today: TODAY });
    SRS.sessionRequeue(s, s.items[0]);
    assert.ok(mirror(s), 'requeue вставил копию в оба массива на одну позицию');
    SRS.sessionEnsure(s, { id: 'a', word: 'a', status: 'ACTIVE' }, ['ru_en'], TODAY, 'learn');
    assert.ok(mirror(s), 'ensure вставил вторую сторону синхронно');
  });
});
