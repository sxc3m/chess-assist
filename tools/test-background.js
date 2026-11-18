/*
 * End-to-end test of background/background.js with the real Stockfish WASM
 * engine, a fake Worker and fake runtime ports.
 *
 * Usage: node tools/test-background.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var stockfishFactory = require('../engine/stockfish.js');
var Chess = require('../content/vendor/chess.js.raw').Chess;

var root = path.resolve(__dirname, '..');
var connectListeners = [];
var runtimeMessageListeners = [];
var workerCount = 0;

function FakeWorker(url) {
  var self = this;
  this.url = url;
  this.dead = false;
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.engine = stockfishFactory();
  this.engine.listener = function (chunk) {
    setImmediate(function () {
      if (self.dead) return;
      if (self.onmessage) self.onmessage({ data: chunk });
    });
  };
  workerCount++;
}

FakeWorker.prototype.postMessage = function (command) {
  if (this.dead) return;
  if (this.engine && typeof this.engine.processCommand === 'function') {
    this.engine.processCommand(command);
  }
};

FakeWorker.prototype.terminate = function () {
  this.dead = true;
};

/*
 * The Node build of stockfish.js keeps one engine per process, so a second
 * "worker" would share the first one's instance and re-enter its init. The
 * helper engines get a stub instead: enough of UCI to be told what to do, which
 * keeps this file about the host and leaves the parallel scheduling to
 * tools/test-parallel.js.
 */
function StubWorker() {
  this.dead = false;
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  workerCount++;
}

StubWorker.prototype.emit = function (line) {
  var self = this;
  setImmediate(function () {
    if (self.dead || !self.onmessage) return;
    self.onmessage({ data: line + '\n' });
  });
};

StubWorker.prototype.postMessage = function (command) {
  if (this.dead) return;
  if (command === 'uci') { this.emit('uciok'); return; }
  if (command === 'isready') { this.emit('readyok'); return; }
  if (command.indexOf('go') === 0) {
    var moves = /searchmoves ([^ ]+)/.exec(command);
    this.emit('info depth 10 score cp 5 pv ' + (moves ? moves[1] : 'e2e4'));
    this.emit('bestmove ' + (moves ? moves[1] : 'e2e4'));
  }
};

StubWorker.prototype.terminate = function () {
  this.dead = true;
};

function createWorker(url) {
  return workerCount === 0 ? new FakeWorker(url) : new StubWorker(url);
}

var browser = {
  runtime: {
    getURL: function (relative) { return 'moz-extension://chess-assist-test/' + relative; },
    onConnect: {
      addListener: function (fn) { connectListeners.push(fn); }
    },
    onMessage: {
      addListener: function (fn) { runtimeMessageListeners.push(fn); }
    }
  },
  storage: {
    local: {
      get: function () { return Promise.resolve({}); },
      set: function () { return Promise.resolve(); }
    },
    onChanged: { addListener: function () {} }
  }
};

var sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  setImmediate: setImmediate,
  Worker: createWorker,
  browser: browser,
  // A desktop with eight cores: the split is supposed to switch itself on for
  // a long search and stay off where it cannot pay for itself.
  navigator: {
    hardwareConcurrency: 8,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0'
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(
  fs.readFileSync(path.join(root, 'content/lib/core.js'), 'utf8'),
  sandbox,
  { filename: 'content/lib/core.js' }
);
vm.runInContext(
  fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'),
  sandbox,
  { filename: 'background/background.js' }
);

function createPort() {
  var port = {
    name: 'ca-engine',
    messages: [],
    messageListeners: [],
    disconnectListeners: [],
    postMessage: function (message) {
      port.messages.push(message);
    },
    onMessage: {
      addListener: function (fn) { port.messageListeners.push(fn); }
    },
    onDisconnect: {
      addListener: function (fn) { port.disconnectListeners.push(fn); }
    },
    disconnect: function () {
      port.disconnectListeners.forEach(function (fn) { fn(); });
    }
  };
  return port;
}

function connectPort() {
  var port = createPort();
  connectListeners.forEach(function (fn) { fn(port); });
  return port;
}

function waitFor(port, predicate, timeoutMs, label) {
  timeoutMs = timeoutMs || 20000;
  label = label || 'message';
  var started = Date.now();
  return new Promise(function (resolve, reject) {
    (function check() {
      for (var i = 0; i < port.messages.length; i++) {
        if (predicate(port.messages[i])) {
          resolve(port.messages[i]);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timeout waiting for ' + label + '; recent messages: ' +
          JSON.stringify(port.messages.slice(-8))));
        return;
      }
      setTimeout(check, 25);
    })();
  });
}

function send(port, message) {
  port.messageListeners.forEach(function (fn) { fn(message); });
}

function fenAfter(moves) {
  var game = new Chess();
  for (var i = 0; i < moves.length; i++) game.move(moves[i]);
  return game.fen();
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

var failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (error) {
    failures++;
    console.error('FAIL  ' + name);
    console.error(error && error.stack ? error.stack : error);
  }
}

