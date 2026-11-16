/* Shared site adapters: read the position straight from the page DOM. */
(function () {
  'use strict';

  var core = CA.core;
  var sites = {};

  function visible(el) {
    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 120;
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style;
    try { style = getComputedStyle(el); } catch (e) { return true; }
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function tokens(el) {
    return String((el && el.className) || '').split(/\s+/).filter(Boolean);
  }

  function hasClass(el, name) {
    return !!(el && el.classList && el.classList.contains(name));
  }

  function classText(el) {
    return ' ' + String((el && el.className) || '') + ' ';
  }

  function area(el) {
    var r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resultTextGameOver() {
    var selectors = [
      '.round__app .result',
      '.analyse__underboard .result',
      '.game-over-modal',
      '.modal-game-over',
      '[class*="game-over"]',
      '.result'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (!isShown(el)) continue;
        var text = String(el.textContent || '').trim();
        if (/^(1-0|0-1|½-½|1\/2-1\/2)$/.test(text)) return true;
        if (/game[\s-]*over|победа|поражение|ничья/i.test(text) && text.length < 160) return true;
      }
    }
    return false;
  }

  /*
   * Query inside a tree and its open shadow roots. Chess.com wraps its board
   * in a custom element and some builds render the pieces in a shadow root,
   * so plain document.querySelector() cannot see them.
   */
  function queryDeep(root, selector, depthLimit) {
    var out = [];
    var limit = depthLimit == null ? 3 : depthLimit;
    function add(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        if (out.indexOf(nodes[i]) < 0) out.push(nodes[i]);
      }
    }
    function walk(node, depth) {
      if (!node || depth > limit) return;
      try { add(node.querySelectorAll(selector)); } catch (e) { /* ignore */ }
      var kids = node.children;
      if (!kids) return;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].shadowRoot) walk(kids[i].shadowRoot, depth + 1);
      }
    }
    walk(root, 0);
    return out;
  }

  /* ---------------------------------------------------------------- chess.com */

  var PIECE_NAMES = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
  var PIECE_LETTERS = { p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k' };
  var PIECE_SELECTOR = '.piece, [data-piece], [data-role][data-color], [class*="piece-"]';

  function pieceLetter(role, color) {
    var letter = PIECE_LETTERS[role] || null;
    if (!letter) return null;
    return color === 'w' ? letter.toUpperCase() : letter;
  }

  function laymanColor(value) {
    var text = normalizeText(value);
    if (!text) return null;
    if (/\bwhite\b/.test(text) || text === 'w') return 'w';
    if (/\bblack\b/.test(text) || text === 'b') return 'b';
    return null;
  }

  function chesscomPieceFromElement(el, boardEl) {
    var color = null;
    var role = null;

    // Explicit data attributes are the most reliable source.
    if (el.getAttribute) {
      color = laymanColor(el.getAttribute('data-color'));
      var dataPiece = normalizeText(el.getAttribute('data-piece'));
      if (dataPiece) {
        if (/\b(white|black|w|b)\b/.test(dataPiece)) {
          color = color || laymanColor(dataPiece);
        }
        var names = dataPiece.match(/\b(pawn|knight|bishop|rook|queen|king)\b/);
        if (names) role = PIECE_NAMES[names[1]];
        else {
          var compact = /(^|\s)([wb])([pnbrqk])(?=\s|$)/.exec(dataPiece);
          if (compact) {
            color = color || compact[2];
            role = role || PIECE_LETTERS[compact[3]];
          } else {
            var single = /(^|\s)([pnbrqk])(?=\s|$)/.exec(dataPiece);
            if (single) role = PIECE_LETTERS[single[2]];
          }
        }
      }
      var dataRole = normalizeText(el.getAttribute('data-role') || el.getAttribute('data-type') ||
                                  el.getAttribute('data-piece-type'));
      if (!role && dataRole) {
        for (var name in PIECE_NAMES) {
          if (dataRole.indexOf(name) >= 0) { role = PIECE_NAMES[name]; break; }
        }
      }
    }

    // Then the class / aria-label / background image of the element and its
    // closest wrappers. Some builds put "piece" on the child and the colour
    // or square on the parent.
    var parts = [];
    var node = el;
    for (var depth = 0; node && node !== boardEl && depth < 3; depth++, node = node.parentElement) {
      parts.push(node.className);
      if (node.getAttribute) {
        parts.push(node.getAttribute('aria-label'));
        parts.push(node.getAttribute('alt'));
        parts.push(node.getAttribute('src'));
        var style = node.getAttribute('style');
        if (style) parts.push(style);
      }
    }
    var text = normalizeText(parts.join(' '));

    if (!role) {
      for (var roleName in PIECE_NAMES) {
        if (text.indexOf(roleName) >= 0) { role = PIECE_NAMES[roleName]; break; }
      }
    }
    if (!color) {
      if (text.indexOf('white') >= 0) color = 'w';
      else if (text.indexOf('black') >= 0) color = 'b';
    }
    if (!role || !color) {
      var compact = /(^|\s)([wb])([pnbrqk])(?=\s|$)/.exec(text);
      if (compact) {
        color = color || compact[2];
        role = role || PIECE_LETTERS[compact[3]];
      }
    }
    if (!color) {
      var colorToken = /(^|\s)([wb])(?=\s|$)/.exec(text);
      if (colorToken) color = colorToken[2];
    }
    if (!role) {
      var roleToken = /(^|\s)([pnbrqk])(?=\s|$)/.exec(text);
      if (roleToken) role = PIECE_LETTERS[roleToken[2]];
    }

    if (!role || !color) return null;
    return pieceLetter(role, color);
  }

  function chesscomPieceNodes(boardEl) {
    var nodes = [];
    function add(list) {
      for (var i = 0; i < list.length; i++) {
        if (nodes.indexOf(list[i]) < 0) nodes.push(list[i]);
      }
    }
    add(boardEl.querySelectorAll(PIECE_SELECTOR));
    if (boardEl.shadowRoot) add(boardEl.shadowRoot.querySelectorAll(PIECE_SELECTOR));

    // Only walk deeper shadow trees when the light DOM gave us nothing useful.
    if (nodes.length < 10) {
      var hosts = boardEl.querySelectorAll('*');
      for (var i = 0; i < hosts.length && i < 600; i++) {
        if (hosts[i].shadowRoot) add(hosts[i].shadowRoot.querySelectorAll(PIECE_SELECTOR));
      }
    }

    var out = [];
    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j];
      // Skip wrappers that contain real piece elements of their own.
      if (!hasClass(node, 'piece') && node.querySelector && node.querySelector('.piece')) continue;
      if (hasClass(node, 'dragging') || hasClass(node, 'dragged') ||
          hasClass(node, 'fading') || hasClass(node, 'captured') ||
          hasClass(node, 'ghost')) continue;
      out.push(node);
    }
    return out;
  }

  function squareFromNode(node) {
    if (!node || !node.getAttribute) return null;

    var attrs = ['data-square', 'data-square-id', 'data-sq', 'data-cell'];
    for (var a = 0; a < attrs.length; a++) {
      var raw = node.getAttribute(attrs[a]);
      if (!raw) continue;
      var value = String(raw).trim().toLowerCase();
      var named = core.squareIndex(value);
      if (named >= 0) return { sq: named, kind: 'data', file: core.fileOf(named), rank: core.rankOf(named) };
      var numeric = /^(\d)(\d)$/.exec(value);
      if (numeric) {
        var df = parseInt(numeric[1], 10) - 1;
        var dr = parseInt(numeric[2], 10) - 1;
        if (df >= 0 && df < 8 && dr >= 0 && dr < 8) {
          return { sq: dr * 8 + df, kind: 'data', file: df, rank: dr };
        }
      }
    }

    var label = node.getAttribute('aria-label');
    if (label) {
      var onSquare = /\bon\s+([a-h][1-8])\b/i.exec(label);
      if (onSquare) {
        var sq = core.squareIndex(onSquare[1]);
        if (sq >= 0) return { sq: sq, kind: 'data', file: core.fileOf(sq), rank: core.rankOf(sq) };
      }
    }

    var list = tokens(node);
    for (var i = 0; i < list.length; i++) {
      var namedClass = /^square-([a-h])([1-8])$/i.exec(list[i]);
      if (namedClass) {
        var byName = core.squareIndex(namedClass[1] + namedClass[2]);
        if (byName >= 0) {
          return { sq: byName, kind: 'data', file: core.fileOf(byName), rank: core.rankOf(byName) };
        }
      }
      var numericClass = /^square-(\d)(\d)$/.exec(list[i]);
      if (numericClass) {
        var cf = parseInt(numericClass[1], 10) - 1;
        var cr = parseInt(numericClass[2], 10) - 1;
        if (cf >= 0 && cf < 8 && cr >= 0 && cr < 8) {
          return { sq: cr * 8 + cf, kind: 'class', file: cf, rank: cr };
        }
      }
    }
    return null;
  }

  function chesscomExplicitSquare(el, boardEl) {
    var node = el;
    for (var depth = 0; node && node !== boardEl && depth < 4; depth++, node = node.parentElement) {
      var found = squareFromNode(node);
      if (found) return found;
    }
    return null;
  }

  function geometryAt(el, boardEl, rect, orientation) {
    var pr;
    try { pr = el.getBoundingClientRect(); } catch (e) { return null; }
    if (!pr || pr.width <= 0 || pr.height <= 0 || rect.width < 40 || rect.height < 40) return null;
    var cell = Math.min(rect.width, rect.height) / 8;
    if (!cell) return null;
    var fx = ((pr.left + pr.width / 2) - rect.left) / cell - 0.5;
    var fy = ((pr.top + pr.height / 2) - rect.top) / cell - 0.5;
    if (Math.abs(fx - Math.round(fx)) > 0.34 || Math.abs(fy - Math.round(fy)) > 0.34) return null;
    var col = Math.round(fx);
    var row = Math.round(fy);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return { col: col, row: row, sq: squareFromColRow(col, row, orientation) };
  }

  function squareFromColRow(col, row, orientation) {
    var file = orientation === 'black' ? 7 - col : col;
    var rank = orientation === 'black' ? row : 7 - row;
    return rank * 8 + file;
  }

  function chesscomOrientation(boardEl) {
    var el = boardEl;
    for (var depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      if (hasClass(el, 'flipped')) return 'black';
      if (hasClass(el, 'orientation-black')) return 'black';
      if (hasClass(el, 'orientation-white')) return 'white';
      if (el.getAttribute) {
        if (el.getAttribute('flipped') !== null && el.getAttribute('flipped') !== 'false') return 'black';
        if (el.getAttribute('data-flipped') === 'true') return 'black';
        var orientation = String(el.getAttribute('data-orientation') ||
                                 el.getAttribute('data-board-orientation') || '').toLowerCase();
        if (orientation === 'black' || orientation === 'b') return 'black';
        if (orientation === 'white' || orientation === 'w') return 'white';
      }
    }
    return 'white';
  }

  function clockColor(el) {
    var node = el;
    for (var depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (node.getAttribute) {
        var color = laymanColor(node.getAttribute('data-color') || node.getAttribute('data-side'));
        if (color) return color;
      }
      var text = ' ' + normalizeText(node.className) + ' ';
      if (/\b(clock white|white clock|clock w)\b/.test(text)) return 'w';
      if (/\b(clock black|black clock|clock b)\b/.test(text)) return 'b';
      // Last resort: a "white"/"black" token on the clock wrapper.
      if (/(^|\s)white(\s|$)/.test(text)) return 'w';
      if (/(^|\s)black(\s|$)/.test(text)) return 'b';
    }
    return null;
  }

  /*
   * Remaining clock time, in milliseconds, from a clock label. Both sites use
   * "m:ss" (Lichess adds tenths below 20 seconds); a long game can show
   * "h:mm:ss". Keep the raw text here: normalizeText() strips the colon.
   */
  function parseClockMs(text) {
    var raw = String(text || '').replace(/\u00a0/g, ' ').trim();
    if (!raw || raw.length > 24) return null;
    var m = /(?:^|\s)(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?(?=\s|$)/.exec(raw);
    if (!m) return null;
    var hours = m[1] != null ? parseInt(m[1], 10) : 0;
    var minutes = parseInt(m[2], 10);
    var seconds = parseInt(m[3], 10);
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    var fraction = m[4] ? parseInt((m[4] + '00').slice(0, 3), 10) : 0;
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + fraction;
  }

  function clockMsFrom(el) {
    if (!el) return null;
    var nodes = el.querySelectorAll('time, .clock-time, .clock-time-monospace');
    for (var i = 0; i < nodes.length; i++) {
      if (!isShown(nodes[i])) continue;
      var value = parseClockMs(nodes[i].textContent);
      if (value != null) return value;
    }
    var text = String(el.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (text.length <= 18) return parseClockMs(text);
    return null;
  }

  function readClockPair(selectors, orientation) {    var out = { w: null, b: null, turn: null };
    for (var s = 0; s < selectors.length; s++) {
      var nodes;
      try { nodes = document.querySelectorAll(selectors[s]); } catch (e) { nodes = []; }
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!isShown(el)) continue;
        var rect = el.getBoundingClientRect();
        // Clock labels are small. Skip page-level wrappers that contain the
        // whole player panel (and therefore both clocks).
        if (rect.width < 16 || rect.width > 460 || rect.height > 160) continue;
        var color = clockColor(el);
        if (!color && orientation) {
          var bottom = orientation === 'black' ? 'b' : 'w';
          if (hasClass(el, 'rclock-top') || hasClass(el, 'clock-top')) color = core.otherColor(bottom);
          else if (hasClass(el, 'rclock-bottom') || hasClass(el, 'clock-bottom')) color = bottom;
        }
        if (!color) continue;
        var ms = clockMsFrom(el);
        if (ms == null || ms > 24 * 3600 * 1000) continue;
        // A wrapper and its child can both match; the smallest value is the
        // most recently rendered one.
        if (out[color] == null || ms < out[color]) out[color] = ms;
      }
    }
    return out;
  }

  /*
   * Rating detection. Both sites render each player's rating next to the
   * board, so the extension can size its playing strength to the real
   * opponent instead of a hard-coded Elo. The search is intentionally broad
   * (any element whose class mentions "rating" and whose text is a 3-4 digit
   * number, optionally followed by "?" for provisional ratings) because the
   * markup changes between site versions.
   */
  function parseRatingNumber(text) {
    var normalized = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 24) return null;
    var m = /(?:^|[^\d])(\d{3,4})(?:\?)?(?:$|[^\d])/.exec(normalized);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return n >= 400 && n <= 3500 ? n : null;
  }

  function ratingCandidates() {
    var nodes = document.querySelectorAll(
      '[class*="rating"], [class*="Rating"], [data-test-element="user-tagline-rating"]'
    );
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      if (el.children && el.children.length > 2) continue;
      var rating = parseRatingNumber(el.textContent);
      if (rating == null) continue;
      var rect = el.getBoundingClientRect();
      out.push({ rating: rating, top: rect.top, bottom: rect.bottom });
    }
    return out;
  }

  /*
   * Map the two nearest ratings above and below the board centre to colours.
   * The board is oriented to the player, so the bottom half is the side the
   * board is flipped to.
   */
  function readRatingsFor(boardEl, orientation) {
    if (!boardEl) return null;
    var rect = boardEl.getBoundingClientRect();
    var mid = rect.top + rect.height / 2;
    var topRating = null;
    var bottomRating = null;
    var bestTop = Infinity;
    var bestBottom = Infinity;
    var list = ratingCandidates();
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var cy = (c.top + c.bottom) / 2;
      var dist = Math.abs(cy - mid);
      if (cy <= mid) {
        if (dist < bestTop) { bestTop = dist; topRating = c.rating; }
      } else if (dist < bestBottom) {
        bestBottom = dist;
        bottomRating = c.rating;
      }
    }
    if (topRating == null && bottomRating == null) return null;
    return orientation === 'black'
      ? { b: bottomRating, w: topRating }
      : { w: bottomRating, b: topRating };
  }

  function chesscomClocks(orientation) {
    var out = readClockPair([
      '.clock-white',
      '.clock-black',
      '[class*="clock"][data-color]',
      '[class*="clock-time"]',
      '[data-clock]'
    ], orientation || null);
    out.turn = chesscomClockTurn();
    return out;
  }

  function chesscomClockTurn() {
    var nodes = document.querySelectorAll('[class*="clock"], [data-clock]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isShown(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 460) continue; // page wrappers, not clocks
      var text = ' ' + normalizeText(el.className) + ' ' +
                 normalizeText(el.getAttribute('data-clock') || '') + ' ' +
                 normalizeText(el.getAttribute('data-state') || '') + ' ';
      var active = /\b(player turn|running|active|turn now|current|clock turn|to move)\b/.test(text);
      if (el.getAttribute && (el.getAttribute('data-active') === 'true' ||
          el.getAttribute('data-running') === 'true')) active = true;
      if (!active) continue;
      var color = clockColor(el);
      if (color) return color;
    }
    return null;
  }

  function chesscomLastMoveColor(boardEl, board, orientation, screenMode, rect) {
    var marks = queryDeep(boardEl, '.last-move, [class*="last-move"]', 2);
    if (marks.length < 2) return null;
    var cell = Math.min(rect.width, rect.height) / 8;
    var squares = [];
    for (var i = 0; i < marks.length && squares.length < 2; i++) {
      var el = marks[i];
      var mr = el.getBoundingClientRect();
      if (mr.width > cell * 2.2 || mr.height > cell * 2.2) continue;
      var parsed = chesscomExplicitSquare(el, boardEl);
      var sq = -1;
      if (parsed) {
        if (parsed.kind === 'class' && screenMode) sq = squareFromColRow(parsed.file, parsed.rank, orientation);
        else sq = parsed.sq;
      } else {
        var geo = geometryAt(el, boardEl, rect, orientation);
        if (geo) sq = geo.sq;
      }
      if (sq >= 0 && squares.indexOf(sq) < 0) squares.push(sq);
    }
    if (squares.length !== 2) return null;
    var atA = board[squares[0]];
    var atB = board[squares[1]];
    if (atA && !atB) return core.colorOf(atA);
    if (atB && !atA) return core.colorOf(atB);
    // Castling highlights both the king's and the rook's destination.
    if (atA && atB && core.colorOf(atA) === core.colorOf(atB)) return core.colorOf(atA);
    return null;
  }

  function chesscomBoardCandidates() {
    var selectors = [
      'wc-chess-board',
      'chess-board',
      '#board',
      '.board-layout-chessboard',
      '.board',
      '.chessboard'
    ];
    var out = [];
    for (var i = 0; i < selectors.length; i++) {
      // Some chess.com builds put the whole board custom element inside an
      // open shadow root, so walk shadow trees as well as the light DOM.
      var nodes = queryDeep(document, selectors[i], 3);
      for (var j = 0; j < nodes.length; j++) {
        if (out.indexOf(nodes[j]) < 0) out.push(nodes[j]);
      }
    }
    return out;
  }

  function chesscomBoardScore(el) {
    if (!visible(el)) return -1;
    var r = el.getBoundingClientRect();
    if (r.width < 160 || r.height < 160) return -1;
    if (r.width / r.height < 0.55 || r.width / r.height > 1.8) return -1;
    if (r.width > window.innerWidth * 1.6 || r.height > window.innerHeight * 1.6) return -1;

    var pieces = 0;
    try { pieces = chesscomPieceNodes(el).length; } catch (e) { pieces = 0; }
    var squares = 0;
    if (!pieces) {
      try { squares = el.querySelectorAll('[class*="square-"]').length; } catch (e) { squares = 0; }
    }

    var tag = String((el.tagName || '')).toUpperCase();
    var custom = tag === 'WC-CHESS-BOARD' || tag === 'CHESS-BOARD';
    if (!pieces && squares < 24 && !el.shadowRoot && !custom && el.id !== 'board') return -1;
    // The SSR board placeholder is hidden; the live board (which can paint
    // pieces as one composite sprite, without `.piece` nodes) is visible.
    if ((custom || el.id === 'board') && !isShown(el)) return -1;

    var score = area(el);
    if (pieces) score += 10000000 + pieces * 10000;
    else if (squares >= 24) score += 5000000;
    if (custom) score += 1000000;
    if (el.id === 'board') score += 2000000;
    return score;
  }

  function chesscomFindBoard() {
    var candidates = chesscomBoardCandidates();
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      var score = chesscomBoardScore(candidates[i]);
      if (score > bestScore) {
        best = candidates[i];
        bestScore = score;
      }
    }
    return best;
  }

  function readChesscom(boardEl) {
    // A piece being dragged (or a premove preview) is not part of the stable
    // position. Wait for the next tick instead of sending a broken FEN.
    if (boardEl.querySelector('.piece.dragging, .piece.dragged, piece.dragging')) return null;

    var nodes = chesscomPieceNodes(boardEl);
    if (nodes.length < 2) return null;

    var rect = boardEl.getBoundingClientRect();
    if (!rect || rect.width < 60 || rect.height < 60) return null;

    var detected = chesscomOrientation(boardEl);
    var records = [];

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var piece = chesscomPieceFromElement(el, boardEl);
      if (!piece) continue;
      records.push({
        el: el,
        piece: piece,
        explicit: chesscomExplicitSquare(el, boardEl),
        geometry: geometryAt(el, boardEl, rect, detected)
      });
    }
    if (records.length < 2) return null;

    // Some chess.com builds use square-XX as logical coordinates (a1..h8),
    // others position the whole board with CSS and use square-XX as a screen
    // cell. Vote with the real pixel positions to tell the two apart.
    var screenVotes = 0;
    var algebraWhite = 0;
    var algebraBlack = 0;
    var votes = 0;
    for (var v = 0; v < records.length; v++) {
      var rec = records[v];
      if (!rec.explicit || !rec.geometry) continue;
      votes++;
      if (rec.explicit.kind === 'class' &&
          rec.explicit.file === rec.geometry.col &&
          rec.explicit.rank === rec.geometry.row) {
        screenVotes++;
      }
      var whiteSq = squareFromColRow(rec.geometry.col, rec.geometry.row, 'white');
      var blackSq = squareFromColRow(rec.geometry.col, rec.geometry.row, 'black');
      if (rec.explicit.sq === whiteSq) algebraWhite++;
      if (rec.explicit.sq === blackSq) algebraBlack++;
    }

    var screenMode = votes >= 4 && screenVotes >= 4 &&
                     screenVotes >= Math.ceil(votes * 0.5) &&
                     screenVotes > algebraWhite && screenVotes > algebraBlack;
    var orientation = detected;
    if (!screenMode && votes >= 4) {
      var majority = Math.ceil(votes * 0.6);
      if (algebraWhite >= majority && algebraWhite > algebraBlack) orientation = 'white';
      else if (algebraBlack >= majority && algebraBlack > algebraWhite) orientation = 'black';
    }

    var board = core.emptyBoard();
    var placed = 0;
    for (var p = 0; p < records.length; p++) {
      var current = records[p];
      var square = -1;
      if (current.explicit) {
        if (current.explicit.kind === 'class' && screenMode) {
          square = squareFromColRow(current.explicit.file, current.explicit.rank, orientation);
        } else {
          square = current.explicit.sq;
        }
      } else if (current.geometry) {
        square = current.geometry.sq;
      }
      if (square < 0 || square > 63) continue;
      if (!board[square]) placed++;
      board[square] = current.piece;
    }
    if (placed < 2) return null;

    var clocks = chesscomClocks(orientation);
    return {
      board: board,
      orientation: orientation,
      screenMode: screenMode,
      clockTurn: clocks.turn,
      clockRemaining: { w: clocks.w, b: clocks.b },
      lastMoveColor: chesscomLastMoveColor(boardEl, board, orientation, screenMode, rect),
      ratings: readRatingsFor(boardEl, orientation),
      gameOver: resultTextGameOver()
    };
  }

  var chesscom = {
    id: 'chess.com',
    matches: function (host) { return /(^|\.)chess\.com$/.test(host); },
    findBoard: chesscomFindBoard,
    readClocks: function (orientation) {
      // The controller caches the board orientation, so the per-tick clock read
      // does not need to search for the board again.
      if (orientation === 'black' || orientation === 'white') return chesscomClocks(orientation);
      var board = chesscomFindBoard();
      return chesscomClocks(board ? chesscomOrientation(board) : null);
    },
    readRatings: function () {
      var board = chesscomFindBoard();
      return readRatingsFor(board, board ? chesscomOrientation(board) : null);
    },
    read: function (boardEl) {
      var read = readChesscom(boardEl);
      if (!read) return null;
      return {
        board: read.board,
        orientation: read.orientation,
        clockTurn: read.clockTurn,
        clockRemaining: read.clockRemaining,
        lastMoveColor: read.lastMoveColor,
        ratings: read.ratings,
        gameOver: read.gameOver
      };
    }
  };

  /* ------------------------------------------------------------------ lichess */

  var LICHESS_LETTER = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };

  function lichessPieceFromElement(el) {
    var list = tokens(el);
    var color = null;
    var name = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === 'white' || list[i] === 'black') color = list[i];
      else if (LICHESS_LETTER[list[i]]) name = list[i];
    }
    if (!color || !name) return null;
    var letter = LICHESS_LETTER[name];
    return color === 'white' ? letter : letter.toLowerCase();
  }

  function translateOf(el) {
    var style = el.getAttribute('style') || '';
    var m = /translate(?:3d)?\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(style);
    if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    var t = '';
    try { t = getComputedStyle(el).transform || ''; } catch (e) { t = ''; }
    if (t && t !== 'none') {
      var n = /matrix\(([^)]+)\)/.exec(t);
      if (n) {
        var parts = n[1].split(',').map(function (v) { return parseFloat(v); });
        if (parts.length >= 6) return { x: parts[4], y: parts[5] };
      }
    }
    return { x: 0, y: 0 };
  }

  function lichessOrientation(boardEl) {
    var el = boardEl;
    for (var depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      if (hasClass(el, 'orientation-black')) return 'black';
      if (hasClass(el, 'orientation-white')) return 'white';
      if (el.getAttribute) {
        var orientation = String(el.getAttribute('data-orientation') || '').toLowerCase();
        if (orientation === 'black') return 'black';
        if (orientation === 'white') return 'white';
      }
    }
    return 'white';
  }

  function lichessClockTurn(orientation) {
    var active = document.querySelectorAll('.rclock.running, .rclock.rclock-turn, .rclock-turn, [data-running="true"]');
    var found = null;
    for (var i = 0; i < active.length; i++) {
      var el = active[i];
      if (!isShown(el)) continue;
      var color = null;
      if (hasClass(el, 'rclock-white') || hasClass(el, 'clock-white')) color = 'w';
      else if (hasClass(el, 'rclock-black') || hasClass(el, 'clock-black')) color = 'b';
      else {
        var parent = el.closest ? el.closest('.rclock-white, .rclock-black, .clock-white, .clock-black') : null;
        if (parent) {
          color = hasClass(parent, 'rclock-white') || hasClass(parent, 'clock-white') ? 'w' : 'b';
        } else if (hasClass(el, 'rclock-top') || hasClass(el, 'rclock-bottom')) {
          // Lichess often marks the running clock only with rclock-top /
          // rclock-bottom; the orientation tells us which colour that is.
          var bottom = orientation === 'black' ? 'b' : 'w';
          color = hasClass(el, 'rclock-top') ? core.otherColor(bottom) : bottom;
        }
      }
      if (!color) continue;
      if (found && found !== color) return null;
      found = color;
    }
    return found;
  }

  function lichessClocks(orientation) {
    var out = readClockPair([
      '.rclock-white',
      '.rclock-black',
      '.clock-white',
      '.clock-black',
      '.rclock'
    ], orientation);
    out.turn = lichessClockTurn(orientation);
    return out;
  }

  function readLichessClocks(orientation) {
    var hint = orientation;
    if (hint !== 'black' && hint !== 'white') {
      var boards = document.querySelectorAll('cg-board');
      var board = null;
      for (var i = 0; i < boards.length; i++) {
        if (isShown(boards[i])) { board = boards[i]; break; }
      }
      hint = lichessOrientation(board || document.body);
    }
    return lichessClocks(hint);
  }

  function lichessLastMove(boardEl, orientation, rect) {
    var marks = boardEl.querySelectorAll('square.last-move, .last-move');
    if (marks.length < 2) return null;
    var cell = Math.min(rect.width, rect.height) / 8;
    if (!cell) return null;
    var squares = [];
    for (var i = 0; i < marks.length && squares.length < 2; i++) {
      var tr = translateOf(marks[i]);
      var col = Math.round(tr.x / cell);
      var row = Math.round(tr.y / cell);
      if (col < 0 || col > 7 || row < 0 || row > 7) continue;
      var file = orientation === 'white' ? col : 7 - col;
      var rank = orientation === 'white' ? 7 - row : row;
      var sq = rank * 8 + file;
      if (squares.indexOf(sq) < 0) squares.push(sq);
    }
    if (squares.length !== 2) return null;
    return { a: squares[0], b: squares[1] };
  }

  function lichessPieces(boardEl) {
    var all = boardEl.querySelectorAll('piece');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      // A premove preview sits on the destination square but the position has
      // not changed yet. A fading piece is a capture animation. Ignore both;
      // the real position is represented by the remaining pieces.
      if (all[i].parentElement === boardEl &&
          !hasClass(all[i], 'premove') &&
          !hasClass(all[i], 'fading') &&
          !hasClass(all[i], 'ghost')) {
        out.push(all[i]);
      }
    }
    return out;
  }

  var lichess = {
    id: 'lichess',
    matches: function (host) { return host === 'lichess.org' || /\.lichess\.org$/.test(host); },
    readClocks: readLichessClocks,
    readRatings: function () {
      var board = lichess.findBoard();
      return readRatingsFor(board, board ? lichessOrientation(board) : null);
    },
    findBoard: function () {
      var boards = document.querySelectorAll('cg-board');
      var best = null;
      var bestArea = 0;
      for (var i = 0; i < boards.length; i++) {
        var b = boards[i];
        if (!visible(b)) continue;
        var hasPieces = b.querySelector('piece');
        var a = area(b);
        if (hasPieces && a > bestArea) { best = b; bestArea = a; }
      }
      if (best) return best;
      for (var j = 0; j < boards.length; j++) {
        if (visible(boards[j])) return boards[j];
      }
      return null;
    },
    read: function (boardEl) {
      // A staged premove is only a preview. Depending on the chessground
      // version it may hide the real piece or duplicate it, so the board is
      // not trustworthy until the premove resolves.
      if (boardEl.querySelector('piece.premove')) return null;
      var pieces = lichessPieces(boardEl);
      if (!pieces.length) return null;
      var rect = boardEl.getBoundingClientRect();
      var cell = Math.min(rect.width, rect.height) / 8;
      if (!cell) return null;
      var orientation = lichessOrientation(boardEl);
      var board = core.emptyBoard();
      var placed = 0;
      for (var i = 0; i < pieces.length; i++) {
        var el = pieces[i];
        var pc = lichessPieceFromElement(el);
        if (!pc) continue;
        var tr = translateOf(el);
        var fx = tr.x / cell;
        var fy = tr.y / cell;
        // Lichess animates moves with CSS transforms. A piece caught midway
        // (for example a pawn between e2 and e4) would round to a fake square,
        // so do not trust a board that is still in motion.
        if (Math.abs(fx - Math.round(fx)) > 0.18 ||
            Math.abs(fy - Math.round(fy)) > 0.18) {
          return null;
        }
        var col = Math.round(fx);
        var row = Math.round(fy);
        if (col < 0 || col > 7 || row < 0 || row > 7) continue;
        var file = orientation === 'white' ? col : 7 - col;
        var rank = orientation === 'white' ? 7 - row : row;
        board[rank * 8 + file] = pc;
        placed++;
      }
      if (placed < 2) return null;

      var lastMoveColor = null;
      var last = lichessLastMove(boardEl, orientation, rect);
      if (last) {
        // The square that still holds a piece is the destination of the last
        // move. Castling highlights both the king's and the rook's square.
        var atA = board[last.a];
        var atB = board[last.b];
        if (atA && !atB) lastMoveColor = core.colorOf(atA);
        else if (atB && !atA) lastMoveColor = core.colorOf(atB);
        else if (atA && atB && core.colorOf(atA) === core.colorOf(atB)) lastMoveColor = core.colorOf(atA);
      }

      var clocks = lichessClocks(orientation);
      return {
        board: board,
        orientation: orientation,
        clockTurn: clocks.turn,
        clockRemaining: { w: clocks.w, b: clocks.b },
        lastMoveColor: lastMoveColor,
        ratings: readRatingsFor(boardEl, orientation),
        gameOver: resultTextGameOver()
      };
    }
  };

  sites.chesscom = chesscom;
  sites.lichess = lichess;
  sites.list = [chesscom, lichess];
  sites.detect = function () {
    var host = location.hostname;
    for (var i = 0; i < sites.list.length; i++) {
      if (sites.list[i].matches(host)) return sites.list[i];
    }
    return null;
  };

  CA.sites = sites;
})();
