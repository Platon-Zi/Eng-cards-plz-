const path = require('path');
// Functional test: theme.js behaviour inside jsdom (no layout needed).
// Usage: node .scratch/ui/theme_test.cjs
const fs = require('fs');
const { JSDOM } = require('/home/zinko/ENG CARDS/.verify/node_modules/jsdom');

const ROOT = path.join(__dirname, '..', '..');
let rawHtml = fs.readFileSync(ROOT + '/index.html', 'utf8');
// drop external scripts (app.js/srs.js/data are out of scope for this test);
// keep inline head shim — it must run during parse, exactly like production.
rawHtml = rawHtml.replace(/<script src="[^"]+"><\/script>/g, '');
const themeSrc = fs.readFileSync(ROOT + '/theme.js', 'utf8');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failures++; };
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const key = (w, el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function boot(seed, breakStorage) {
  return new Promise(resolve => {
    const dom = new JSDOM(rawHtml, {
      runScripts: 'dangerously',
      url: 'http://localhost/',
      beforeParse(window) {
        if (breakStorage) {
          Object.defineProperty(window, 'localStorage', {
            get() { throw new window.DOMException('denied', 'SecurityError'); }
          });
        } else if (seed) {
          window.localStorage.setItem('eng_cards_theme', seed);
        }
      }
    });
    dom.window.addEventListener('load', () => resolve(dom));
  });
}

(async () => {
  /* ===== scenario 1: fresh boot ===== */
  {
    const dom = await boot(null);
    const { window } = dom; const { document } = window;
    ok(document.documentElement.getAttribute('data-theme') === 'beta', 'S1 fresh boot → data-theme=beta');
    let events = [];
    document.addEventListener('themechange', e => events.push(e.detail.theme));
    window.eval(themeSrc); // readyState complete → init() runs synchronously
    ok(events.length === 1 && events[0] === 'beta', 'S1 initial themechange fired once (beta)');
    const btn = document.getElementById('theme-picker-btn');
    const menu = document.getElementById('theme-picker-menu');
    const items = [...menu.querySelectorAll('.theme-picker-item')];
    ok(items.length === 4, 'S1 menu built with 4 items');
    ok(items.every(i => i.getAttribute('role') === 'menuitemradio'), 'S1 items are role=menuitemradio');
    ok(items.map(i => i.getAttribute('aria-checked')).join(',') === 'true,false,false,false', 'S1 beta marked active');
    ok(items.map(i => i.querySelector('.theme-picker-item-label span').textContent).join('|') === 'Beta palette|Midnight|Moonlight|Sandstone', 'S1 English labels: ' + items.map(i => i.querySelector('.theme-picker-item-label span').textContent).join('|'));
    ok(items.every(i => i.querySelectorAll('.theme-picker-swatches i').length === 4), 'S1 each item shows 4 preview swatches');
    ok(menu.hidden === true, 'S1 menu starts closed');

    /* open via click */
    click(window, btn);
    ok(menu.hidden === false && btn.getAttribute('aria-expanded') === 'true', 'S1 click opens menu + aria-expanded=true');
    ok(document.activeElement === items[0], 'S1 focus moves to checked item');

    /* Escape closes, refocuses, and does NOT leak to bubble-phase document listeners */
    let leaked = 0;
    document.addEventListener('keydown', () => leaked++);
    key(window, items[0], 'Escape');
    ok(menu.hidden === true && btn.getAttribute('aria-expanded') === 'false', 'S1 Escape closes menu');
    ok(document.activeElement === btn, 'S1 Escape refocuses the button');
    ok(leaked === 0, 'S1 Escape swallowed while menu open (app.js handler protected)');
    key(window, btn, 'Escape');
    ok(leaked === 1, 'S1 Escape passes through when menu closed');
    document.removeEventListener('keydown', () => {});

    /* keyboard: ArrowDown opens; arrows move; Enter selects */
    key(window, btn, 'ArrowDown');
    ok(menu.hidden === false && document.activeElement === items[0], 'S1 ArrowDown opens + focuses checked');
    key(window, items[0], 'ArrowDown');
    ok(document.activeElement === items[1], 'S1 ArrowDown moves to next item');
    key(window, items[1], 'End');
    ok(document.activeElement === items[3], 'S1 End jumps to last');
    key(window, items[3], 'ArrowDown');
    ok(document.activeElement === items[0], 'S1 ArrowDown wraps around');
    key(window, items[0], 'Home');
    ok(document.activeElement === items[0], 'S1 Home jumps to first');

    /* select Midnight via Enter (native click on button) */
    events = [];
    key(window, items[1], 'ArrowUp'); // → items[0]? no: ArrowUp from 0 wraps to 2; reposition:
    // reset focus to Midnight (items[1])
    items[1].focus();
    items[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    click(window, items[1]); // jsdom: Enter does not auto-click; simulate the native behaviour
    ok(document.documentElement.getAttribute('data-theme') === 'midnight', 'S1 selecting Midnight applies data-theme');
    ok(window.localStorage.getItem('eng_cards_theme') === 'midnight', 'S1 selection persisted to localStorage');
    ok(events.length === 1 && events[0] === 'midnight', 'S1 themechange fired with detail.theme=midnight');
    ok(menu.hidden === true && document.activeElement === btn, 'S1 menu closed + refocus after selection');
    ok(items.map(i => i.getAttribute('aria-checked')).join(',') === 'false,true,false,false', 'S1 aria-checked moved to Midnight');
    dom.window.close();
  }

  /* ===== scenario 2: seeded storage → head shim applies before scripts ===== */
  {
    const dom = await boot('light');
    const { window } = dom; const { document } = window;
    ok(document.documentElement.getAttribute('data-theme') === 'light', 'S2 head shim applied stored theme (light) pre-paint');
    window.eval(themeSrc);
    const items = [...document.querySelectorAll('.theme-picker-item')];
    ok(items.map(i => i.getAttribute('aria-checked')).join(',') === 'false,false,true,false', 'S2 Light marked active on load');
    ok(window.localStorage.getItem('eng_cards_theme') === 'light', 'S2 storage untouched');
    dom.window.close();
  }

  /* ===== scenario 3: junk stored value → normalised to beta ===== */
  {
    const dom = await boot('neon-unicorn');
    const { window } = dom; const { document } = window;
    ok(document.documentElement.getAttribute('data-theme') === 'beta', 'S3 junk value ignored → beta');
    window.eval(themeSrc);
    ok(window.localStorage.getItem('eng_cards_theme') === 'beta', 'S3 junk value normalised in storage');
    dom.window.close();
  }

  /* ===== scenario 4: localStorage throws (private mode) → no crash ===== */
  {
    const dom = await boot(null, true);
    const { window } = dom; const { document } = window;
    ok(document.documentElement.getAttribute('data-theme') === 'beta', 'S4 shim survived storage throw → beta');
    let threw = null;
    try { window.eval(themeSrc); } catch (e) { threw = e; }
    ok(threw === null, 'S4 theme.js init survived storage throw' + (threw ? ': ' + threw.message : ''));
    const items = [...document.querySelectorAll('.theme-picker-item')];
    ok(items.length === 4, 'S4 menu still built');
    click(window, document.getElementById('theme-picker-btn'));
    click(window, items[2]);
    ok(document.documentElement.getAttribute('data-theme') === 'light', 'S4 selection still applies (session-only)');
    dom.window.close();
  }

  /* ===== scenario 5: outside click closes ===== */
  {
    const dom = await boot(null);
    const { window } = dom; const { document } = window;
    window.eval(themeSrc);
    const btn = document.getElementById('theme-picker-btn');
    const menu = document.getElementById('theme-picker-menu');
    click(window, btn);
    ok(!menu.hidden, 'S5 menu open');
    click(window, document.body);
    ok(menu.hidden && btn.getAttribute('aria-expanded') === 'false', 'S5 outside click closes menu');
    /* re-open then Tab inside closes */
    click(window, btn);
    const items = [...menu.querySelectorAll('.theme-picker-item')];
    key(window, items[0], 'Tab');
    ok(menu.hidden, 'S5 Tab dismisses menu');
    dom.window.close();
  }

  console.log(`\n=== ${failures === 0 ? 'ALL THEME.JS TESTS PASS' : failures + ' THEME FAILURE(S)'} ===`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
