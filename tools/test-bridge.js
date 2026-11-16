/*
 * Unit tests for the Lichess bridge:
 *
 *   content/page-bridge.js         page-world API and live socket frames
 *   content/page-bridge-client.js  content-script side, retries and errors
 *
 * Both scripts are loaded into sandboxes with a fake window, document,
 * WebSocket and postMessage channel. Tests cover the analysis API, the live
 * game socket frame, spectator pages, the token guard, UCI validation and the
 * client's retry of a not-yet-open game socket.
 *
 * Usage: node tools/test-bridge.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.resolve(__dirname, '..');
var source = fs.readFileSync(path.join(root, 'content/page-bridge.js'), 'utf8');
var clientSource = fs.readFileSync(path.join(root, 'content/page-bridge-client.js'), 'utf8');

var failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failures++;
    console.error('  FAIL ' + name);
    console.error('       ' + (e && e.message ? e.message : e));
  }
}

function makeSandbox(options) {
  options = options || {};
  var listeners = [];
  var posted = [];
  var playUciCalls = [];
  var subscribeCalls = 0;
  var fakeDocument = null;
  var chesscomGame = null;
  var chesscomBoard = null;
  var playedMoves = [];

  function FakeSocket(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
  }
  FakeSocket.prototype.send = function (data) {
    this.sent.push(String(data));
  };

  if (options.chesscom) {
    var cc = options.chesscom;
    chesscomGame = {
      fen: cc.fen,
      getFEN: function () { return cc.fen; },
      getTurn: function () { return cc.turn; },
      getPlayingAs: function () { return cc.playingAs; },
      getOrientation: function () { return cc.orientation || null; },
      getLegalMoves: function () { return cc.legalMoves || []; },
      getPosition: cc.position !== undefined ? cc.position : function () { return null; },
      isGameOver: function () { return !!cc.gameOver; },
      move: function (move) {
        playedMoves.push(move);
        if (cc.onMove) cc.onMove(move);
      }
    };
    chesscomBoard = {
      tagName: 'CHESS-BOARD',
      id: '',
      className: '',
      isConnected: true,
      parentElement: null,
      classList: { contains: function () { return false; } },
      getAttribute: function () { return null; },
      getBoundingClientRect: function () {
        return { left: 10, top: 20, width: 640, height: 640 };
      },
      game: chesscomGame
    };
    fakeDocument = {
      querySelector: function (selector) {
        return selector === '#board-layout-chessboard' ? null : null;
      },
      querySelectorAll: function (selector) {
        if (selector === 'chess-board' || selector === '*') return [chesscomBoard];
        return [];
      }
    };
  }

  if (!fakeDocument) {
    fakeDocument = {
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; }
    };
  }

  var windowObject = {
    WebSocket: FakeSocket,
    addEventListener: function (type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    postMessage: function (data) {
      posted.push(data);
    },
    lichess: {
      socket: {
        subscribeToMoveLatency: function () {
          subscribeCalls++;
          if (options.onSubscribe) options.onSubscribe(windowObject);
        }
      }
    }
  };
  if (options.analysis) {
    windowObject.lichess.analysis = {
      playUci: function (uci) {
        playUciCalls.push(uci);
        if (options.onPlayUci) options.onPlayUci(windowObject, uci);
      }
    };
  }

  var sandbox = {
    window: windowObject,
    location: {
      pathname: options.pathname || '/analysis',
      hostname: options.hostname || ''
    },
    Date: Date,
    JSON: JSON,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  sandbox.document = fakeDocument;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'content/page-bridge.js' });

  function send(data) {
    listeners.forEach(function (fn) {
      fn({ source: windowObject, data: data });
    });
  }

  return {
    window: windowObject,
    FakeSocket: FakeSocket,
    posted: posted,
    playUciCalls: playUciCalls,
    subscribeCalls: function () { return subscribeCalls; },
    chesscomBoard: chesscomBoard,
    chesscomGame: chesscomGame,
    playedMoves: playedMoves,
    send: send,
    request: function (token, id, action, uci) {
      send({ __ca: 'bridge-request', token: token, id: id, action: action, uci: uci });
    },
    response: function (id) {
      for (var i = posted.length - 1; i >= 0; i--) {
        if (posted[i] && posted[i].id === id) return posted[i];
      }
      return null;
    }
  };
}

console.log('bridge: analysis pages');

(function () {
  var box = makeSandbox({ analysis: true });
  box.request('t1', 1, 'ping');
  var ping = box.response(1);
  check('answers ping and reports the analysis controller', function () {
    assert.ok(ping);
    assert.strictEqual(ping.ok, true);
    assert.strictEqual(ping.info.hasAnalysis, true);
    assert.strictEqual(ping.info.hasGameSocket, false);
  });

  box.request('t1', 2, 'move', 'e2e4');
  var move = box.response(2);
  check('plays analysis moves through lichess.analysis.playUci', function () {
    assert.deepStrictEqual(box.playUciCalls, ['e2e4']);
    assert.ok(move);
    assert.strictEqual(move.ok, true);
    assert.strictEqual(move.via, 'analysis');
  });

  box.request('t1', 3, 'move', 'e9e4');
  var bad = box.response(3);
  check('rejects an invalid UCI before touching the page API', function () {
    assert.ok(bad);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, 'bad-uci');
    assert.deepStrictEqual(box.playUciCalls, ['e2e4']);
  });

  box.request('other-token', 4, 'move', 'd2d4');
  check('ignores requests with a different token', function () {
    assert.strictEqual(box.response(4), null);
    assert.deepStrictEqual(box.playUciCalls, ['e2e4']);
  });
}());

console.log('bridge: live games');

(function () {
  var box = makeSandbox({ onSubscribe: function (win) { /* no socket exists */ } });
  box.request('t2', 1, 'move', 'e2e4');
  var none = box.response(1);
  check('reports a missing game socket', function () {
    assert.ok(none);
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.error, 'no-live-socket');
    assert.strictEqual(box.subscribeCalls(), 1);
  });
}());

