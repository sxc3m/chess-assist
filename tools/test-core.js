/*
 * Node tests for the pure chess logic.
 * Usage: node tools/test-core.js
 */
'use strict';

var assert = require('assert');
var core = require('../content/lib/core.js');
var chess = require('../content/vendor/chess.js.raw');
var Chess = chess.Chess;
// core.js uses the page global `Chess` for SAN conversion, just like the
// content script does in Firefox.
global.Chess = Chess;

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('FAIL  ' + name);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

function boardAfter(moves) {
  var game = new Chess();
  for (var i = 0; i < moves.length; i++) game.move(moves[i]);
  return core.boardFromFen(game.fen());
}

function moveBoard(board, fromName, toName, promoteTo) {
  var next = board.slice();
  var from = core.squareIndex(fromName);
  var to = core.squareIndex(toName);
  var piece = next[from];
  next[from] = null;
  next[to] = promoteTo || piece;
  return next;
}

console.log('core: board and FEN');

test('start position constants are consistent', function () {
  assert.strictEqual(core.boardToFenPlacement(core.boardFromFen(core.START_FEN)), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
  assert.strictEqual(core.boardFromFen(core.START_FEN).join(','), core.START_BOARD.join(','));
  assert.strictEqual(core.isStartBoard(core.START_BOARD), true);
  assert.strictEqual(core.countPieces(core.START_BOARD), 32);
});

test('buildFen emits a FEN that chess.js accepts', function () {
  var fen = core.buildFen(core.START_BOARD, 'w', { castling: 'KQkq', ep: '-' });
  assert.strictEqual(fen, core.START_FEN);
  var game = new Chess(fen);
  assert.strictEqual(game.moves().length, 20);
});

test('square names and indices round-trip', function () {
  for (var i = 0; i < 64; i++) {
    assert.strictEqual(core.squareIndex(core.squareName(i)), i);
  }
  assert.strictEqual(core.squareName(0), 'a1');
  assert.strictEqual(core.squareName(63), 'h8');
  assert.strictEqual(core.squareIndex('z9'), -1);
});

test('countDiff counts a capture as two changes', function () {
  var after = boardAfter(['e4', 'd5', 'exd5']);
  assert.strictEqual(core.countDiff(boardAfter(['e4', 'd5']), after), 2);
  assert.strictEqual(core.countDiff(after, after), 0);
});

console.log('core: move inference');

test('infers a quiet pawn move', function () {
  var move = core.inferMove(core.START_BOARD, boardAfter(['e4']));
  assert.ok(move);
  assert.strictEqual(move.from, core.squareIndex('e2'));
  assert.strictEqual(move.to, core.squareIndex('e4'));
  assert.strictEqual(move.piece, 'P');
  assert.strictEqual(move.captured, null);
  assert.strictEqual(move.color, 'w');
});

test('infers a capture', function () {
  var prev = boardAfter(['e4', 'd5']);
  var cur = boardAfter(['e4', 'd5', 'exd5']);
  var move = core.inferMove(prev, cur);
  assert.ok(move);
  assert.strictEqual(move.from, core.squareIndex('e4'));
  assert.strictEqual(move.to, core.squareIndex('d5'));
  assert.strictEqual(move.captured, 'p');
  assert.strictEqual(move.capturedSquare, core.squareIndex('d5'));
  assert.strictEqual(move.color, 'w');
});

test('infers castling with the rook move', function () {
  var prev = boardAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Be2', 'Nf6']);
  var cur = boardAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Be2', 'Nf6', 'O-O']);
  var move = core.inferMove(prev, cur);
  assert.ok(move);
  assert.strictEqual(move.from, core.squareIndex('e1'));
  assert.strictEqual(move.to, core.squareIndex('g1'));
  assert.ok(move.castle);
  assert.strictEqual(move.castle.rookFrom, core.squareIndex('h1'));
  assert.strictEqual(move.castle.rookTo, core.squareIndex('f1'));
  assert.strictEqual(move.color, 'w');
});

test('infers en passant', function () {
  var prev = boardAfter(['e4', 'Nf6', 'e5', 'd5']);
  var cur = boardAfter(['e4', 'Nf6', 'e5', 'd5', 'exd6']);
  var move = core.inferMove(prev, cur);
  assert.ok(move);
  assert.strictEqual(move.from, core.squareIndex('e5'));
  assert.strictEqual(move.to, core.squareIndex('d6'));
  assert.strictEqual(move.enPassant, true);
  assert.strictEqual(move.captured, 'p');
  assert.strictEqual(move.capturedSquare, core.squareIndex('d5'));
});

test('en passant is detected only for a double push with a neighbour pawn', function () {
  var afterPush = boardAfter(['e4', 'Nf6', 'e5', 'd5']);
  assert.strictEqual(core.enPassantFromMove(afterPush, {
    from: core.squareIndex('d7'),
    to: core.squareIndex('d5'),
    piece: 'p',
    color: 'b'
  }), 'd6');
  assert.strictEqual(core.enPassantFromMove(afterPush, {
    from: core.squareIndex('d7'),
    to: core.squareIndex('d6'),
    piece: 'p',
    color: 'b'
  }), null);
});

test('infers promotion from the destination piece', function () {
  var prev = core.boardFromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  var cur = prev.slice();
  cur[core.squareIndex('a7')] = null;
  cur[core.squareIndex('a8')] = 'Q';
  var move = core.inferMove(prev, cur);
  assert.ok(move);
  assert.strictEqual(move.promotion, 'Q');
  assert.strictEqual(move.to, core.squareIndex('a8'));
});

test('rejects an impossible board edit', function () {
  var cur = core.START_BOARD.slice();
  cur[core.squareIndex('e4')] = 'Q';
  assert.strictEqual(core.inferMove(core.START_BOARD, cur), null);
});

console.log('core: turn detection');

test('uses the start position and the moving colour', function () {
  var e4 = boardAfter(['e4']);
  assert.strictEqual(core.detectTurn(null, core.START_BOARD, { seedTurn: 'b' }), 'w');
  assert.strictEqual(core.detectTurn({ board: core.START_BOARD, turn: 'w' }, e4, {}), 'b');
  assert.strictEqual(core.detectTurn({ board: e4, turn: 'b' }, e4, {}), 'b');
});

test('falls back to clock, last move and seed hints', function () {
  var position = boardAfter(['e4', 'e5']);
  assert.strictEqual(core.detectTurn(null, position, { clockTurn: 'w' }), 'w');
  assert.strictEqual(core.detectTurn(null, position, { lastMoveColor: 'w' }), 'b');
  assert.strictEqual(core.detectTurn(null, position, { seedTurn: 'b' }), 'b');
  assert.strictEqual(core.detectTurn(null, position, {}), 'w');
});

test('an explicit move choice wins over clocks and board diffs', function () {
  var e4 = boardAfter(['e4']);
  assert.strictEqual(core.resolveTurn(null, core.START_BOARD, { seedTurn: 'b', clockTurn: 'b' }, 'w'), 'w');
  assert.strictEqual(core.resolveTurn({ board: core.START_BOARD, turn: 'w' }, e4,
    { clockTurn: 'b', lastMoveColor: 'w' }, 'w'), 'w');
  assert.strictEqual(core.resolveTurn({ board: core.START_BOARD, turn: 'w' }, e4,
    { clockTurn: 'b' }, null), 'b');
  assert.strictEqual(core.resolveTurn({ board: core.START_BOARD, turn: 'w' }, e4,
    { seedTurn: 'b' }, 'auto'), 'b');
});

console.log('core: castling bookkeeping');

test('infers all rights from the initial position', function () {
  var lost = core.newCastlingTracker();
  core.updateCastlingTracker(core.START_BOARD, lost);
  assert.strictEqual(core.castlingString(core.START_BOARD, lost), 'KQkq');
});

test('loses white rights when the king leaves home', function () {
  var lost = core.newCastlingTracker();
  var moved = moveBoard(core.START_BOARD, 'e1', 'e2');
  core.updateCastlingTracker(moved, lost);
  assert.strictEqual(core.castlingString(moved, lost), 'kq');
});

test('loses the king-side right when the h1 rook leaves', function () {
  var lost = core.newCastlingTracker();
  var rookMoved = moveBoard(core.START_BOARD, 'h1', 'h2');
  core.updateCastlingTracker(rookMoved, lost);
  assert.strictEqual(core.castlingString(rookMoved, lost), 'Qkq');
});

test('king-side only when the queen rook is gone', function () {
  var board = core.START_BOARD.slice();
  board[core.squareIndex('a1')] = null;
  var lost = core.newCastlingTracker();
  core.updateCastlingTracker(board, lost);
  assert.strictEqual(core.castlingString(board, lost), 'Kkq');
});

console.log('core: UCI and scores');

test('parses UCI moves including promotion', function () {
  assert.deepStrictEqual(core.uciToMove('e2e4'), { from: 12, to: 28, promotion: null });
  assert.deepStrictEqual(core.uciToMove('e7e8q'), { from: 52, to: 60, promotion: 'q' });
  assert.strictEqual(core.uciToMove('bad'), null);
  assert.strictEqual(core.uciToMove('e7e8x'), null);
});

test('parses info lines and ignores info strings', function () {
  var line = 'info depth 18 seldepth 24 multipv 2 score cp -34 nodes 1200 nps 500000 time 400 pv d2d4 d7d5 c2c4';
  var info = core.parseInfoLine(line);
  assert.ok(info);
  assert.strictEqual(info.depth, 18);
  assert.strictEqual(info.multipv, 2);
  assert.deepStrictEqual(info.score, { type: 'cp', value: -34 });
  assert.deepStrictEqual(info.pv, ['d2d4', 'd7d5', 'c2c4']);
  assert.strictEqual(core.parseInfoLine('info string Network replica 1'), null);
  assert.strictEqual(core.parseInfoLine('bestmove e2e4'), null);
});

test('parses bestmove and rejects none', function () {
  assert.strictEqual(core.parseBestMove('bestmove e2e4 ponder e7e5'), 'e2e4');
  assert.strictEqual(core.parseBestMove('bestmove (none)'), null);
  assert.strictEqual(core.parseBestMove('not a bestmove'), null);
});

test('formats scores from White perspective', function () {
  assert.strictEqual(core.formatScore({ type: 'cp', value: 120 }, 'w'), '+1.20');
  assert.strictEqual(core.formatScore({ type: 'cp', value: 120 }, 'b'), '\u22121.20');
  assert.strictEqual(core.formatScore({ type: 'cp', value: 0 }, 'w'), '0.00');
  assert.strictEqual(core.formatScore({ type: 'mate', value: 3 }, 'w'), '#+3');
  assert.strictEqual(core.formatScore({ type: 'mate', value: -2 }, 'b'), '#+2');
  assert.strictEqual(core.formatScore(null, 'w'), '');
});

test('formats scores from the chosen player perspective', function () {
  assert.strictEqual(core.formatScore({ type: 'cp', value: 120 }, 'w', 'b'), '\u22121.20');
  assert.strictEqual(core.formatScore({ type: 'cp', value: 120 }, 'w', 'w'), '+1.20');
  assert.strictEqual(core.formatScore({ type: 'cp', value: -50 }, 'b', 'b'), '\u22120.50');
  assert.strictEqual(core.formatScore({ type: 'mate', value: 2 }, 'w', 'b'), '#-2');
  assert.strictEqual(core.formatScore({ type: 'mate', value: -2 }, 'b', 'b'), '#-2');
});

test('converts PV to SAN', function () {
  assert.deepStrictEqual(core.sanLines(core.START_FEN, ['e2e4', 'e7e5', 'g1f3'], 10), ['e4', 'e5', 'Nf3']);
  assert.strictEqual(core.formatPv(core.START_FEN, ['e2e4', 'e7e5'], 2), '1. e4 e5');
});

console.log('core: geometry');

test('maps squares to points and back for both orientations', function () {
  var rect = { left: 100, top: 50, width: 400, height: 400 };
  for (var i = 0; i < 64; i++) {
    var point = core.squareCenter(i, rect, 'white');
    assert.strictEqual(core.pointToSquare(point.x, point.y, rect, 'white'), i);
    point = core.squareCenter(i, rect, 'black');
    assert.strictEqual(core.pointToSquare(point.x, point.y, rect, 'black'), i);
  }
  assert.strictEqual(core.pointToSquare(0, 0, rect, 'white'), -1);
});

test('material balance is zero at start', function () {
  assert.strictEqual(core.materialBalance(core.START_BOARD), 0);
  var board = core.START_BOARD.slice();
  board[core.squareIndex('d8')] = null;
  assert.strictEqual(core.materialBalance(board), 9);
});

console.log('');
console.log(passed + ' tests passed');
if (process.exitCode) {
  console.error('Some tests failed.');
}
