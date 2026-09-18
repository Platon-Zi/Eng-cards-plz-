/* ==========================================================================
   POLISH.JS — small render-ergonomics helpers that own ZERO app.js code.
   --------------------------------------------------------------------------
   Scroll memory: .content-area is the single scroll container shared by every
   screen, and app.js's switchScreen() never resets it — so after reading the
   Guide to the bottom, the next screen opens mid-blank. This file watches the
   class attribute of the .screen nodes app.js already toggles and rewinds the
   scroll to the top whenever the ACTIVE screen actually changes. Passive,
   idempotent, and silent no-op if the DOM shape differs.
   Loaded after theme.js; touches nothing else.
   ========================================================================== */
(function () {
  'use strict';

  function init() {
    var area = document.querySelector('main.content-area');
    if (!area || typeof MutationObserver !== 'function') return;
    var screens = document.querySelectorAll('.screen');
    if (!screens.length) return;

    function activeScreen() {
      for (var i = 0; i < screens.length; i++) {
        if (screens[i].classList.contains('active')) return screens[i];
      }
      return null;
    }
    var lastActive = activeScreen();

    var mo = new MutationObserver(function () {
      var now = activeScreen();
      if (now && now !== lastActive) {
        area.scrollTop = 0;
        lastActive = now;
      }
    });
    for (var i = 0; i < screens.length; i++) {
      mo.observe(screens[i], { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