(function () {
  var box = makeSandbox({});
  var socket = new box.FakeSocket('wss://socket2.lichess.org/play/abcd1234/white/v6?sri=secret');
  // Any send through the patched prototype registers the socket, exactly as
  // the round controller's own traffic does on a real page.
  socket.send('{"t":"ping"}');
  box.request('t3', 1, 'move', 'e7e5');
  var live = box.response(1);
  check('sends the move frame on a live /play/ socket', function () {
    assert.ok(live);
    assert.strictEqual(live.ok, true);
    assert.strictEqual(live.via, 'socket');
    var last = socket.sent[socket.sent.length - 1];
    assert.strictEqual(last, '{"t":"move","d":{"u":"e7e5"}}');
  });

  box.request('t3', 2, 'ping');
  var info = box.response(2);
  check('does not leak the socket signature in bridge info', function () {
    assert.strictEqual(info.info.hasGameSocket, true);
    assert.ok(info.info.gameSocket.indexOf('sri=***') > 0);
    assert.strictEqual(info.info.gameSocket.indexOf('secret'), -1);
  });
}());

(function () {
  var box = makeSandbox({});
  var socket = new box.FakeSocket('wss://socket2.lichess.org/watch/abcd1234/white/v6?sri=secret');
  socket.send('{"t":"ping"}');
  box.request('t4', 1, 'move', 'e2e4');
  var watched = box.response(1);
  check('refuses moves on a spectator /watch/ socket', function () {
    assert.ok(watched);
    assert.strictEqual(watched.ok, false);
    assert.strictEqual(watched.error, 'not-a-player');
    assert.strictEqual(socket.sent.length, 1);
  });
}());

