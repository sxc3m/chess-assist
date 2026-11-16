/*
 * Auto-move driver. Synthetic mouse events are the generic fallback. Lichess
 * ignores untrusted pointer events, so its moves go through the page bridge
 * (content/page-bridge.js): `lichess.analysis.playUci()` on analysis pages and
 * the game socket on live games. The caller verifies every move and reports
 * failure.
 */
(function () {
  'use strict';

  var core = CA.core;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s;
    try { s = getComputedStyle(el); } catch (e) { return true; }
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function fire(target, type, x, y, buttons, pointerType) {
    if (!target) return;
    var init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + (window.screenX || 0),
      screenY: y + (window.screenY || 0),
      button: 0,
      buttons: buttons || 0,
      detail: type === 'click' ? 1 : 0
    };
    var event = null;
    try {
      if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
        init.pointerId = 1;
        init.pointerType = pointerType || 'mouse';
        init.isPrimary = true;
        init.width = 1;
        init.height = 1;
        init.pressure = buttons ? 0.5 : 0;
        event = new PointerEvent(type, init);
      } else {
        event = new MouseEvent(type, init);
      }
    } catch (e) {
      try { event = new MouseEvent(type, init); } catch (e2) { return; }
    }
    try { target.dispatchEvent(event); } catch (e3) { /* ignore */ }
  }

  /*
   * Mobile sites drive the board from touch events, not from mouse events, and
   * some of them listen to touchstart/touchend only. Synthetic Touch objects
   * are supported in Firefox and Chromium; when the constructor is missing the
   * pointer events above still cover the pointer-event based boards.
   */
  function touchApi() {
    return typeof TouchEvent === 'function' && typeof Touch === 'function';
  }

  function makeTouch(target, x, y, active) {
    try {
      return new Touch({
        identifier: 1,
        target: target,
        clientX: x,
        clientY: y,
        screenX: x + (window.screenX || 0),
        screenY: y + (window.screenY || 0),
        pageX: x + (window.pageXOffset || 0),
        pageY: y + (window.pageYOffset || 0),
        radiusX: 4,
        radiusY: 4,
        rotationAngle: 0,
        force: active ? 0.5 : 0
      });
    } catch (e) {
      return null;
    }
  }

  function fireTouch(target, type, x, y, active) {
    if (!target || !touchApi()) return;
    var touch = makeTouch(target, x, y, active);
    if (!touch) return;
    var list = active ? [touch] : [];
    var event = null;
    try {
      event = new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        touches: list,
        targetTouches: list,
        changedTouches: [touch]
      });
    } catch (e) {
      return;
    }
    try { target.dispatchEvent(event); } catch (e2) { /* ignore */ }
  }

  function pointTarget(boardEl, x, y) {
    var el = null;
    try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }
    return el || boardEl;
  }

  async function clickPoint(boardEl, x, y, touch) {
    var target = pointTarget(boardEl, x, y);
    var kind = touch ? 'touch' : 'mouse';
    fire(target, 'pointerover', x, y, 0, kind);
    fire(target, 'mouseover', x, y, 0);
    fire(target, 'pointerenter', x, y, 0, kind);
    fire(target, 'mouseenter', x, y, 0);
    fire(target, 'mousemove', x, y, 0);
    fire(target, 'pointermove', x, y, 0, kind);
    fire(target, 'pointerdown', x, y, 1, kind);
    if (touch) fireTouch(target, 'touchstart', x, y, true);
    fire(target, 'mousedown', x, y, 1);
    // A finger rests on the screen longer than a mouse button press. Some
    // mobile boards ignore taps that are shorter than one animation frame.
    await sleep(touch ? 45 : 24);
    if (touch) fireTouch(target, 'touchend', x, y, false);
    fire(target, 'pointerup', x, y, 0, kind);
    fire(target, 'mouseup', x, y, 0);
    fire(target, 'click', x, y, 0);
  }

  async function drag(boardEl, from, to, touch) {
    var kind = touch ? 'touch' : 'mouse';
    // The board itself is the safest drag target: every drag handler is on an
    // ancestor, and chessground/chess.com both listen on the board element.
    fire(boardEl, 'pointerover', from.x, from.y, 0, kind);
    fire(boardEl, 'mouseover', from.x, from.y, 0);
    fire(boardEl, 'pointermove', from.x, from.y, 0, kind);
    fire(boardEl, 'mousemove', from.x, from.y, 0);
    fire(boardEl, 'pointerdown', from.x, from.y, 1, kind);
    if (touch) fireTouch(boardEl, 'touchstart', from.x, from.y, true);
    fire(boardEl, 'mousedown', from.x, from.y, 1);
    await sleep(touch ? 50 : 35);
    var steps = 7;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var x = from.x + (to.x - from.x) * t;
      var y = from.y + (to.y - from.y) * t;
      fire(boardEl, 'pointermove', x, y, 1, kind);
      fire(boardEl, 'mousemove', x, y, 1);
      if (touch) fireTouch(boardEl, 'touchmove', x, y, true);
      await sleep(16);
    }
    if (touch) fireTouch(boardEl, 'touchend', to.x, to.y, false);
    fire(boardEl, 'pointerup', to.x, to.y, 0, kind);
    fire(boardEl, 'mouseup', to.x, to.y, 0);
  }

  function classMatchesPiece(text, pieceName, color) {
    var code = color === 'w' || color === 'white' ? 'w' : 'b';
    var letter = { queen: 'q', rook: 'r', bishop: 'b', knight: 'n' }[pieceName];
    if (!letter) return false;
    var lower = text.toLowerCase();
    if (lower.indexOf(pieceName) >= 0) return true;
    if (lower.indexOf(code + letter) >= 0) return true;
    if (lower.indexOf(' ' + letter + ' ') >= 0) return true;
    if (color === 'w' || color === 'white') {
      if (letter === 'q' && lower.indexOf('white queen') >= 0) return true;
      if (letter === 'r' && lower.indexOf('white rook') >= 0) return true;
      if (letter === 'b' && lower.indexOf('white bishop') >= 0) return true;
      if (letter === 'n' && lower.indexOf('white knight') >= 0) return true;
    } else {
      if (letter === 'q' && lower.indexOf('black queen') >= 0) return true;
      if (letter === 'r' && lower.indexOf('black rook') >= 0) return true;
      if (letter === 'b' && lower.indexOf('black bishop') >= 0) return true;
      if (letter === 'n' && lower.indexOf('black knight') >= 0) return true;
    }
    return false;
  }

  function findPromotionChoice(promotion, color) {
    var pieceName = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[promotion] || 'queen';
    var containers = document.querySelectorAll(
      '.promotion, .promotion-window, .promotion-menu, .promotion-dialog, [class*="promotion"]'
    );
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < containers.length; i++) {
      var box = containers[i];
      if (!isShown(box)) continue;
      var br = box.getBoundingClientRect();
      if (br.width * br.height > 420 * 420) continue; // ignore page wrappers
      var nodes = box.querySelectorAll('piece, .promotion-piece, .piece, [data-piece], button');
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (!isShown(node)) continue;
        var data = String(node.getAttribute('data-piece') || '').toLowerCase();
        var text = String(node.className || '') + ' ' + String(node.textContent || '');
        var score = -1;
        if (data === promotion || data === pieceName || data === (color === 'w' ? 'w' : 'b') + promotion) score = 2;
        else if (classMatchesPiece(text, pieceName, color)) score = 1;
        if (score > bestScore) { best = node; bestScore = score; }
      }
    }
    return bestScore >= 0 ? best : null;
  }

  async function choosePromotion(promotion, color, timeoutMs, touch) {
    var deadline = Date.now() + (timeoutMs || 1000);
    while (Date.now() < deadline) {
      var node = findPromotionChoice(promotion, color);
      if (node) {
        var r = node.getBoundingClientRect();
        await clickPoint(node, r.left + r.width / 2, r.top + r.height / 2, touch);
        return true;
      }
      await sleep(90);
    }
    return false;
  }

  function ensureVisible(boardEl) {
    var r = boardEl.getBoundingClientRect();
    if (r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth) {
      return Promise.resolve();
    }
    try {
      boardEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (e) {
      try { boardEl.scrollIntoView(); } catch (e2) { /* ignore */ }
    }
    return sleep(140);
  }

  function AutoMover() {}

  AutoMover.prototype.play = async function (boardEl, orientation, move, opts) {
    opts = opts || {};
    if (!boardEl) throw new Error('Доска не найдена');
    var uci = core.moveToUci(move.from, move.to, move.promotion);

    if (opts.site === 'lichess') {
      var bridge = CA.PageBridge;
      if (!bridge) throw new Error('Мост Lichess не загрузился. Обнови вкладку.');
      var result = await bridge.move(uci);
      if (result && result.via && result.via !== 'bridge') return result;
      throw new Error(result && result.error
        ? result.error
        : 'Lichess не принял ход. Обнови вкладку и повтори.');
    }

    if (opts.site === 'chess.com') {
      var ccBridge = CA.PageBridge;
      if (ccBridge && typeof ccBridge.chesscomMove === 'function') {
        var ccResult = await ccBridge.chesscomMove(uci);
        if (ccResult && ccResult.via === 'chesscom-api') return ccResult;
        // Only fall back to synthetic events when the page has no game object
        // to call. A rejected legal move must be reported, not retried blindly.
        if (!ccResult || !ccResult.fallback) {
          throw new Error(ccResult && ccResult.error
            ? ccResult.error
            : 'Chess.com не принял ход. Обнови вкладку и повтори.');
        }
      }
    }

    await ensureVisible(boardEl);
    var rect = boardEl.getBoundingClientRect();
    if (!rect || rect.width < 60 || rect.height < 60) throw new Error('Доска не видна на экране');
    var from = core.squareCenter(move.from, rect, orientation);
    var to = core.squareCenter(move.to, rect, orientation);
    var touch = !!opts.touch;

    if (opts.mode === 'drag') {
      await drag(boardEl, from, to, touch);
    } else {
      await clickPoint(boardEl, from.x, from.y, touch);
      await sleep(touch ? 130 : 95);
      await clickPoint(boardEl, to.x, to.y, touch);
    }

    if (move.promotion) {
      await sleep(320);
      var chosen = await choosePromotion(move.promotion, opts.color || 'w', 1200, touch);
      if (!chosen) await choosePromotion(move.promotion, opts.color || 'w', 700, touch);
    }

    return {
      via: 'events',
      uci: uci
    };
  };

  CA.AutoMover = AutoMover;
})();
