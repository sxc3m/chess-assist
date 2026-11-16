/*
 * Chess Assist - page-world bridge (runs in the page's own JS world).
 *
 * Content scripts cannot touch Lichess' `window.lichess` object on Chromium
 * (isolated worlds), and Firefox's `wrappedJSObject` calls into
 * `lichess.analysis.playUci()` do not apply moves reliably either. Chess.com
 * has the same problem: its board custom element exposes the live `game`
 * object only to page scripts.
 *
 * This small script is injected as a page script by
 * content/page-bridge-client.js and talks to the content script with
 * window.postMessage.
 *
 * Lichess auto-move: the public API intentionally does not expose live move
 * submission, so the bridge keeps the game's WebSocket and sends the same
 * `{t:'move'}` frame the round controller uses. The server does not require
 * the client-side `sign` guard for the frame, so a raw frame is accepted
 * exactly like one sent by the page itself.
 *
 * Chess.com auto-move: `chess-board` / `wc-chess-board` expose `game` with
 * `getFEN()`, `getTurn()`, `getPlayingAs()`, `getLegalMoves()` and `move()`.
 * The bridge calls those methods in the page world; synthetic DOM events do
 * not work with the current renderer.
 */
(function () {
  'use strict';
  if (window.__chessAssistPageBridge) return;
  window.__chessAssistPageBridge = true;

  var token = null;
  var sockets = [];
  var patched = false;

  /* ------------------------------------------------------------- Lichess */

  function remember(ws) {
    for (var i = 0; i < sockets.length; i++) {
      if (sockets[i].ws === ws) {
        sockets[i].at = Date.now();
        return;
      }
    }
    sockets.push({ ws: ws, at: Date.now() });
    if (sockets.length > 12) sockets.shift();
  }

  function patchSocketSends() {
    if (patched) return;
    patched = true;
    var proto = window.WebSocket && window.WebSocket.prototype;
    if (!proto || typeof proto.send !== 'function') return;
    var original = proto.send;
    proto.send = function () {
      try { remember(this); } catch (e) { /* ignore */ }
      return original.apply(this, arguments);
    };
  }

  function isGameSocket(ws, pathPrefix) {
    if (!ws || ws.readyState !== 1) return false;
    var url = String(ws.url || '');
    // socket1.lichess.org/play/<gameId>/white/v6?...
    var m = /\/(play|watch)\/[^/?#]+\/(?:[^/?#]+\/)*v\d+/.exec(url);
    if (!m) return false;
    return !pathPrefix || m[1] === pathPrefix;
  }

  function pickSocket(pathPrefix) {
    for (var i = sockets.length - 1; i >= 0; i--) {
      if (isGameSocket(sockets[i].ws, pathPrefix)) return sockets[i].ws;
    }
    return null;
  }

  /*
   * `window.lichess.socket.subscribeToMoveLatency()` emits a `socket.send`
   * pubsub event, which makes the round controller call WebSocket.send()
   * synchronously. Our patched prototype records that socket, so we learn the
   * game socket even though the controller itself is not exposed to extensions.
   */
  function ensureGameSocket() {
    patchSocketSends();
    var ws = pickSocket('play');
    if (ws) return ws;
    try {
      var api = window.lichess && window.lichess.socket;
      if (api && typeof api.subscribeToMoveLatency === 'function') {
        // A no-op subscriber: the function's side effect is what matters, and
        // a missing callback would throw when lila later reports latency.
        api.subscribeToMoveLatency(function () {});
      }
    } catch (e) { /* ignore */ }
    return pickSocket('play');
  }

  function analysisController() {
    try {
      var lichess = window.lichess;
      var analysis = lichess && lichess.analysis;
      if (analysis && typeof analysis.playUci === 'function') return analysis;
    } catch (e) { /* ignore */ }
    return null;
  }

  function playAnalysis(uci) {
    var ctrl = analysisController();
    if (!ctrl) return null;
    ctrl.playUci(uci);
    return { ok: true, via: 'analysis' };
  }

  function playLive(uci) {
    var ws = ensureGameSocket();
    if (!ws) {
      // The page only has a spectator socket (/watch/...), if anything at all.
      // Sending a move there is pointless and the server would reject it.
      return { ok: false, error: pickSocket() ? 'not-a-player' : 'no-live-socket' };
    }
    try {
      // Exactly the payload lila's RoundController produces. `a`, `l` and `s`
      // are optional; the server derives the clock from its own state.
      ws.send(JSON.stringify({ t: 'move', d: { u: uci } }));
      return { ok: true, via: 'socket' };
    } catch (e) {
      return { ok: false, error: 'socket-send-failed' };
    }
  }

  function lichessInfo() {
    var ws = pickSocket();
    return {
      hasAnalysis: !!analysisController(),
      hasGameSocket: !!ws,
      gameSocket: ws ? String(ws.url || '').replace(/sri=[^&]+/, 'sri=***') : null,
      path: location.pathname
    };
  }

  /* ------------------------------------------------------------ chess.com */

  var lastChesscomBoard = null;

  function call(obj, name, args) {
    try {
      if (obj && typeof obj[name] === 'function') return obj[name].apply(obj, args || []);
    } catch (e) { /* ignore */ }
    return null;
  }

  function asColor(value) {
    if (value === 1 || value === '1') return 'w';
    if (value === 2 || value === '2') return 'b';
    var text = String(value == null ? '' : value).toLowerCase().trim();
    if (text === 'w' || text === 'white') return 'w';
    if (text === 'b' || text === 'black') return 'b';
    return null;
  }

  function normalizeFen(raw) {
    if (typeof raw !== 'string') return null;
    var parts = raw.trim().split(/\s+/);
    if (parts.length < 2 || parts[0].split('/').length !== 8) return null;
    if (parts[1] !== 'w' && parts[1] !== 'b') return null;
    var defaults = ['w', '-', '-', '0', '1'];
    for (var i = parts.length; i < 6; i++) parts.push(defaults[i - 1]);
    if (parts[3] && parts[3] !== '-') parts[3] = parts[3].toLowerCase();
    return parts.slice(0, 6).join(' ');
  }

  function chesscomFen(game) {
    var fen = call(game, 'getFEN');
    if (!fen) {
      try { if (typeof game.fen === 'string') fen = game.fen; } catch (e) { /* ignore */ }
    }
    if (!fen) {
      var position = null;
      try { position = game.getPosition; } catch (e) { position = null; }
      if (typeof position === 'function') position = call(game, 'getPosition');
      if (typeof position === 'string') fen = position;
      else if (position && typeof position.fen === 'string') fen = position.fen;
    }
    return normalizeFen(fen);
  }

  function parentOrHost(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    try {
      if (typeof node.getRootNode === 'function') {
        var root = node.getRootNode();
        if (root && root.host) return root.host;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function gameOf(el) {
    var node = el;
    for (var depth = 0; node && depth < 6; depth++) {
      try { if (node.game && typeof node.game === 'object') return node.game; } catch (e) { /* ignore */ }
      node = parentOrHost(node);
    }
    return null;
  }

  function collectChesscomBoards(root, out, depth) {
    if (!root || depth > 3) return;
    var selectors = [
      'chess-board',
      'wc-chess-board',
      '.board-layout-chessboard',
      '#board',
      '.board',
      '.chessboard'
    ];
    for (var s = 0; s < selectors.length; s++) {
      var nodes;
      try { nodes = root.querySelectorAll(selectors[s]); } catch (e) { nodes = []; }
      for (var i = 0; i < nodes.length; i++) {
        if (out.indexOf(nodes[i]) < 0) out.push(nodes[i]);
      }
    }

    // Some builds wrap the custom element in an open shadow root. Check the
    // known board containers only: querying `*` here would walk the whole
    // page on every poll and burn CPU in the chess.com lobby.
    var hosts;
    try {
      hosts = root.querySelectorAll(
        '#board-layout-chessboard, #board-layout, #board-layout-main, ' +
        '[class*="board-layout"], chess-board, wc-chess-board'
      );
    } catch (e) { hosts = []; }
    for (var h = 0; h < hosts.length; h++) {
      var shadow = hosts[h].shadowRoot;
      if (shadow) collectChesscomBoards(shadow, out, depth + 1);
    }
  }

  function findChesscomBoard() {
    if (lastChesscomBoard && lastChesscomBoard.isConnected && gameOf(lastChesscomBoard)) {
      return lastChesscomBoard;
    }
    lastChesscomBoard = null;

    var roots = [document];
    var deep = document.querySelector('#board-layout-chessboard');
    if (deep && deep.shadowRoot) roots.push(deep.shadowRoot);

    var boards = [];
    for (var i = 0; i < roots.length; i++) collectChesscomBoards(roots[i], boards, 0);

    for (var b = 0; b < boards.length; b++) {
      if (gameOf(boards[b])) {
        lastChesscomBoard = boards[b];
        return boards[b];
      }
    }
    return null;
  }

  function chesscomBoardAndGame() {
    var el = findChesscomBoard();
    if (!el) return null;
    var game = gameOf(el);
    if (!game) return null;
    return { el: el, game: game };
  }

  function chesscomOrientation(el, game, playingAs) {
    var node = el;
    for (var depth = 0; node && depth < 5; depth++, node = parentOrHost(node)) {
      try {
        if (node.classList) {
          if (node.classList.contains('flipped') ||
              node.classList.contains('orientation-black')) return 'black';
          if (node.classList.contains('orientation-white')) return 'white';
        }
      } catch (e) { /* ignore */ }
      try {
        if (node.getAttribute) {
          var flag = node.getAttribute('flipped');
          if (flag !== null && flag !== 'false') return 'black';
          var data = String(node.getAttribute('data-orientation') ||
                             node.getAttribute('data-board-orientation') || '').toLowerCase();
          if (data === 'black' || data === 'b') return 'black';
          if (data === 'white' || data === 'w') return 'white';
        }
      } catch (e) { /* ignore */ }
    }

    var view = asColor(call(game, 'getOrientation')) ||
               asColor(call(game, 'getBoardOrientation'));
    if (view) return view === 'b' ? 'black' : 'white';

    // Chess.com keeps your own board oriented to you by default.
    if (playingAs) return playingAs === 'b' ? 'black' : 'white';
    return 'white';
  }

  function chesscomGameOver(game) {
    if (call(game, 'isGameOver') === true) return true;
    if (call(game, 'getGameOver') === true) return true;
    try { if (game.gameOver === true) return true; } catch (e) { /* ignore */ }
    return false;
  }

  function boardDescriptor(el) {
    var rect = null;
    try {
      var r = el.getBoundingClientRect();
      rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    } catch (e) { rect = null; }
    return {
      tag: String(el.tagName || '').toLowerCase(),
      id: String(el.id || ''),
      className: String(el.className || ''),
      rect: rect
    };
  }

  function chesscomState() {
    var found = chesscomBoardAndGame();
    if (!found) return { ok: false, error: 'no-game' };
    var game = found.game;
    var fen = chesscomFen(game);
    if (!fen) return { ok: false, error: 'no-fen' };

    var playingAs = asColor(call(game, 'getPlayingAs'));
    var turn = asColor(call(game, 'getTurn'));
    var parts = fen.split(' ');
    if (!turn && (parts[1] === 'w' || parts[1] === 'b')) turn = parts[1];

    return {
      ok: true,
      state: {
        fen: fen,
        turn: turn,
        playingAs: playingAs,
        orientation: chesscomOrientation(found.el, game, playingAs),
        gameOver: chesscomGameOver(game),
        board: boardDescriptor(found.el)
      }
    };
  }

  function chesscomPlay(uci) {
    var found = chesscomBoardAndGame();
    if (!found) return { ok: false, error: 'no-game' };
    var game = found.game;

    var from = uci.substring(0, 2);
    var to = uci.substring(2, 4);
    var promotion = uci.length > 4 ? uci.charAt(4) : 'q';

    var turn = asColor(call(game, 'getTurn'));
    var playingAs = asColor(call(game, 'getPlayingAs'));
    if (turn && playingAs && turn !== playingAs) {
      return { ok: false, error: 'not-your-turn' };
    }

    var legal = call(game, 'getLegalMoves');
    var chosen = null;
    if (legal && legal.length) {
      var fallback = null;
      for (var i = 0; i < legal.length; i++) {
        var m = legal[i];
        if (!m) continue;
        var mf = String(m.from || m.fromSquare || m.source || '').toLowerCase();
        var mt = String(m.to || m.toSquare || m.target || '').toLowerCase();
        if (mf !== from || mt !== to) continue;
        if (!fallback) fallback = m;
        var mp = String(m.promotion || '').toLowerCase();
        if (!m.promotion || mp === promotion) { chosen = m; break; }
      }
      if (!chosen) chosen = fallback;
      if (!chosen) return { ok: false, error: 'illegal-move' };
    }

    var payload = {};
    if (chosen) {
      for (var key in chosen) {
        if (Object.prototype.hasOwnProperty.call(chosen, key)) payload[key] = chosen[key];
      }
    }
    payload.from = from;
    payload.to = to;
    payload.promotion = promotion;
    payload.animate = true;
    payload.userGenerated = true;

    try {
      game.move(payload);
    } catch (e) {
      return { ok: false, error: 'move-failed' };
    }
    return { ok: true, via: 'chesscom-api' };
  }

  /* ------------------------------------------------------------- dispatch */

  function siteId() {
    var host = '';
    try { host = String(location.hostname || ''); } catch (e) { host = ''; }
    if (/(^|\.)chess\.com$/i.test(host)) return 'chesscom';
    return 'lichess';
  }

  function move(uci) {
    uci = String(uci || '').toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
      return { ok: false, error: 'bad-uci' };
    }
    if (siteId() === 'chesscom') return chesscomPlay(uci);
    var analysis = playAnalysis(uci);
    if (analysis) return analysis;
    return playLive(uci);
  }

  function info() {
    if (siteId() === 'chesscom') {
      var found = chesscomBoardAndGame();
      return {
        site: 'chesscom',
        hasGame: !!found,
        hasFen: !!(found && chesscomFen(found.game)),
        path: location.pathname
      };
    }
    var data = lichessInfo();
    data.site = 'lichess';
    return data;
  }

  function reply(data, payload) {
    var response = {
      __ca: 'bridge-response',
      token: token,
      id: data.id,
      ok: !!payload.ok
    };
    if (payload.via) response.via = payload.via;
    if (payload.error) response.error = payload.error;
    if (payload.info) response.info = payload.info;
    if (payload.state) response.state = payload.state;
    try { window.postMessage(response, '*'); } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__ca !== 'bridge-request') return;
    if (token == null) token = String(data.token || '');
    if (!token || data.token !== token) return;

    if (data.action === 'ping') {
      reply(data, { ok: true, info: info() });
      return;
    }
    if (data.action === 'move' || data.action === 'chesscom-move') {
      var result;
      try { result = move(data.uci); } catch (e) {
        result = { ok: false, error: 'bridge-exception' };
      }
      reply(data, result);
      return;
    }
    if (data.action === 'chesscom-state') {
      var state;
      try { state = chesscomState(); } catch (e) {
        state = { ok: false, error: 'bridge-exception' };
      }
      reply(data, state);
      return;
    }
    reply(data, { ok: false, error: 'unknown-action' });
  });

  // Patch as soon as the bridge loads so any later socket send is recorded.
  patchSocketSends();
})();