(function () {
  var box = makeSandbox({ analysis: true });
  var socket = new box.FakeSocket('wss://socket2.lichess.org/play/abcd1234/white/v6');
  socket.send('{"t":"ping"}');
  box.request('t5', 1, 'move', 'g1f3');
  var move = box.response(1);
  check('prefers the analysis controller over a live socket', function () {
    assert.strictEqual(move.via, 'analysis');
    assert.deepStrictEqual(box.playUciCalls, ['g1f3']);
    assert.strictEqual(socket.sent.length, 1);
  });
}());

(function () {
  var box = makeSandbox({ analysis: true });
  box.request('t6', 1, 'unknown');
  var unknown = box.response(1);
  check('rejects unknown actions', function () {
    assert.ok(unknown);
    assert.strictEqual(unknown.error, 'unknown-action');
  });
}());

console.log('bridge: chess.com');

(function () {
  var box = makeSandbox({
    hostname: 'www.chess.com',
    pathname: '/play/computer',
    chesscom: {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      turn: 2,
      playingAs: 1,
      orientation: 'white',
      legalMoves: [
        { from: 'e7', to: 'e5', promotion: null },
        { from: 'c7', to: 'c5', promotion: null }
      ]
    }
  });

  box.request('t7', 1, 'chesscom-state');
  var state = box.response(1);
  check('reads FEN, turn, playing colour and orientation from game', function () {
    assert.ok(state);
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.state.fen.split(' ')[1], 'b');
    assert.strictEqual(state.state.turn, 'b');
    assert.strictEqual(state.state.playingAs, 'w');
    assert.strictEqual(state.state.orientation, 'white');
    assert.strictEqual(state.state.board.tag, 'chess-board');
    assert.strictEqual(state.state.board.rect.width, 640);
  });
}());

(function () {
  var position = {
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    turn: 2,
    playingAs: 2,
    orientation: 'black',
    legalMoves: [
      { from: 'e7', to: 'e5', promotion: null },
      { from: 'c7', to: 'c5', promotion: null }
    ]
  };
  var box = makeSandbox({ hostname: 'www.chess.com', chesscom: position });

  box.request('t7', 2, 'chesscom-move', 'e7e5');
  var move = box.response(2);
  check('plays a legal move through game.move', function () {
    assert.ok(move);
    assert.strictEqual(move.ok, true);
    assert.strictEqual(move.via, 'chesscom-api');
    assert.strictEqual(box.playedMoves.length, 1);
    assert.strictEqual(box.playedMoves[0].from, 'e7');
    assert.strictEqual(box.playedMoves[0].to, 'e5');
    assert.strictEqual(box.playedMoves[0].promotion, 'q');
    assert.strictEqual(box.playedMoves[0].animate, true);
    assert.strictEqual(box.playedMoves[0].userGenerated, true);
  });

  box.request('t7', 3, 'chesscom-move', 'e7e4');
  var illegal = box.response(3);
  check('rejects a move that is not in getLegalMoves', function () {
    assert.ok(illegal);
    assert.strictEqual(illegal.ok, false);
    assert.strictEqual(illegal.error, 'illegal-move');
    assert.strictEqual(box.playedMoves.length, 1);
  });

  position.turn = 1;
  position.playingAs = 2;
  box.request('t7', 4, 'chesscom-move', 'e2e4');
  var wrongTurn = box.response(4);
  check('refuses a move when the game API says it is the opponent turn', function () {
    assert.ok(wrongTurn);
    assert.strictEqual(wrongTurn.ok, false);
    assert.strictEqual(wrongTurn.error, 'not-your-turn');
    assert.strictEqual(box.playedMoves.length, 1);
  });

  position.turn = 2;
  box.request('t7', 5, 'move', 'e7e5');
  var dispatched = box.response(5);
  check('dispatches the generic move action to chess.com', function () {
    assert.ok(dispatched);
    assert.strictEqual(dispatched.via, 'chesscom-api');
    assert.strictEqual(box.playedMoves.length, 2);
  });

  box.request('t7', 6, 'ping');
  var info = box.response(6);
  check('reports chess.com game availability in ping info', function () {
    assert.ok(info);
    assert.strictEqual(info.info.site, 'chesscom');
    assert.strictEqual(info.info.hasGame, true);
    assert.strictEqual(info.info.hasFen, true);
  });
}());

