/* ==========================================================================
   THEME.JS — colour-theme mini-menu (top-left of the titlebar).
   --------------------------------------------------------------------------
   Owns EVERYTHING about theming; app.js is deliberately not involved.
   • Reads/writes localStorage under the single key "eng_cards_theme".
   • Applies html[data-theme="beta"|"midnight"|"light"|"sandstone"] (default: beta).
   • Builds the popover items (role="menuitemradio" + aria-checked + swatches)
     into #theme-picker-menu and wires the #theme-picker-btn toggle.
   • Closes on outside click, on Escape (capture phase, so app.js's Escape →
     exit-training handler is not triggered while the menu is open) and on
     selection; roving focus with ArrowUp/ArrowDown/Home/End; Tab closes.
   • Degrades gracefully when localStorage throws (private mode / disabled
     storage): the page keeps working on the beta default, nothing crashes.
   • Fires document-level "themechange" (bubbles, detail:{theme}) once on
     load — from its own DOMContentLoaded listener, which runs after app.js's
     because theme.js is the last <script> — and synchronously on every user
     selection. app.js consumes it to re-render the #chart-stages donut from
     the --grp-*-rgb tokens (see themes.css header for the contract).
   • The anti-FOUC inline script in index.html <head> mirrors the stored key
     onto <html> before first paint; this file is the single place that may
     WRITE the key.
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'eng_cards_theme';
  var DEFAULT_THEME = 'beta';

  /* English labels + representative swatches (bg · primary · success · warn) */
  var THEMES = [
    {
      id: 'beta',
      label: 'Beta palette',
      note: 'The original vivid look',
      swatches: ['#0f172a', '#6366f1', '#10b981', '#f59e0b']
    },
    {
      id: 'midnight',
      label: 'Midnight',
      note: 'Arctic glacier, zero glare',
      swatches: ['#051219', '#6bc8d3', '#5cceb7', '#e2bf76']
    },
    {
      id: 'light',
      label: 'Moonlight',
      note: 'Nordic frost daylight',
      swatches: ['#e8f2f5', '#00617c', '#006845', '#9e4200']
    },
    {
      id: 'sandstone',
      label: 'Sandstone',
      note: 'Warm clay daylight',
      swatches: ['#f5f0e4', '#923500', '#256b3a', '#00727d']
    }
  ];

  function isKnown(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return true;
    return false;
  }

  /* ---- storage (never throws) ---- */
  function readStored() {
    try { return window.localStorage.getItem(STORAGE_KEY); }
    catch (e) { return null; }
  }
  function writeStored(id) {
    try { window.localStorage.setItem(STORAGE_KEY, id); }
    catch (e) { /* private mode: theme stays session-only */ }
  }

  function attrTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    return isKnown(attr) ? attr : DEFAULT_THEME;
  }

  var btn = null, menu = null, dot = null;

  function dispatchThemeEvent(id) {
    try {
      document.dispatchEvent(new CustomEvent('themechange', {
        detail: { theme: id },
        bubbles: true
      }));
    } catch (e) { /* very old engines: the event only drives chart repaints */ }
  }

  function syncUI(id) {
    if (menu) {
      var items = menu.querySelectorAll('.theme-picker-item');
      for (var i = 0; i < items.length; i++) {
        items[i].setAttribute('aria-checked', String(items[i].getAttribute('data-theme') === id));
      }
    }
    if (btn) {
      /* show WHICH theme is active in tooltip / SR without opening the menu */
      var lbl = id;
      for (var j = 0; j < THEMES.length; j++) if (THEMES[j].id === id) lbl = THEMES[j].label;
      btn.title = 'Colour theme · ' + lbl;
      btn.setAttribute('aria-label', 'Colour theme: ' + lbl);
    }
    if (dot) {
      /* let the dot follow the live token so it is correct in every theme */
      try {
        var accent = window.getComputedStyle(document.documentElement)
          .getPropertyValue('--accent-primary');
        if (accent && accent.trim()) dot.style.background = accent.trim();
      } catch (e) { /* computed style unavailable: keep CSS default */ }
    }
  }

  /* Electron-only nicety: the native window-control strip (titleBarOverlay,
     Windows/macOS) and the persisted startup colour follow the chosen theme,
     so light themes no longer open behind a dark 38px block / dark flash.
     Plain browser (`npm run serve`) has no require() → silent no-op. */
  function syncWindowChrome(id) {
    try {
      if (typeof require !== 'function') return;
      var electron = require('electron');
      if (!electron || !electron.ipcRenderer) return;
      var cs = window.getComputedStyle(document.documentElement);
      var strip = (cs.getPropertyValue('--bg-sidebar') || '').trim();
      var symbol = (cs.getPropertyValue('--text-muted') || '').trim();
      if (!/^#[0-9a-fA-F]{3,8}$/.test(strip)) return;
      electron.ipcRenderer.send('theme:window', {
        id: id,
        color: strip,
        symbol: /^#[0-9a-fA-F]{3,8}$/.test(symbol) ? symbol : '#94a3b8'
      });
    } catch (e) { /* no native chrome to sync here */ }
  }

  /* Applies attribute + persists + syncs UI + notifies. Single entry point. */
  function applyTheme(id, persist) {
    if (!isKnown(id)) id = DEFAULT_THEME;
    document.documentElement.setAttribute('data-theme', id);
    if (persist !== false) writeStored(id);
    syncUI(id);
    dispatchThemeEvent(id);
    syncWindowChrome(id);
  }

  /* ---- popover ---- */
  function isOpen() { return !!menu && !menu.hidden; }

  function openMenu() {
    if (!btn || !menu) return;
    syncUI(attrTheme());
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    var checked = menu.querySelector('.theme-picker-item[aria-checked="true"]');
    (checked || menu.querySelector('.theme-picker-item') || btn).focus();
  }

  function closeMenu(refocus) {
    if (!btn || !menu || menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }

  function menuItems() {
    return menu ? [].slice.call(menu.querySelectorAll('.theme-picker-item')) : [];
  }

  function buildMenu() {
    if (!menu) return;
    menu.textContent = '';

    var title = document.createElement('div');
    title.className = 'theme-picker-title';
    title.id = 'theme-picker-menu-title';
    title.textContent = 'Colour theme';
    title.setAttribute('role', 'presentation'); // menu must only own menuitem* children
    menu.appendChild(title);
    menu.setAttribute('aria-labelledby', 'theme-picker-menu-title');

    var current = attrTheme();
    THEMES.forEach(function (t) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'theme-picker-item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('data-theme', t.id);
      item.setAttribute('aria-checked', String(t.id === current));

      var sw = document.createElement('span');
      sw.className = 'theme-picker-swatches';
      sw.setAttribute('aria-hidden', 'true');
      t.swatches.forEach(function (c) {
        var chip = document.createElement('i');
        chip.style.background = c;
        sw.appendChild(chip);
      });

      var label = document.createElement('span');
      label.className = 'theme-picker-item-label';
      var name = document.createElement('span');
      name.textContent = t.label;
      var note = document.createElement('span');
      note.className = 'theme-picker-item-note';
      note.textContent = t.note;
      label.appendChild(name);
      label.appendChild(note);

      var check = document.createElement('span');
      check.className = 'theme-picker-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';

      item.appendChild(sw);
      item.appendChild(label);
      item.appendChild(check);

      item.addEventListener('click', function () {
        applyTheme(t.id);
        closeMenu(true);
      });

      menu.appendChild(item);
    });
  }

  function wireEvents() {
    /* toggle on click (Enter/Space fire native click on <button>) */
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isOpen()) closeMenu(true); else openMenu();
    });

    /* ArrowDown on the closed button opens the menu (menu-button pattern) */
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Down') { e.preventDefault(); openMenu(); }
    });

    /* roving focus inside the menu; Tab dismisses */
    menu.addEventListener('keydown', function (e) {
      var items = menuItems();
      var idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      switch (e.key) {
        case 'ArrowDown': case 'Down':
          e.preventDefault(); items[(idx + 1) % items.length].focus(); break;
        case 'ArrowUp': case 'Up':
          e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); break;
        case 'Home':
          e.preventDefault(); items[0].focus(); break;
        case 'End':
          e.preventDefault(); items[items.length - 1].focus(); break;
        case 'Tab':
          closeMenu(false); break;
      }
    });

    /* Escape closes the menu and does NOT leak to app.js handlers
       (capture phase + stopPropagation, only while open) */
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && isOpen()) {
        e.stopPropagation();
        e.preventDefault();
        closeMenu(true);
      }
    }, true);

    /* outside click closes */
    document.addEventListener('click', function (e) {
      if (!isOpen()) return;
      var picker = document.getElementById('theme-picker');
      if (picker && picker.contains(e.target)) return;
      closeMenu(false);
    });
  }

  function init() {
    btn = document.getElementById('theme-picker-btn');
    menu = document.getElementById('theme-picker-menu');
    dot = document.getElementById('theme-picker-dot');
    if (!btn || !menu) return; /* markup absent: stay silent, break nothing */

    /* Normalise: stored value wins; junk/absent → beta (persisted once so the
       head shim and this file can never disagree). */
    var stored = readStored();
    var start = isKnown(stored) ? stored : DEFAULT_THEME;
    document.documentElement.setAttribute('data-theme', start);
    if (stored !== start) writeStored(start);

    buildMenu();
    syncUI(start);
    wireEvents();

    /* Contract with app.js charts: one themechange after load. This runs
       inside theme.js's DOMContentLoaded listener (registered after app.js's,
       since theme.js is the last script), so app.js is already initialised. */
    dispatchThemeEvent(start);
    syncWindowChrome(start);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