async function main() {
  var port = connectPort();

  console.log('background: engine startup');
  var ready = await waitFor(port, function (m) {
    return m.type === 'status' && m.ready === true;
  }, 30000, 'engine ready');
  check('engine becomes ready', function () {
    assert.strictEqual(ready.ready, true);
    assert.strictEqual(ready.error, null);
    assert.strictEqual(workerCount, 1);
  });

  console.log('background: analysis');
  send(port, {
    type: 'analyze',
    id: 1,
    fen: sandbox.CA.core.START_FEN,
    multiPV: 1,
    movetime: 500
  });
  var best1 = await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 1;
  }, 30000, 'bestmove 1');
  var analysis1 = port.messages.filter(function (m) {
    return m.type === 'analysis' && m.id === 1;
  });
  check('returns a legal best move', function () {
    assert.match(best1.uci, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    assert.strictEqual(best1.fen, sandbox.CA.core.START_FEN);
    assert.ok(analysis1.length > 0);
    assert.ok(analysis1[analysis1.length - 1].lines[0].pv.length > 0);
    assert.strictEqual(analysis1[analysis1.length - 1].lines[0].multipv, 1);
  });

  var midFen = fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
  send(port, {
    type: 'analyze',
    id: 2,
    fen: midFen,
    multiPV: 2,
    movetime: 800
  });
  var best2 = await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 2;
  }, 30000, 'bestmove 2');
  var analysis2 = port.messages.filter(function (m) {
    return m.type === 'analysis' && m.id === 2;
  });
  check('supports MultiPV and returns the correct FEN', function () {
    assert.match(best2.uci, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    var last = analysis2[analysis2.length - 1];
    assert.ok(last);
    assert.strictEqual(last.fen, midFen);
    assert.ok(last.lines.length >= 1);
    assert.ok(last.lines[0].pv.length > 0);
    if (last.lines.length > 1) {
      assert.strictEqual(last.lines[1].multipv, 2);
    }
  });

  console.log('background: supersede and stop');
  send(port, { type: 'analyze', id: 3, fen: midFen, multiPV: 1, movetime: 2500 });
  await delay(180);
  send(port, { type: 'analyze', id: 4, fen: sandbox.CA.core.START_FEN, multiPV: 1, movetime: 300 });
  var best4 = await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 4;
  }, 30000, 'bestmove 4');
  await delay(400);
  check('a newer request supersedes the old one', function () {
    assert.match(best4.uci, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    assert.strictEqual(port.messages.some(function (m) {
      return m.type === 'bestmove' && m.id === 3;
    }), false);
  });

  send(port, { type: 'analyze', id: 5, fen: midFen, multiPV: 1, movetime: 2500 });
  await delay(200);
  send(port, { type: 'stop' });
  await waitFor(port, function (m) {
    return m.type === 'cancelled' && m.id === 5;
  }, 10000, 'cancelled 5');
  await delay(450);
  check('stop cancels the search without a bestmove', function () {
    assert.strictEqual(port.messages.some(function (m) {
      return m.type === 'bestmove' && m.id === 5;
    }), false);
  });

  send(port, { type: 'analyze', id: 7, fen: midFen, multiPV: 1, movetime: 5000 });
  await delay(180);
  runtimeMessageListeners.forEach(function (fn) {
    fn({ type: 'ca-engine-restart', build: 'full' }, {}, function () {});
  });
  await waitFor(port, function (m) {
    return m.type === 'cancelled' && m.id === 7;
  }, 5000, 'cancelled 7');
  check('restart cancels the active search', function () {
    assert.strictEqual(port.messages.some(function (m) {
      return m.type === 'bestmove' && m.id === 7;
    }), false);
  });
  var restartMark = port.messages.length;
  for (var readyTry = 0; readyTry < 200; readyTry++) {
    var readyAgain = port.messages.slice(restartMark).some(function (m) {
      return m.type === 'status' && m.ready === true;
    });
    if (readyAgain) break;
    await delay(100);
  }

  console.log('background: validation and status');
  send(port, { type: 'analyze', id: 6, fen: 'not-a-fen', multiPV: 1, movetime: 300 });
  var bad = await waitFor(port, function (m) {
    return m.type === 'error' && m.id === 6;
  }, 5000, 'error 6');
  check('rejects an invalid FEN', function () {
    assert.ok(bad.message.length > 0);
  });

  var response = null;
  runtimeMessageListeners.forEach(function (fn) {
    fn({ type: 'ca-engine-status' }, {}, function (value) { response = value; });
  });
  check('answers popup status requests', function () {
    assert.ok(response);
    assert.strictEqual(response.ready, true);
    assert.strictEqual(response.engine, 'Stockfish 19 NNUE');
    assert.strictEqual(response.error, null);
  });

  var restartResponse = null;
  runtimeMessageListeners.forEach(function (fn) {
    fn({ type: 'ca-engine-restart', build: 'lite' }, {}, function (value) { restartResponse = value; });
  });
  check('restart switches to the requested build', function () {
    assert.ok(restartResponse && restartResponse.ok);
    assert.strictEqual(restartResponse.buildSetting, 'lite');
    assert.strictEqual(restartResponse.build, 'lite');
  });

  // The Node build of stockfish.js keeps its own event loop alive. The test is
  // complete, so terminate it explicitly.
  console.log('');
  if (failures) {
    console.error(failures + ' checks failed');
    process.exit(1);
  }
  console.log('background tests passed');
  process.exit(0);
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