(function () {
  var box = makeSandbox({ hostname: 'www.chess.com' });
  box.request('t8', 1, 'chesscom-state');
  var state = box.response(1);
  check('reports no-game when the custom element has no game object', function () {
    assert.ok(state);
    assert.strictEqual(state.ok, false);
    assert.strictEqual(state.error, 'no-game');
  });
}());

(function () {
  var box = makeSandbox({
    hostname: 'www.chess.com',
    chesscom: {
      fen: null,
      position: {
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
      },
      turn: 2,
      playingAs: 1
    }
  });
  box.request('t9', 1, 'chesscom-state');
  var state = box.response(1);
  check('reads a FEN from the getPosition property', function () {
    assert.ok(state);
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.state.fen.split(' ')[1], 'b');
    assert.strictEqual(state.state.turn, 'b');
  });
}());

console.log('bridge client: retries and errors');

function makeClientSandbox(options) {
  options = options || {};
  var listeners = [];
  var requests = [];
  var appended = [];

  var windowObject = {
    addEventListener: function (type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    postMessage: function (data) {
      if (!data || data.__ca !== 'bridge-request') return;
      requests.push(data);
      if (!options.onRequest) return;
      options.onRequest(data, function (payload) {
        var response = {
          __ca: 'bridge-response',
          token: data.token,
          id: data.id,
          ok: !!payload.ok
        };
        if (payload.via) response.via = payload.via;
        if (payload.error) response.error = payload.error;
        if (payload.info) response.info = payload.info;
        if (payload.state) response.state = payload.state;
        listeners.forEach(function (fn) {
          fn({ source: windowObject, data: response });
        });
      });
    }
  };

  var documentObject = {
    head: {
      appendChild: function (el) {
        appended.push(el);
      }
    },
    documentElement: { appendChild: function () {} },
    createElement: function () {
      return { src: null, async: false, onerror: null };
    }
  };

  var api = {
    runtime: {
      getURL: function (p) {
        return options.noRuntime ? null : 'moz-extension://test/' + p;
      }
    }
  };

  var sandbox = {
    window: windowObject,
    document: documentObject,
    browser: api,
    CA: {},
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'content/page-bridge-client.js' });

  return {
    CA: sandbox.CA,
    appended: appended,
    requests: requests
  };
}

function checkAsync(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    console.log('  ok  ' + name);
  }, function (e) {
    failures++;
    console.error('  FAIL ' + name);
    console.error('       ' + (e && e.message ? e.message : e));
  });
}

