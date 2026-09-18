// ─────────────────────────────────────────────────────────────────────────────
// dom-env.cjs — reusable jsdom loader for the ENG CARDS SPA verification harness.
//
// Builds a jsdom window from the REAL index.html, inlining the page scripts in
// the production order  data/leitner_data.js → srs.js → app.js → theme.js
// (srs.js MUST run before app.js: app.js needs the global SRS at eval time).
//
// Stubs what jsdom lacks (canvas 2D context, speechSynthesis, clipboard, …),
// optionally pins window.Date to a FIXED calendar date so SRS.todayString()
// (and every date derived from it) is deterministic, optionally injects a
// custom state object in place of data/leitner_data.js, awaits the async
// initApp() chain, and returns helpers to drive the UI with real DOM events.
//
// Usage:
//   const { createDomEnv } = require('./helpers/dom-env.cjs');
//   const env = await createDomEnv({ state, fixedDate: '2026-09-17', label: 'main' });
//   env.click('#btn-hero-start-practice');
//   await env.tick(30);
//   const card = env.card('card_123');          // JSON snapshot via app.js cardById()
//   env.close();
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VERIFY_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(VERIFY_DIR, '..');
// jsdom lives in .verify/node_modules (its own package.json); resolve it from there
// so the harness works no matter which cwd node was started from.
const { JSDOM, VirtualConsole } = require(path.join(VERIFY_DIR, 'node_modules', 'jsdom'));

const SCRIPT_ORDER = ['data/leitner_data.js', 'srs.js', 'app.js', 'theme.js'];
const BUCKETS = ['bank', 'new', 'learning', 'familiar', 'confident', 'mastered'];
const ANSWER_BTNS = { again: '#btn-answer-again', hard: '#btn-answer-hard', easy: '#btn-answer-easy' };

/* ───────────────────────── small utilities ───────────────────────── */

