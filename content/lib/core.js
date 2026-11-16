/*
 * Chess Assist - pure logic (no DOM, no browser APIs).
 * Shared by the content script, the background engine host and the Node tests.
 *
 * Board representation: array of 64, index = rank * 8 + file, index 0 = a1.
 * Piece: 'P','N','B','R','Q','K' for white, lowercase for black, null for empty.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CA = root.CA || {};
  root.CA.core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FILES = 'abcdefgh';
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var START_BOARD = [
    'R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R',
    'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P',
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null,
    'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p',
    'r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'
  ];

  var PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function emptyBoard() {
    return new Array(64).fill(null);
  }

  function isWhitePiece(p) {
    return !!p && p === p.toUpperCase();
  }

  function colorOf(p) {
    return isWhitePiece(p) ? 'w' : 'b';
  }

  function otherColor(c) {
    return c === 'w' ? 'b' : 'w';
  }

  function fileOf(i) { return i & 7; }
  function rankOf(i) { return i >> 3; }
  function sqIndex(file, rank) { return rank * 8 + file; }
  function squareName(i) { return FILES[i & 7] + ((i >> 3) + 1); }

  function squareIndex(name) {
    if (typeof name !== 'string' || name.length < 2) return -1;
    var f = FILES.indexOf(name.charAt(0).toLowerCase());
    var r = parseInt(name.charAt(1), 10) - 1;
    if (f < 0 || r < 0 || r > 7) return -1;
    return r * 8 + f;
  }

  function boardFromFen(fen) {
    var rows = String(fen || '').split(/\s+/)[0].split('/');
    if (rows.length !== 8) return emptyBoard();
    var board = emptyBoard();
    for (var r = 0; r < 8; r++) {
      var rank = 7 - r;
      var file = 0;
      var row = rows[r];
      for (var i = 0; i < row.length; i++) {
        var ch = row.charAt(i);
        if (ch >= '1' && ch <= '8') {
          file += parseInt(ch, 10);
        } else {
          if (file < 8) board[rank * 8 + file] = ch;
          file++;
        }
      }
    }
    return board;
  }

  function boardToFenPlacement(board) {
    var rows = [];
    for (var rank = 7; rank >= 0; rank--) {
      var row = '';
      var empty = 0;
      for (var file = 0; file < 8; file++) {
        var p = board[rank * 8 + file];
        if (p) {
          if (empty) { row += empty; empty = 0; }
          row += p;
        } else {
          empty++;
        }
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  function sameBoard(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < 64; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function isStartBoard(board) {
    return sameBoard(board, START_BOARD);
  }

  function findKing(board, color) {
    var king = color === 'w' ? 'K' : 'k';
    for (var i = 0; i < 64; i++) if (board[i] === king) return i;
    return -1;
  }

  function countPieces(board) {
    var n = 0;
    for (var i = 0; i < 64; i++) if (board[i]) n++;
    return n;
  }

  function countDiff(a, b) {
    if (!a || !b) return 64;
    var n = 0;
    for (var i = 0; i < 64; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  function materialBalance(board) {
    var sum = 0;
    for (var i = 0; i < 64; i++) {
      var p = board[i];
      if (!p) continue;
      var v = PIECE_VALUES[p.toLowerCase()] || 0;
      sum += isWhitePiece(p) ? v : -v;
    }
    return sum;
  }

  function normalizeBoard(board) {
    if (!board || board.length !== 64) return null;
    var out = new Array(64);
    for (var i = 0; i < 64; i++) out[i] = board[i] || null;
    return out;
  }

  /*
   * Infer the move that turned `prev` into `cur`.
   * Returns null when the difference is not a single chess move.
   */
  function inferMove(prev, cur) {
    if (!prev || !cur || prev.length !== 64 || cur.length !== 64) return null;

    var vacated = [];
    var arrived = [];
    var i;

    for (i = 0; i < 64; i++) {
      if (prev[i] === cur[i]) continue;
      if (prev[i] && !cur[i]) {
        vacated.push(i);
      } else if (!prev[i] && cur[i]) {
        arrived.push(i);
      } else if (prev[i] && cur[i] && colorOf(prev[i]) !== colorOf(cur[i])) {
        // A capture: the destination square changed from an enemy piece to
        // the moving piece. It is handled as an arrival by makeMove().
        arrived.push(i);
      } else {
        // Two pieces of the same colour cannot replace each other.
        return null;
      }
    }

    if (vacated.length === 1 && arrived.length === 1) {
      return makeMove(prev, vacated[0], arrived[0], cur);
    }

    // Castling: king and rook both move.
    if (vacated.length === 2 && arrived.length === 2) {
      var kingFrom = -1;
      var rookFrom = -1;
      for (i = 0; i < vacated.length; i++) {
        var pv = prev[vacated[i]];
        if (!pv) continue;
        if (pv.toLowerCase() === 'k') kingFrom = vacated[i];
        else if (pv.toLowerCase() === 'r') rookFrom = vacated[i];
      }
      if (kingFrom >= 0 && rookFrom >= 0) {
        var kingTo = -1;
        for (i = 0; i < arrived.length; i++) {
          var a = arrived[i];
          if (rankOf(a) === rankOf(kingFrom) && Math.abs(fileOf(a) - fileOf(kingFrom)) === 2) kingTo = a;
        }
        if (kingTo >= 0) {
          var rookTo = arrived[0] === kingTo ? arrived[1] : arrived[0];
          if (prev[kingFrom] && prev[rookFrom] && colorOf(prev[kingFrom]) === colorOf(prev[rookFrom])) {
            return {
              from: kingFrom,
              to: kingTo,
              piece: prev[kingFrom],
              captured: null,
              capturedSquare: -1,
              promotion: null,
              color: colorOf(prev[kingFrom]),
              castle: { rookFrom: rookFrom, rookTo: rookTo }
            };
          }
        }
      }
    }

    // En passant: our pawn moved diagonally, the captured pawn vanished elsewhere.
    if (vacated.length === 2 && arrived.length === 1) {
      var to = arrived[0];
      var mover = -1;
      for (i = 0; i < vacated.length; i++) {
        var from = vacated[i];
        var p = prev[from];
        if (!p || p.toLowerCase() !== 'p') continue;
        if (Math.abs(fileOf(from) - fileOf(to)) === 1 && Math.abs(rankOf(from) - rankOf(to)) === 1) mover = from;
      }
      if (mover >= 0) {
        var capturedSq = rankOf(mover) * 8 + fileOf(to);
        if (prev[capturedSq] && prev[capturedSq].toLowerCase() === 'p' &&
            colorOf(prev[capturedSq]) !== colorOf(prev[mover]) && capturedSq !== to) {
          return {
            from: mover,
            to: to,
            piece: prev[mover],
            captured: prev[capturedSq],
            capturedSquare: capturedSq,
            promotion: null,
            color: colorOf(prev[mover]),
            enPassant: true
          };
        }
      }
    }

    return null;
  }

  function makeMove(prev, from, to, cur) {
    var piece = prev[from];
    if (!piece) return null;
    var captured = prev[to] || null;
    if (captured && colorOf(captured) === colorOf(piece)) return null; // impossible
    var promotion = null;
    if (piece.toLowerCase() === 'p') {
      var lastRank = piece === 'P' ? 7 : 0;
      if (rankOf(to) === lastRank) {
        // The promoted piece is visible on the destination square. Fall back
        // to a queen when the caller only has the previous board.
        var promoted = cur && cur[to] ? String(cur[to]).toLowerCase() : 'q';
        if (promoted.length !== 1 || 'qrbn'.indexOf(promoted) < 0) promoted = 'q';
        promotion = piece === 'P' ? promoted.toUpperCase() : promoted;
      }
    }
    return {
      from: from,
      to: to,
      piece: piece,
      captured: captured,
      capturedSquare: captured ? to : -1,
      promotion: promotion,
      color: colorOf(piece)
    };
  }

  /*
   * En passant target square if the last move was a double pawn push and an
   * enemy pawn can actually capture. Otherwise null.
   */
  function enPassantFromMove(board, move) {
    if (!move || !move.piece || move.piece.toLowerCase() !== 'p') return null;
    var fromRank = rankOf(move.from);
    var toRank = rankOf(move.to);
    if (Math.abs(fromRank - toRank) !== 2) return null;
    var epRank = (fromRank + toRank) / 2;
    var epIndex = epRank * 8 + fileOf(move.from);
    var enemyPawn = move.color === 'w' ? 'p' : 'P';
    var f = fileOf(move.to);
    // The capturing pawn must stand beside the pushed pawn on the
    // destination rank (e.g. white e2-e4 -> black pawn on d4/f4).
    if (f > 0 && board[toRank * 8 + f - 1] === enemyPawn) return squareName(epIndex);
    if (f < 7 && board[toRank * 8 + f + 1] === enemyPawn) return squareName(epIndex);
    return null;
  }

  /*
   * Castling rights are not present in the piece placement, so they are
   * inferred from king/rook positions and pruned once we have seen them move.
   * `lost` is a mutable tracker kept by the caller for the current game:
   *   { wK: false, wQ: false, bK: false, bQ: false }
   */
  function newCastlingTracker() {
    return { wK: false, wQ: false, bK: false, bQ: false };
  }

  function updateCastlingTracker(board, lost) {
    if (!lost) return lost;
    if (board[4] !== 'K') { lost.wK = true; lost.wQ = true; }
    if (board[7] !== 'R') lost.wK = true;
    if (board[0] !== 'R') lost.wQ = true;
    if (board[60] !== 'k') { lost.bK = true; lost.bQ = true; }
    if (board[63] !== 'r') lost.bK = true;
    if (board[56] !== 'r') lost.bQ = true;
    return lost;
  }

  function castlingString(board, lost) {
    var rights = '';
    lost = lost || {};
    if (!lost.wK && board[4] === 'K' && board[7] === 'R') rights += 'K';
    if (!lost.wQ && board[4] === 'K' && board[0] === 'R') rights += 'Q';
    if (!lost.bK && board[60] === 'k' && board[63] === 'r') rights += 'k';
    if (!lost.bQ && board[60] === 'k' && board[56] === 'r') rights += 'q';
    return rights || '-';
  }

  function buildFen(board, turn, opts) {
    opts = opts || {};
    var placement = boardToFenPlacement(board);
    var castling = opts.castling || '-';
    var ep = opts.ep || '-';
    var halfmove = typeof opts.halfmove === 'number' ? opts.halfmove : 0;
    var fullmove = typeof opts.fullmove === 'number' ? opts.fullmove : 1;
    return placement + ' ' + (turn === 'b' ? 'b' : 'w') + ' ' + castling + ' ' + ep + ' ' + halfmove + ' ' + fullmove;
  }

  /*
   * Whose turn is it?
   *   prevState: { board, turn } from the previous accepted read, or null
   *   hints: { clockTurn, lastMoveColor, seedTurn, startTurn }
   * Returns 'w' | 'b'.
   */
  function detectTurn(prevState, board, hints) {
    hints = hints || {};

    if (isStartBoard(board)) return 'w';

    if (prevState && prevState.board && sameBoard(prevState.board, board)) {
      if (prevState.turn) return prevState.turn;
      if (hints.clockTurn) return hints.clockTurn;
      if (hints.lastMoveColor) return otherColor(hints.lastMoveColor);
      return hints.seedTurn || 'w';
    }

    if (prevState && prevState.board) {
      var mv = inferMove(prevState.board, board);
      if (mv) return otherColor(mv.color);
    }

    if (hints.clockTurn) return hints.clockTurn;
    if (hints.lastMoveColor) return otherColor(hints.lastMoveColor);
    if (hints.seedTurn) return hints.seedTurn;
    return 'w';
  }

  /*
   * Same as detectTurn, but an explicit user choice always wins. A manual
   * "White to move" on a live position must not be replaced by a clock or a
   * last-move guess.
   */
  function resolveTurn(prevState, board, hints, forcedTurn) {
    if (forcedTurn === 'w' || forcedTurn === 'b') return forcedTurn;
    return detectTurn(prevState, board, hints);
  }

  function uciToMove(uci) {
    if (typeof uci !== 'string' || uci.length < 4) return null;
    var from = squareIndex(uci.slice(0, 2));
    var to = squareIndex(uci.slice(2, 4));
    if (from < 0 || to < 0) return null;
    var promo = uci.length > 4 ? uci.charAt(4).toLowerCase() : null;
    if (promo && 'qrbn'.indexOf(promo) < 0) return null;
    return { from: from, to: to, promotion: promo };
  }

  function moveToUci(from, to, promotion) {
    return squareName(from) + squareName(to) + (promotion || '');
  }

  function parseInfoLine(line) {
    if (typeof line !== 'string' || line.indexOf('info ') !== 0) return null;
    if (line.indexOf(' pv ') < 0 && line.indexOf(' score ') < 0) return null;
    var tokens = line.trim().split(/\s+/);
    var out = {
      depth: null,
      seldepth: null,
      multipv: 1,
      score: null,
      nodes: null,
      nps: null,
      time: null,
      pv: []
    };
    for (var i = 1; i < tokens.length; i++) {
      var t = tokens[i];
      if (t === 'depth') out.depth = parseInt(tokens[++i], 10);
      else if (t === 'seldepth') out.seldepth = parseInt(tokens[++i], 10);
      else if (t === 'multipv') out.multipv = parseInt(tokens[++i], 10) || 1;
      else if (t === 'nodes') out.nodes = parseInt(tokens[++i], 10);
      else if (t === 'nps') out.nps = parseInt(tokens[++i], 10);
      else if (t === 'time') out.time = parseInt(tokens[++i], 10);
      else if (t === 'score') {
        var kind = tokens[++i];
        var value = parseInt(tokens[++i], 10);
        if (kind === 'cp' || kind === 'mate') out.score = { type: kind, value: value };
      } else if (t === 'pv') {
        out.pv = tokens.slice(i + 1);
        i = tokens.length;
      }
    }
    if (!out.pv.length) return null;
    return out;
  }

  function parseBestMove(line) {
    if (typeof line !== 'string') return null;
    var m = /^bestmove\s+(\S+)/.exec(line.trim());
    if (!m) return null;
    if (m[1] === '(none)' || m[1] === '0000') return null;
    return m[1];
  }

  /* Score is from the side-to-move point of view; this flips it to White. */
  function scoreForWhite(score, turn) {
    if (!score) return null;
    var sign = turn === 'w' ? 1 : -1;
    return { type: score.type, value: score.value * sign };
  }

  /*
   * Score from the point of view of `perspective` ('w' by default, or 'b' for
   * a player who chose Black). Stockfish reports scores for the side to move.
   */
  function scoreForPerspective(score, turn, perspective) {
    var s = scoreForWhite(score, turn);
    if (!s) return null;
    if (perspective === 'b') return { type: s.type, value: -s.value };
    return s;
  }

  function formatScore(score, turn, perspective) {
    var s = scoreForPerspective(score, turn, perspective || 'w');
    if (!s) return '';
    if (s.type === 'mate') {
      if (s.value === 0) return '#';
      return '#' + (s.value > 0 ? '+' : '-') + Math.abs(s.value);
    }
    var pawns = s.value / 100;
    var sign = pawns > 0 ? '+' : pawns < 0 ? '\u2212' : '';
    return sign + Math.abs(pawns).toFixed(2);
  }

  function scoreToText(score, turn, perspective) {
    if (!score) return '';
    if (score.type === 'mate') {
      var s = scoreForPerspective(score, turn, perspective || 'w');
      var n = Math.abs(s.value);
      if (s.value > 0) return '\u041c\u0430\u0442 \u0432 ' + n;
      return '\u041c\u0430\u0442 \u0447\u0435\u0440\u0435\u0437 ' + n;
    }
    return formatScore(score, turn, perspective);
  }

  /*
   * Point <-> square mapping for a board element with a given orientation.
   * rect is a DOMRect-like object { left, top, width, height }.
   */
  function squareCenter(index, rect, orientation) {
    var f = fileOf(index);
    var r = rankOf(index);
    var col = orientation === 'white' ? f : 7 - f;
    var row = orientation === 'white' ? 7 - r : r;
    var cell = Math.min(rect.width, rect.height) / 8;
    return {
      x: rect.left + (col + 0.5) * cell,
      y: rect.top + (row + 0.5) * cell,
      cell: cell
    };
  }

  function pointToSquare(x, y, rect, orientation) {
    var cell = Math.min(rect.width, rect.height) / 8;
    var col = Math.floor((x - rect.left) / cell);
    var row = Math.floor((y - rect.top) / cell);
    if (col < 0 || col > 7 || row < 0 || row > 7) return -1;
    var f = orientation === 'white' ? col : 7 - col;
    var r = orientation === 'white' ? 7 - row : row;
    return r * 8 + f;
  }

  function sanLines(fen, pv, limit) {
    if (typeof Chess !== 'function' || !pv || !pv.length) return [];
    var out = [];
    var game;
    try {
      game = new Chess(fen);
    } catch (e) {
      return [];
    }
    var max = Math.min(pv.length, limit || pv.length);
    for (var i = 0; i < max; i++) {
      try {
        var move = game.move({
          from: pv[i].slice(0, 2),
          to: pv[i].slice(2, 4),
          promotion: pv[i].length > 4 ? pv[i].charAt(4) : undefined
        });
        if (!move) break;
        out.push(move.san);
      } catch (e) {
        break;
      }
    }
    return out;
  }

  function formatPv(fen, pv, limit) {
    var sans = sanLines(fen, pv, limit);
    if (!sans.length) return '';
    var tokens = String(fen).split(/\s+/);
    var turn = tokens[1] === 'b' ? 'b' : 'w';
    var fullmove = parseInt(tokens[5], 10) || 1;
    var parts = [];
    var number = fullmove;
    for (var i = 0; i < sans.length; i++) {
      if (turn === 'w') {
        parts.push(number + '. ' + sans[i]);
      } else {
        if (i === 0) parts.push(number + '... ' + sans[i]);
        else parts.push(sans[i]);
        number++;
      }
      turn = turn === 'w' ? 'b' : 'w';
    }
    return parts.join(' ');
  }

  return {
    FILES: FILES,
    START_FEN: START_FEN,
    START_BOARD: START_BOARD,
    clamp: clamp,
    emptyBoard: emptyBoard,
    isWhitePiece: isWhitePiece,
    colorOf: colorOf,
    otherColor: otherColor,
    fileOf: fileOf,
    rankOf: rankOf,
    sqIndex: sqIndex,
    squareName: squareName,
    squareIndex: squareIndex,
    boardFromFen: boardFromFen,
    boardToFenPlacement: boardToFenPlacement,
    sameBoard: sameBoard,
    isStartBoard: isStartBoard,
    findKing: findKing,
    countPieces: countPieces,
    countDiff: countDiff,
    materialBalance: materialBalance,
    normalizeBoard: normalizeBoard,
    inferMove: inferMove,
    enPassantFromMove: enPassantFromMove,
    newCastlingTracker: newCastlingTracker,
    updateCastlingTracker: updateCastlingTracker,
    castlingString: castlingString,
    buildFen: buildFen,
    detectTurn: detectTurn,
    resolveTurn: resolveTurn,
    uciToMove: uciToMove,
    moveToUci: moveToUci,
    parseInfoLine: parseInfoLine,
    parseBestMove: parseBestMove,
    scoreForWhite: scoreForWhite,
    scoreForPerspective: scoreForPerspective,
    formatScore: formatScore,
    scoreToText: scoreToText,
    squareCenter: squareCenter,
    pointToSquare: pointToSquare,
    sanLines: sanLines,
    formatPv: formatPv
  };
});