async function runClientTests() {
  await checkAsync('injects the bridge and maps an analysis move', async function () {
    var box = makeClientSandbox({
      onRequest: function (req, respond) {
        if (req.action === 'ping') respond({ ok: true, info: { hasAnalysis: true } });
        else if (req.action === 'move') respond({ ok: true, via: 'analysis' });
      }
    });
    var result = await box.CA.PageBridge.move('e2e4');
    assert.strictEqual(result.via, 'lichess-api');
    assert.strictEqual(result.mode, 'analysis');
    assert.strictEqual(result.uci, 'e2e4');
    assert.strictEqual(box.appended.length, 1);
    assert.strictEqual(box.requests[0].action, 'ping');
    assert.strictEqual(box.requests[1].action, 'move');
  });

  await checkAsync('retries a move while the game socket is still opening', async function () {
    var moveRequests = 0;
    var box = makeClientSandbox({
      onRequest: function (req, respond) {
        if (req.action === 'ping') {
          respond({ ok: true, info: {} });
          return;
        }
        moveRequests++;
        if (moveRequests < 4) respond({ ok: false, error: 'no-live-socket' });
        else respond({ ok: true, via: 'socket' });
      }
    });
    var started = Date.now();
    var result = await box.CA.PageBridge.move('e7e5');
    var elapsed = Date.now() - started;
    assert.strictEqual(result.via, 'lichess-socket');
    assert.strictEqual(result.mode, 'socket');
    assert.strictEqual(result.uci, 'e7e5');
    assert.strictEqual(moveRequests, 4);
    assert.ok(elapsed >= 700, 'expected three 250ms retries, got ' + elapsed + 'ms');
  });

  await checkAsync('does not retry on a spectator socket', async function () {
    var moveRequests = 0;
    var box = makeClientSandbox({
      onRequest: function (req, respond) {
        if (req.action === 'ping') respond({ ok: true, info: {} });
        else {
          moveRequests++;
          respond({ ok: false, error: 'not-a-player' });
        }
      }
    });
    var result = await box.CA.PageBridge.move('e2e4');
    assert.strictEqual(moveRequests, 1);
    assert.ok(result.error.indexOf('наблюдение') > 0, result.error);
  });

  await checkAsync('reports a missing runtime URL as bridge unavailable', async function () {
    var box = makeClientSandbox({ noRuntime: true });
    var result = await box.CA.PageBridge.move('e2e4');
    assert.strictEqual(result.via, 'bridge');
    assert.ok(result.error.indexOf('не удалось подключиться') >= 0, result.error);
  });

  await checkAsync('returns a chess.com state snapshot', async function () {
    var box = makeClientSandbox({
      onRequest: function (req, respond) {
        if (req.action === 'ping') respond({ ok: true, info: { site: 'chesscom' } });
        else if (req.action === 'chesscom-state') {
          respond({
            ok: true,
            state: {
              fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
              turn: 'w',
              playingAs: 'w',
              orientation: 'white'
            }
          });
        }
      }
    });
    var result = await box.CA.PageBridge.chesscomState();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state.turn, 'w');
    assert.strictEqual(result.state.playingAs, 'w');
    assert.strictEqual(box.requests[1].action, 'chesscom-state');
  });

  await checkAsync('maps a chess.com game move', async function () {
    var box = makeClientSandbox({
      onRequest: function (req, respond) {
        if (req.action === 'ping') respond({ ok: true, info: {} });
        else if (req.action === 'chesscom-move') respond({ ok: true, via: 'chesscom-api' });
      }
    });
    var result = await box.CA.PageBridge.chesscomMove('e2e4');
    assert.strictEqual(result.via, 'chesscom-api');
    assert.strictEqual(result.mode, 'game-api');
    assert.strictEqual(result.uci, 'e2e4');
    assert.strictEqual(box.requests[1].uci, 'e2e4');
  });

  await checkAsync('marks a missing chess.com game as fallback-capable', async function () {
    var box = makeClientSandbox({
      onRequest: function (req, respond) {
        if (req.action === 'ping') respond({ ok: true, info: {} });
        else respond({ ok: false, error: 'no-game' });
      }
    });
    var result = await box.CA.PageBridge.chesscomMove('e2e4');
    assert.strictEqual(result.via, 'bridge');
    assert.strictEqual(result.code, 'no-game');
    assert.strictEqual(result.fallback, true);
    assert.ok(result.error.indexOf('Chess.com') === 0, result.error);
  });

  await checkAsync('does not fall back after a rejected chess.com move', async function () {
    var box = makeClientSandbox({
      onRequest: function (req, respond) {
        if (req.action === 'ping') respond({ ok: true, info: {} });
        else respond({ ok: false, error: 'not-your-turn' });
      }
    });
    var result = await box.CA.PageBridge.chesscomMove('e2e4');
    assert.strictEqual(result.fallback, false);
    assert.ok(result.error.indexOf('соперника') > 0, result.error);
  });

  console.log('');
  if (failures) {
    console.error(failures + ' checks failed');
    process.exit(1);
  }
  console.log('bridge tests passed');
}

runClientTests();