function readSource(rel) {
  return fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function loadJson(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  return JSON.parse(stripBom(fs.readFileSync(p, 'utf8')));
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Order-insensitive structural equality for JSON-round-tripped values. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function stableStringify(v, maxLen) {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) + `…(${s.length}b)` : s;
}

/* ───────────────────────── minimal test runner ───────────────────────── */

/**
 * createRunner(title) → { t, section, finish, pass, total, failures }
 *   t(name, cond, extra)  — record one check; extra is printed on failure.
 *   section(name, fn)     — run an async block; a crash becomes one failed check.
 *   finish()              — print `PASS n/m` or `FAIL n/m` and return exit code.
 */
function createRunner(title) {
  const results = [];
  const runner = {
    title,
    results,
    get pass() { return results.filter(r => r.ok).length; },
    get total() { return results.length; },
    get failures() { return results.filter(r => !r.ok); },
    t(name, cond, extra) {
      const ok = !!cond;
      const kb = /^KNOWN-BLOCKER\b/.test(name);
      results.push({ name, ok, kb, extra: extra === undefined ? '' : String(extra) });
      console.log(`${ok ? '✅' : kb ? '🚧' : '❌'} ${name}${!ok && extra !== undefined && extra !== '' ? '\n     ↳ ' + String(extra).split('\n').join('\n     ') : ''}`);
      return ok;
    },
    async section(name, fn) {
      console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
      try {
        await fn(runner);
      } catch (e) {
        runner.t(`${name}: SECTION CRASHED — ${e && e.message}`, false,
          e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : String(e));
      }
    },
    finish() {
      const failed = runner.failures;
      const kb = failed.filter((f) => f.kb);
      const real = failed.filter((f) => !f.kb);
      console.log('');
      if (failed.length) {
        console.log('Failed checks:');
        for (const f of failed) console.log(`  ${f.kb ? '🚧' : '•'} ${f.name}${f.extra ? '\n      ' + f.extra.split('\n').join('\n      ') : ''}`);
      }
      let line;
      if (!failed.length) line = `PASS ${runner.pass}/${runner.total} — ${title}`;
      else if (!real.length) line = `FAIL ${runner.pass}/${runner.total} (${kb.length} failed — ALL KNOWN-BLOCKER: genuine read-only-file bugs, see report) — ${title}`;
      else line = `FAIL ${runner.pass}/${runner.total} (${real.length} failed${kb.length ? ` + ${kb.length} KNOWN-BLOCKER` : ''}) — ${title}`;
      console.log(`\n${line}`);
      return failed.length ? 1 : 0;
    },
  };
  return runner;
}

/* ───────────────────────── canvas 2D context stub ───────────────────────── */

function makeCanvasContextStub() {
  const noop = () => {};
  return {
    canvas: null,
    save: noop, restore: noop, scale: noop, translate: noop, rotate: noop, transform: noop,
    setTransform: noop, resetTransform: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
    rect: noop, roundRect: noop, ellipse: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    fill: noop, stroke: noop, clip: noop,
    fillText: noop, strokeText: noop, drawImage: noop, putImageData: noop,
    setLineDash: noop, getLineDash: () => [],
    measureText: (txt) => ({
      width: String(txt == null ? '' : txt).length * 6,
      actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
    }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: 'transparent', miterLimit: 10, lineDashOffset: 0,
  };
}

/* ───────────────────────── the environment factory ───────────────────────── */

/**
 * createDomEnv(opts) → env
 *
 * opts:
 *   state          — object injected as window.LEITNER_DATA (replaces the real
 *                    data/leitner_data.js script). Deep-cloned before use.
 *                    Omit to load the real data file.
 *   stateFixture   — 'legacy-198': inject .verify/fixtures/legacy-198.json
 *                    (schema 1, BOM'd) instead — exercises startup migration.
 *   fixedDate      — 'YYYY-MM-DD': pin window.Date to that LOCAL calendar day
 *                    (noon), so SRS.todayString() and everything derived from
 *                    "today" is deterministic. null = real clock.
 *   confirmResult  — boolean or fn(msg)→boolean for window.confirm (default true;
 *                    every call is recorded in env.confirms).
 *   loadTheme      — load theme.js (default true).
 *   label          — name used in error messages.
 *   readyTimeoutMs — initApp wait budget (default 20000).
 *
 * Returned env:
 *   window, document, SRS (window.SRS), context (vm context)
 *   evalIn(code)            — run code in the window's global scope; SEES the
 *                             script-level let/const bindings of app.js
 *                             (appState, srsSession, currentTrainingItem, …).
 *   tick(ms=10)             — promise resolving after real timers flush.
 *   click(elOrSelector)     — dispatch a real bubbling MouseEvent.
 *   key(k, evOpts)          — dispatch KeyboardEvent('keydown') on window.
 *   card(id)                — JSON snapshot of a live card via app.js cardById().
 *   snapshotState()         — JSON snapshot of the whole appState.
 *   activeScreen()          — id of the '.screen.active' element or null.
 *   problems / warnings     — captured uncaught errors / console.warn+error.
 *   takeProblems()          — drain and return problems captured so far.
 *   spoken, confirms        — speechSynthesis.speak() texts, confirm() messages.
 *   todayString()           — what the window kernel thinks "today" is.
 *   close()                 — tear down the jsdom window (stops timers).
 */
async function createDomEnv(opts) {
  opts = opts || {};
  const label = opts.label || 'env';
  const readyTimeoutMs = Number.isFinite(opts.readyTimeoutMs) ? opts.readyTimeoutMs : 20000;

  const problems = [];   // uncaught errors, jsdomError, console.error
  const warnings = [];   // console.warn
  const spoken = [];
  const confirms = [];

  /* 1. Assemble the page: real index.html with the four scripts inlined in
        production order. Inlining (instead of resources:'usable' + file URLs)
        keeps the origin http://localhost (localStorage works) and lets us swap
        the data script for an injected state. */
  let html = readSource('index.html');
  const sources = {
    'data/leitner_data.js': readSource('data/leitner_data.js'),
    'srs.js': readSource('srs.js'),
    'app.js': readSource('app.js'),
    'theme.js': readSource('theme.js'),
  };

  let injectedState = null;
  if (opts.state) injectedState = deepClone(opts.state);
  else if (opts.stateFixture === 'legacy-198') {
    injectedState = loadJson(path.join(VERIFY_DIR, 'fixtures', 'legacy-198.json'));
  }
  if (injectedState) {
    // JSON as a JS literal: escape '<' (kills any </script> sequence) and the
    // U+2028/29 line separators that are legal JSON but illegal in JS source.
    sources['data/leitner_data.js'] =
      'window.LEITNER_DATA = ' +
      JSON.stringify(injectedState)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029') + ';';
  }

  for (const rel of SCRIPT_ORDER) {
    if (rel === 'theme.js' && opts.loadTheme === false) {
      html = html.replace(`<script src="${rel}"></script>`, '<!-- theme.js skipped by harness -->');
      continue;
    }
    const tag = `<script src="${rel}"></script>`;
    if (!html.includes(tag)) throw new Error(`[dom-env:${label}] index.html has no ${tag} — load order contract broken`);
    html = html.replace(tag, `<script>/* ${rel} — inlined by dom-env.cjs */\n${sources[rel]}\n</script>`);
  }

  /* 2. Console plumbing: capture, never crash. */
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => problems.push(`jsdomError: ${e && (e.stack || e.message) || e}`));
  vc.on('error', (...a) => problems.push('console.error: ' + a.map((x) => (x && x.stack) || String(x)).join(' ')));
  vc.on('warn', (...a) => warnings.push('console.warn: ' + a.map((x) => (x && x.stack) || String(x)).join(' ')));
  vc.on('log', () => {});
  vc.on('info', () => {});
  vc.on('debug', () => {});

  /* 3. Boot the window; beforeParse installs stubs BEFORE any page script. */
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole: vc,
    beforeParse(window) {
      // — Fixed date: subclass the window's Date so `new Date()` is local noon
      //   of the requested day. SRS.todayString() formats via Intl in local
      //   time → returns exactly fixedDate regardless of the host timezone.
      if (opts.fixedDate) {
        const parts = String(opts.fixedDate).split('-').map(Number);
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
          throw new Error(`[dom-env:${label}] bad fixedDate: ${opts.fixedDate}`);
        }
        const RealDate = window.Date;
        const fixedTime = new RealDate(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0).getTime();
        class PinnedDate extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(fixedTime);
            else super(...args);
          }
          static now() { return fixedTime; }
        }
        window.Date = PinnedDate;
      }

      // — Canvas 2D: jsdom has no getContext without the (uninstalled) canvas
      //   package; app.js fallback charts + confetti only need no-op methods.
      window.HTMLCanvasElement.prototype.getContext = function () {
        if (!this.__ctxStub) { this.__ctxStub = makeCanvasContextStub(); this.__ctxStub.canvas = this; }
        return this.__ctxStub;
      };

      // — Speech synthesis: record utterances instead of speaking.
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true, writable: true,
        value: {
          speaking: false, pending: false, paused: false, onvoiceschanged: null,
          getVoices: () => [
            { lang: 'en-US', name: 'Google US English' },
            { lang: 'ru-RU', name: 'Microsoft Irina' },
          ],
          speak: (u) => { spoken.push(u && u.text); },
          cancel: () => {}, pause: () => {}, resume: () => {},
          addEventListener: () => {}, removeEventListener: () => {},
          dispatchEvent: () => true,
        },
      });
      window.SpeechSynthesisUtterance = function (text) {
        this.text = text; this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1;
        this.voice = null; this.onstart = null; this.onend = null; this.onerror = null;
      };

      // — rAF: run callbacks on fast timers so animations (confetti) drain
      //   quickly instead of holding the event loop for wall-clock seconds.
      window.requestAnimationFrame = (cb) => window.setTimeout(() => {
        try { cb(window.performance ? window.performance.now() : RealDateNowShim()); } catch (e) { problems.push('rAF callback threw: ' + e.message); }
      }, 0);
      window.cancelAnimationFrame = (id) => window.clearTimeout(id);
      function RealDateNowShim() { return new window.Date().getTime(); }

      // — Dialogs & clipboard.
      window.confirm = (msg) => {
        confirms.push(String(msg));
        return typeof opts.confirmResult === 'function' ? !!opts.confirmResult(msg)
          : opts.confirmResult === undefined ? true : !!opts.confirmResult;
      };
      window.alert = () => {};
      window.prompt = (_q, def) => (def === undefined ? '' : String(def));
      try {
        Object.defineProperty(window.navigator, 'clipboard', {
          configurable: true, value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
        });
      } catch (e) { /* navigator shape changed — non-fatal */ }
      window.URL.createObjectURL = () => 'blob:harness-stub';
      window.URL.revokeObjectURL = () => {};
      window.print = () => {};

      // — Uncaught error collectors.
      window.addEventListener('error', (e) => problems.push('error event: ' + ((e.error && e.error.stack) || e.message)));
      window.addEventListener('unhandledrejection', (e) => problems.push('unhandledrejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))));
    },
  });

  const window = dom.window;
  const context = dom.getInternalVMContext();
  const evalIn = (code, filename) => vm.runInContext(code, context, { filename: filename || `dom-env(${label})-eval` });
  const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 10 : ms));

  /* 4. initApp() is async (awaits loadData + saveData). Poll for its final
        observable side effects: appState defined, spelling screen initialised
        (the LAST call of initApp), dashboard KPI rendered. */
  let ready = false;
  let lastEvalErr = null;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await tick(5);
    try {
      ready = evalIn(`!!(typeof appState !== 'undefined' && appState && Array.isArray(appState.cards)
        && typeof isSpellingInitialized !== 'undefined' && isSpellingInitialized === true
        && document.getElementById('dash-total') && document.getElementById('dash-total').textContent !== '')`);
    } catch (e) { lastEvalErr = e; }
    if (ready) break;
  }
  if (!ready) {
    const details = problems.slice(0, 8).map((p) => '  • ' + p.split('\n').slice(0, 3).join('\n    ')).join('\n');
    try { dom.window.close(); } catch (e) {}
    throw new Error(
      `[dom-env:${label}] initApp() did not finish within ${readyTimeoutMs}ms.` +
      `\nlast eval error: ${lastEvalErr && lastEvalErr.message}` +
      `\ncaptured problems (${problems.length}):\n${details || '  (none)'}`
    );
  }
  await tick(50); // let the async tail settle: saveData writes, theme.js DOMContentLoaded init + first themechange re-render

  const env = {
    label,
    window,
    document: window.document,
    context,
    get SRS() { return window.SRS; },
    evalIn,
    /** evalIn a snippet that RETURNS A JSON STRING and parse it in Node —
     *  use for arrays/objects (evalIn itself returns raw cross-realm values;
     *  JSON.stringify inside the window + parse here avoids realm mixups). */
    evalJson(code, filename) {
      const s = evalIn(code, filename);
      return s === undefined || s === null ? s : JSON.parse(s);
    },
    tick,
    problems,
    warnings,
    spoken,
    confirms,
    takeProblems() { const p = problems.slice(); problems.length = 0; return p; },
    /** Live (cross-realm) appState object — read/mutate with care. */
    get state() { return evalIn('appState'); },
    snapshotState() { return evalIn('JSON.parse(JSON.stringify(appState))'); },
    card(id) { return evalIn(`(function(){ const c = cardById(${JSON.stringify(String(id))}); return c ? JSON.parse(JSON.stringify(c)) : null; })()`); },
    todayString() { return evalIn('SRS.todayString()'); },
    activeScreen() {
      const s = window.document.querySelector('.screen.active');
      return s ? s.id : null;
    },
    /** Real bubbling click on an element or selector. Throws when missing. */
    click(target) {
      const el = typeof target === 'string' ? window.document.querySelector(target) : target;
      if (!el) throw new Error(`[dom-env:${label}] click target not found: ${target}`);
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return el;
    },
    /** keydown dispatched on window (app.js listens there, capture phase). */
    key(k, evOpts) {
      const o = Object.assign({ key: k, bubbles: true, cancelable: true }, evOpts || {});
      window.dispatchEvent(new window.KeyboardEvent('keydown', o));
    },
    /** Dispatch the app-level themechange event (same shape theme.js sends). */
    themeChange(theme) {
      window.document.dispatchEvent(new window.CustomEvent('themechange', {
        bubbles: true, detail: { theme: theme || 'midnight' },
      }));
    },
    close() { try { dom.window.close(); } catch (e) {} },
  };
  return env;
}

module.exports = {
  ROOT,
  VERIFY_DIR,
  SCRIPT_ORDER,
  BUCKETS,
  ANSWER_BTNS,
  createDomEnv,
  createRunner,
  readSource,
  loadJson,
  stripBom,
  deepClone,
  deepEqual,
  stableStringify,
};
