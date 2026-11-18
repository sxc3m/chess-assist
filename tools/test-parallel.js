/*
 * End-to-end test of the root-split scheduler in background/background.js.
 *
 * A real engine cannot be used here: the Node build of stockfish.js keeps one
 * engine per process, so a second Worker would share the first one's instance.
 * The workers below are scripted instead - they speak enough UCI to be told
 * what to search and answer with a score that is a function of their id - which
 * makes every part of the scheduling deterministic: who gets which moves, who
 * wins the merge, and what happens on stop.
 *
 * Usage: node tools/test-parallel.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var Chess = require('../content/vendor/chess.js.raw').Chess;

var root = path.resolve(__dirname, '..');

var connectListeners = [];
var runtimeMessageListeners = [];
var workers = [];
var log = [];
var nextId = 0;

function Worker(url) {
  this.id = ++nextId;
  this.url = url;
  this.dead = false;
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.group = [];
  this.answer = null;
  this.timer = null;
  workers.push(this);
}

Worker.prototype.emit = function (line) {
  var self = this;
  setImmediate(function () {
    if (self.dead || !self.onmessage) return;
    self.onmessage({ data: line + '\n' });
  });
};

Worker.prototype.postMessage = function (command) {
  if (this.dead) return;
  log.push({ id: this.id, command: command });
  if (command === 'uci') { this.emit('uciok'); return; }
  if (command === 'isready') { this.emit('readyok'); return; }
  if (command.indexOf('setoption') === 0) return;
  if (command.indexOf('position') === 0) return;
  if (command === 'stop') { this.finish(); return; }
  if (command.indexOf('go') === 0) this.startGo(command);
};

Worker.prototype.startGo = function (command) {
  var self = this;
  var moves = /searchmoves ((?:[a-h][1-8][a-h][1-8][qrbn]?)(?: [a-h][1-8][a-h][1-8][qrbn]?)*)/.exec(command);
  var group = moves ? moves[1].split(' ') : [];
  // A restricted search is worth a lot here, an unrestricted one almost
  // nothing: whichever engine was handed a share must beat the primary, so the
  // merge is exercised rather than merely tolerated.
  this.group = group;
  this.answer = {
    move: group.length ? group[0] : 'b1c3',
    score: group.length ? 1000 + this.id : 10
  };
  var movetime = /movetime (\d+)/.exec(command);
  var wait = movetime ? Math.min(parseInt(movetime[1], 10), 150) : 40;
  if (this.timer) clearTimeout(this.timer);
  this.timer = setTimeout(function () { self.finish(); }, wait);
};

Worker.prototype.finish = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  if (!this.answer) return;
  var answer = this.answer;
  this.answer = null;
  this.emit('info depth 15 score cp ' + answer.score + ' pv ' + answer.move);
  this.emit('bestmove ' + answer.move);
};

Worker.prototype.terminate = function () {
  this.dead = true;
  if (this.timer) clearTimeout(this.timer);
  this.timer = null;
  this.answer = null;
};

var browser = {
  runtime: {
    getURL: function (relative) { return 'moz-extension://chess-assist-test/' + relative; },
    onConnect: { addListener: function (fn) { connectListeners.push(fn); } },
    onMessage: { addListener: function (fn) { runtimeMessageListeners.push(fn); } }
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
  Worker: Worker,
  browser: browser,
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

function connectPort() {
  var port = {
    name: 'ca-engine',
    messages: [],
    messageListeners: [],
    disconnectListeners: [],
    postMessage: function (message) { port.messages.push(message); },
    onMessage: { addListener: function (fn) { port.messageListeners.push(fn); } },
    onDisconnect: { addListener: function (fn) { port.disconnectListeners.push(fn); } },
    disconnect: function () { port.disconnectListeners.forEach(function (fn) { fn(); }); }
  };
  connectListeners.forEach(function (fn) { fn(port); });
  return port;
}

function send(port, message) {
  port.messageListeners.forEach(function (fn) { fn(message); });
}

function waitFor(port, predicate, timeoutMs, label) {
  var started = Date.now();
  return new Promise(function (resolve, reject) {
    (function check() {
      for (var i = 0; i < port.messages.length; i++) {
        if (predicate(port.messages[i])) { resolve(port.messages[i]); return; }
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timeout waiting for ' + label));
        return;
      }
      setTimeout(check, 20);
    })();
  });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function lastStatus(port) {
  for (var i = port.messages.length - 1; i >= 0; i--) {
    if (port.messages[i].type === 'status') return port.messages[i];
  }
  return null;
}

function legalMoves(fen) {
  return new Chess(fen).moves({ verbose: true }).map(function (m) {
    return String(m.from) + String(m.to) + (m.promotion ? m.promotion : '');
  });
}

function goCommandsSince(mark) {
  return log.slice(mark).filter(function (entry) {
    return entry.command.indexOf('go') === 0;
  });
}

function hasSearchmoves(entry) {
  return entry.command.indexOf('searchmoves') >= 0;
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
  var fen = sandbox.CA.core.START_FEN;
  var roots = legalMoves(fen);

  await waitFor(port, function (m) {
    return m.type === 'status' && m.ready === true;
  }, 10000, 'engine ready');
  check('one engine starts alone', function () {
    assert.strictEqual(workers.length, 1);
  });

  // The first long search has no helpers to use: they are spawned after it.
  var mark = log.length;
  send(port, {
    type: 'analyze', id: 1, fen: fen, multiPV: 1,
    movetime: 1000, skill: 20, rootMoves: roots
  });
  await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 1;
  }, 10000, 'bestmove 1');
  check('before any helper is up the search is not split', function () {
    var goes = goCommandsSince(mark);
    assert.strictEqual(goes.length, 1, 'only the primary should search');
    assert.strictEqual(hasSearchmoves(goes[0]), false,
      'nothing to divide, so the whole position goes to one engine');
  });

  var parallel = 1;
  for (var tryCount = 0; tryCount < 60; tryCount++) {
    var status = lastStatus(port);
    parallel = status && status.parallel ? status.parallel : 1;
    if (parallel >= 4) break;
    await delay(50);
  }
  check('the helpers load themselves after a long search', function () {
    assert.strictEqual(workers.length, 4, 'primary plus three helpers');
    assert.strictEqual(parallel, 4, 'and the status reports all of them up');
  });

  mark = log.length;
  send(port, {
    type: 'analyze', id: 2, fen: fen, multiPV: 1,
    movetime: 300, skill: 20, rootMoves: roots
  });
  var best2 = await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 2;
  }, 10000, 'bestmove 2');
  var splitGoes = goCommandsSince(mark);

  check('every legal move is searched exactly once', function () {
    assert.strictEqual(splitGoes.length, 4, 'four engines, four shares');
    var seen = [];
    splitGoes.forEach(function (entry) {
      var match = /searchmoves ((?:[a-h][1-8][a-h][1-8][qrbn]?)(?: [a-h][1-8][a-h][1-8][qrbn]?)*)/.exec(entry.command);
      assert.ok(match, 'each engine gets an explicit share');
      assert.ok(/movetime \d+ searchmoves /.test(entry.command),
        'the time limit comes before the move list, or UCI drops it');
      match[1].split(' ').forEach(function (uci) { seen.push(uci); });
    });
    assert.strictEqual(seen.length, roots.length);
    assert.strictEqual(new Set(seen).size, roots.length, 'no move is searched twice');
    assert.deepStrictEqual(seen.slice().sort(), roots.slice().sort(),
      'and no move is left out');
  });

  check('the best score across the engines decides the move', function () {
    // The scripted score grows with the worker id, so the last helper must win
    // even though it is not the primary.
    var winner = splitGoes.reduce(function (a, b) { return b.id > a.id ? b : a; });
    var match = /searchmoves ([^ ]+)/.exec(winner.command);
    assert.strictEqual(best2.uci, match[1], 'the highest score wins');
    var analysis = port.messages.filter(function (m) {
      return m.type === 'analysis' && m.id === 2;
    });
    assert.ok(analysis.length > 0);
    var last = analysis[analysis.length - 1].lines[0];
    assert.strictEqual(last.score.value, 1000 + winner.id,
      'the published evaluation belongs to the engine that won');
    assert.strictEqual(last.pv.length, 1);
    assert.strictEqual(last.pv[0], best2.uci, 'the winning move is the whole line');
  });

  mark = log.length;
  send(port, {
    type: 'analyze', id: 3, fen: fen, multiPV: 2,
    movetime: 300, skill: 20, rootMoves: roots
  });
  await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 3;
  }, 10000, 'bestmove 3');
  check('MultiPV is never split', function () {
    var goes = goCommandsSince(mark);
    assert.strictEqual(goes.length, 1);
    assert.strictEqual(hasSearchmoves(goes[0]), false);
  });

  mark = log.length;
  send(port, {
    type: 'analyze', id: 4, fen: fen, multiPV: 1,
    movetime: 300, skill: 12, rootMoves: roots
  });
  await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 4;
  }, 10000, 'bestmove 4');
  check('a humanized search is never split', function () {
    var goes = goCommandsSince(mark);
    assert.strictEqual(goes.length, 1);
    assert.strictEqual(hasSearchmoves(goes[0]), false);
  });

  mark = log.length;
  send(port, {
    type: 'analyze', id: 5, fen: fen, multiPV: 1,
    movetime: 300, skill: 20
  });
  await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 5;
  }, 10000, 'bestmove 5');
  check('without a move list the search is not split', function () {
    var goes = goCommandsSince(mark);
    assert.strictEqual(goes.length, 1);
    assert.strictEqual(hasSearchmoves(goes[0]), false);
  });

  mark = log.length;
  send(port, {
    type: 'analyze', id: 6, fen: fen, multiPV: 1,
    movetime: 5000, skill: 20, rootMoves: roots
  });
  await delay(60);
  send(port, { type: 'stop' });
  await waitFor(port, function (m) {
    return m.type === 'cancelled' && m.id === 6;
  }, 10000, 'cancelled 6');
  await delay(300);
  check('a stopped split publishes nothing and stops the helpers', function () {
    assert.strictEqual(port.messages.some(function (m) {
      return m.type === 'bestmove' && m.id === 6;
    }), false, 'no move for a stopped search');
    var stopped = log.slice(mark).filter(function (entry) {
      return entry.command === 'stop';
    }).map(function (entry) { return entry.id; });
    assert.strictEqual(new Set(stopped).size, 4, 'every engine is told to stop');
  });

  // The next search must not be poisoned by the stopped one: the helpers are
  // reused, and their old answers must not be credited to the new position.
  send(port, {
    type: 'analyze', id: 7, fen: fen, multiPV: 1,
    movetime: 300, skill: 20, rootMoves: roots
  });
  var best7 = await waitFor(port, function (m) {
    return m.type === 'bestmove' && m.id === 7;
  }, 10000, 'bestmove 7');
  check('the helpers are reused after a stop', function () {
    assert.ok(roots.indexOf(best7.uci) >= 0, 'got ' + best7.uci);
    assert.strictEqual(workers.length, 4, 'no extra engines were spawned');
  });

  console.log('');
  if (failures) {
    console.error(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('parallel tests passed');
  process.exit(0);
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
