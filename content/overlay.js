/* Board overlay: best-move arrow(s) and a tiny draggable evaluation chip. */
(function () {
  'use strict';

  var core = CA.core;
  var api = globalThis.browser || globalThis.chrome;
  var promiseApi = !!(globalThis.browser && api === globalThis.browser);
  var POSITION_KEY = 'hudPosition';
  var COLORS = [
    { line: 'rgba(134, 219, 145, 0.94)', shadow: 'rgba(8, 12, 8, 0.38)' },
    { line: 'rgba(149, 203, 208, 0.60)', shadow: 'rgba(8, 12, 8, 0.30)' },
    { line: 'rgba(210, 166, 96, 0.62)', shadow: 'rgba(8, 12, 8, 0.26)' }
  ];

  function el(tag, cls, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }

  function setText(node, value) {
    value = value == null ? '' : String(value);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  /*
   * Viewport size that follows the collapsing mobile URL bar. window.innerHeight
   * is stale on Android after the bar hides or the keyboard opens; the chip
   * would then sit under the browser chrome.
   */
  function viewport() {
    var vv = window.visualViewport;
    if (vv && vv.width && vv.height) return { w: vv.width, h: vv.height };
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function openSettings() {
    try {
      if (api.runtime && typeof api.runtime.openOptionsPage === 'function') {
        var result = api.runtime.openOptionsPage();
        if (result && typeof result.catch === 'function') {
          result.catch(function () { openSettingsFallback(); });
        }
        return;
      }
    } catch (e) { /* fall through to a plain tab */ }
    openSettingsFallback();
  }

  function openSettingsFallback() {
    try {
      if (!api.tabs || typeof api.tabs.create !== 'function' ||
          !api.runtime || typeof api.runtime.getURL !== 'function') return;
      var result = api.tabs.create({ url: api.runtime.getURL('popup/popup.html') });
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (e) { /* nothing else to try */ }
  }

  function createOverlay() {
    var mounted = false;
    var root = null;
    var canvas = null;
    var ctx = null;
    var hud = null;
    var refs = {};
    var boardEl = null;
    var orientation = 'white';
    var rect = null;
    var state = {};
    var syncQueued = false;
    var hudPos = null;      // { x, y } in viewport pixels once the user moves it
    var drag = null;
    var lastTapAt = 0;
    var pressTimer = null;
    var longPressed = false;

    /* ------------------------------------------------------------- storage */

    function loadPosition() {
      if (!api || !api.storage || !api.storage.local) return;
      function apply(value) {
        if (!value || typeof value.x !== 'number' || typeof value.y !== 'number') return;
        hudPos = { x: value.x, y: value.y };
        scheduleSync();
      }
      try {
        if (promiseApi) {
          api.storage.local.get(POSITION_KEY).then(function (result) {
            apply(result && result[POSITION_KEY]);
          }, function () {});
        } else {
          api.storage.local.get(POSITION_KEY, function (result) {
            apply(result && result[POSITION_KEY]);
          });
        }
      } catch (e) { /* storage may be unavailable on removed extensions */ }
    }

    function savePosition() {
      if (!api || !api.storage || !api.storage.local) return;
      var patch = {};
      patch[POSITION_KEY] = hudPos ? { x: Math.round(hudPos.x), y: Math.round(hudPos.y) } : null;
      try {
        if (promiseApi) {
          api.storage.local.set(patch).catch(function () {});
        } else {
          api.storage.local.set(patch, function () {});
        }
      } catch (e) { /* ignore */ }
    }

    /* -------------------------------------------------------------- mounting */

    function mount() {
      if (mounted && root && root.isConnected) return;
      mounted = true;

      root = el('div', 'ca-root');
      root.id = 'ca-root';
      canvas = el('canvas', 'ca-canvas', root);
      canvas.id = 'ca-canvas';
      ctx = canvas.getContext('2d');

      hud = el('div', 'ca-hud', root);
      hud.id = 'ca-hud';
      refs.score = el('span', 'ca-hud__score', hud);
      refs.move = el('span', 'ca-hud__move', hud);
      refs.time = el('span', 'ca-hud__time', hud);
      refs.dot = el('span', 'ca-hud__dot', hud);

      bindDrag();

      (document.fullscreenElement || document.documentElement).appendChild(root);
      document.addEventListener('fullscreenchange', onFullscreen);
      window.addEventListener('resize', scheduleSync);
      window.addEventListener('scroll', scheduleSync, true);
      window.addEventListener('wheel', scheduleSync, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleSync);
        window.visualViewport.addEventListener('scroll', scheduleSync);
      }
      document.addEventListener('transitionend', scheduleSync, true);
      document.addEventListener('animationend', scheduleSync, true);
      setInterval(sync, 400);
      // The search clock ticks on its own: renderHud() only runs when the
      // position changes, which is not often enough for a running timer.
      setInterval(renderThink, 150);
      loadPosition();
      hide();
    }

    function onFullscreen() {
      var host = document.fullscreenElement || document.documentElement;
      if (root && root.parentElement !== host) host.appendChild(root);
      scheduleSync();
    }

    function scheduleSync() {
      if (syncQueued) return;
      syncQueued = true;
      requestAnimationFrame(function () {
        syncQueued = false;
        sync();
      });
    }

    function hide() {
      if (canvas) canvas.style.display = 'none';
      if (hud) hud.style.display = 'none';
    }

    /* ------------------------------------------------------------------ drag */

    function bindDrag() {
      hud.addEventListener('pointerdown', onPointerDown);
      hud.addEventListener('pointermove', onPointerMove);
      hud.addEventListener('pointerup', onPointerUp);
      hud.addEventListener('pointercancel', onPointerUp);
      hud.addEventListener('dblclick', function (event) {
        event.preventDefault();
        event.stopPropagation();
        resetPosition();
      });
      hud.addEventListener('click', function (event) { event.stopPropagation(); });
    }

    function resetPosition() {
      hudPos = null;
      savePosition();
      layoutHud();
    }

    function onPointerDown(event) {
      if (event.button != null && event.button !== 0) return;
      if (!hud) return;
      var box = hud.getBoundingClientRect();
      longPressed = false;
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: box.left,
        top: box.top,
        moved: false
      };
      // Press and hold opens the settings page. On a phone there is no toolbar
      // popup reachable while the board is on screen, so the chip doubles as
      // the settings entry point.
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        pressTimer = null;
        if (!drag || drag.moved) return;
        longPressed = true;
        drag = null;
        if (hud) hud.classList.remove('ca-hud--dragging');
        try {
          if (hud && event.pointerId != null && hud.hasPointerCapture &&
              hud.hasPointerCapture(event.pointerId)) {
            hud.releasePointerCapture(event.pointerId);
          }
        } catch (e) { /* ignore */ }
        openSettings();
      }, 650);
      try { hud.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      hud.classList.add('ca-hud--dragging');
      event.preventDefault();
      event.stopPropagation();
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      drag.moved = true;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }

      var v = viewport();
      var maxX = Math.max(4, v.w - hud.offsetWidth - 4);
      var maxY = Math.max(4, v.h - hud.offsetHeight - 4);
      var left = clamp(drag.left + dx, 4, maxX);
      var top = clamp(drag.top + dy, 4, maxY);
      hudPos = { x: left, y: top };
      hud.style.left = left + 'px';
      hud.style.top = top + 'px';
      event.preventDefault();
    }

    function onPointerUp(event) {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!drag) {
        longPressed = false;
        return;
      }
      var id = drag.pointerId;
      var moved = drag.moved;
      drag = null;
      try {
        if (hud.hasPointerCapture(id)) hud.releasePointerCapture(id);
      } catch (e) { /* ignore */ }
      hud.classList.remove('ca-hud--dragging');
      if (longPressed) {
        longPressed = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (moved) {
        lastTapAt = 0;
        savePosition();
        event.preventDefault();
        event.stopPropagation();
      } else {
        // Double-click without dragging also resets the chip. Detecting it on
        // pointerup keeps the gesture working even though pointerdown calls
        // preventDefault() for the drag.
        var now = Date.now();
        if (now - lastTapAt < 350) {
          lastTapAt = 0;
          resetPosition();
        } else {
          lastTapAt = now;
        }
      }
    }

    /* ----------------------------------------------------------------- board */

    function setBoard(board, boardOrientation) {
      if (boardEl !== board) {
        boardEl = board || null;
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (boardOrientation) orientation = boardOrientation;
      scheduleSync();
    }

    function update(next) {
      state = next || {};
      renderHud();
      scheduleSync();
    }

    function sync() {
      if (!mounted || !boardEl || !boardEl.isConnected || !canvas) {
        hide();
        return;
      }
      var r;
      try { r = boardEl.getBoundingClientRect(); } catch (e) { hide(); return; }
      var vp = viewport();
      if (!r || r.width < 120 || r.height < 120 ||
          r.right < 10 || r.bottom < 10 ||
          r.left > vp.w - 10 || r.top > vp.h - 10) {
        hide();
        return;
      }
      rect = r;
      if (state.showArrow) {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var pw = Math.max(1, Math.round(r.width * dpr));
        var ph = Math.max(1, Math.round(r.height * dpr));
        if (canvas.width !== pw || canvas.height !== ph) {
          canvas.width = pw;
          canvas.height = ph;
        }
        canvas.style.display = 'block';
        canvas.style.left = r.left + 'px';
        canvas.style.top = r.top + 'px';
        canvas.style.width = r.width + 'px';
        canvas.style.height = r.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, r.width, r.height);
        paint();
      } else {
        canvas.style.display = 'none';
      }
      layoutHud();
    }

    function layoutHud() {
      if (!hud) return;
      if (!state.showHud || !rect) {
        hud.style.display = 'none';
        return;
      }
      hud.style.display = 'flex';
      if (drag) return;

      var v = viewport();
      var w = hud.offsetWidth || 150;
      var h = hud.offsetHeight || 28;

      if (hudPos) {
        var left = clamp(hudPos.x, 4, Math.max(4, v.w - w - 4));
        var top = clamp(hudPos.y, 4, Math.max(4, v.h - h - 4));
        hud.style.left = Math.round(left) + 'px';
        hud.style.top = Math.round(top) + 'px';
        return;
      }

      // Default: centered just above the board, flipped below if there is no
      // room. The chip stays put once the user drags it elsewhere.
      var x = rect.left + (rect.width - w) / 2;
      x = clamp(x, 8, Math.max(8, v.w - w - 8));
      hud.style.left = Math.round(x) + 'px';

      var y = rect.top - h - 8;
      if (y < 8) y = rect.bottom + 8;
      if (y + h > v.h - 8) y = rect.top + 6;
      hud.style.top = Math.round(clamp(y, 6, Math.max(6, v.h - h - 6))) + 'px';
    }

    function paint() {
      if (!ctx || !rect) return;
      ctx.clearRect(0, 0, rect.width, rect.height);
      var lines = state.lines || [];
      if (!state.showArrow || !lines.length) return;
      var cell = Math.min(rect.width, rect.height) / 8;
      for (var i = lines.length - 1; i >= 0; i--) {
        drawArrow(lines[i], i, cell);
      }
    }

    function squarePoint(index, cell) {
      var f = core.fileOf(index);
      var r = core.rankOf(index);
      var col = orientation === 'white' ? f : 7 - f;
      var row = orientation === 'white' ? 7 - r : r;
      return { x: (col + 0.5) * cell, y: (row + 0.5) * cell };
    }

    function drawArrow(line, index, cell) {
      var move = core.uciToMove(line.uci);
      if (!move) return;
      var color = COLORS[Math.min(index, COLORS.length - 1)];
      var a = squarePoint(move.from, cell);
      var b = squarePoint(move.to, cell);

      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);

      // A king/pawn step is too short for an arrow: a small dot reads better.
      if (len < cell * 0.4) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, cell * 0.10, 0, Math.PI * 2);
        ctx.fillStyle = color.line;
        ctx.fill();
        return;
      }

      var ux = dx / len;
      var uy = dy / len;

      var startPad = cell * 0.21;
      var endPad = cell * 0.19;
      var sx = a.x + ux * startPad;
      var sy = a.y + uy * startPad;
      var ex = b.x - ux * endPad;
      var ey = b.y - uy * endPad;
      var headLen = Math.min(cell * 0.33, len * 0.40);
      var headHalf = Math.min(cell * 0.19, len * 0.22);
      var baseX = ex - ux * headLen;
      var baseY = ey - uy * headLen;
      var width = cell * (index === 0 ? 0.082 : 0.055);

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = color.shadow;
      ctx.shadowBlur = Math.max(2, cell * 0.075);
      ctx.shadowOffsetY = Math.max(0.5, cell * 0.015);

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(baseX, baseY);
      ctx.strokeStyle = color.line;
      ctx.lineWidth = width;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(baseX + uy * headHalf, baseY - ux * headHalf);
      ctx.lineTo(baseX - uy * headHalf, baseY + ux * headHalf);
      ctx.closePath();
      ctx.fillStyle = color.line;
      ctx.fill();
      ctx.strokeStyle = color.line;
      ctx.lineWidth = Math.max(1, cell * 0.012);
      ctx.stroke();
      ctx.restore();
    }

    /* ------------------------------------------------------------------- hud */

    function scoreTone(text) {
      if (!text) return 'idle';
      var first = text.charAt(0);
      if (first === '+') return 'pos';
      if (first === '-' || first === '\u2212') return 'neg';
      if (first === '#') return text.charAt(1) === '-' ? 'neg' : 'pos';
      return 'idle';
    }

    function hudStatus() {
      if (state.error) return state.error;
      if (!state.engineReady) return '\u0437\u0430\u043f\u0443\u0441\u043a Stockfish\u2026';
      if (state.gameOver) return '\u043f\u0430\u0440\u0442\u0438\u044f \u043e\u043a\u043e\u043d\u0447\u0435\u043d\u0430';
      if (state.autoStatus) return state.autoStatus;
      if (state.thinking) return '\u0434\u0443\u043c\u0430\u044e\u2026';
      if (state.autoPlay && state.myTurn) return '\u0430\u0432\u0442\u043e\u0445\u043e\u0434';
      if (state.myTurn) return '\u0442\u0432\u043e\u0439 \u0445\u043e\u0434';
      if (state.showOpponent) return '\u043f\u0440\u043e\u0433\u043d\u043e\u0437 \u043e\u0442\u0432\u0435\u0442\u0430 \u0441\u043e\u043f\u0435\u0440\u043d\u0438\u043a\u0430';
      return '\u0445\u043e\u0434 \u0441\u043e\u043f\u0435\u0440\u043d\u0438\u043a\u0430';
    }

    /*
     * Search time on the chip. It counts up while the engine runs and freezes
     * on the value actually spent once the reply arrives, so the number stays
     * readable until the next position.
     */
    function thinkElapsed() {
      if (state.thinking && state.thinkStart) return Date.now() - state.thinkStart;
      if (state.thinkMs != null) return state.thinkMs;
      return null;
    }

    function formatThink(ms) {
      if (ms == null) return '';
      // Below a second, whole milliseconds: the bullet preset finishes a depth-4
      // search in tens of milliseconds, and rounding that to "0.1s" makes a real
      // number look like a stuck placeholder.
      if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
      var seconds = ms / 1000;
      if (seconds < 10) return seconds.toFixed(1) + 's';
      return Math.round(seconds) + 's';
    }

    function renderThink() {
      if (!refs.time) return;
      var ms = thinkElapsed();
      if (ms == null) {
        refs.time.textContent = '';
        refs.time.style.display = 'none';
        return;
      }
      refs.time.textContent = formatThink(ms);
      refs.time.style.display = '';
    }

    function renderHud() {
      if (!hud) return;

      var thinking = !!state.thinking && !state.gameOver;
      var tone = 'idle';
      if (state.error) tone = 'error';
      else if (!state.engineReady) tone = 'busy';
      else if (state.gameOver) tone = 'idle';
      else if (thinking || state.autoStatus) tone = 'busy';
      else if (state.myTurn) tone = 'ok';

      var score = state.scoreText || '\u2014';
      var move = state.san || '';
      if (state.error) move = '\u043e\u0448\u0438\u0431\u043a\u0430';
      else if (!move && thinking) move = '\u0430\u043d\u0430\u043b\u0438\u0437\u2026';
      else if (!move && state.gameOver) move = '\u0444\u0438\u043d\u0430\u043b';
      else if (!move && !state.engineReady) move = '\u0437\u0430\u043f\u0443\u0441\u043a';

      setText(refs.score, score);
      setText(refs.move, move);
      renderThink();
      refs.score.setAttribute('data-tone', scoreTone(score));
      hud.setAttribute('data-tone', tone);

      // Everything secondary lives in the native tooltip, not on the chip.
      var title = [];
      if (state.engineLabel) title.push(state.engineLabel);
      if (state.depth) title.push('\u0433\u043b. ' + state.depth);
      var spent = thinkElapsed();
      if (spent != null) {
        title.push('\u0434\u0443\u043c\u0430\u043b ' + formatThink(spent));
      }
      title.push(hudStatus());
      if (state.autoPlay) title.push('\u0430\u0432\u0442\u043e\u0445\u043e\u0434 \u0432\u043a\u043b\u044e\u0447\u0451\u043d');
      title.push('\u043f\u0435\u0440\u0435\u0442\u0430\u0449\u0438 \u00b7 \u0434\u0432\u043e\u0439\u043d\u043e\u0439 \u043a\u043b\u0438\u043a \u2014 \u0441\u0431\u0440\u043e\u0441 \u00b7 \u0443\u0434\u0435\u0440\u0436\u0430\u043d\u0438\u0435 \u2014 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438');
      hud.title = title.join(' \u00b7 ');
    }

    return {
      mount: mount,
      setBoard: setBoard,
      update: update,
      hide: hide,
      sync: sync
    };
  }

  CA.createOverlay = createOverlay;
})();
