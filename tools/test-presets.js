/*
 * Preset and clock-pacing tests.
 *
 *   popup/popup.js       bullet preset numbers, and that they survive LIMITS
 *   content/content.js   per-move clock budget, scramble stages
 *
 * The bullet preset is the one that has to hold two things at once: it must
 * win games (no piece hangs, no walking into mates) and it must not flag
 * (0.2-0.7 s per move, with a budget tied to the remaining clock).
 *
 * Usage: node tools/test-presets.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.resolve(__dirname, '..');
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

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function block(source, start, end) {
  var from = source.indexOf(start);
  assert.ok(from >= 0, start + ' must exist');
  var to = source.indexOf(end, from + start.length);
  assert.ok(to > from, end + ' must follow ' + start);
  return source.slice(from, to);
}

function num(text, key) {
  var match = text.match(new RegExp('\\b' + key + ':\\s*(-?\\d+(?:\\.\\d+)?)'));
  assert.ok(match, key + ' must be set explicitly');
  return Number(match[1]);
}

function bool(text, key) {
  var match = text.match(new RegExp('\\b' + key + ':\\s*(true|false)'));
  assert.ok(match, key + ' must be set explicitly');
  return match[1] === 'true';
}

function limit(source, key) {
  var match = source.match(new RegExp('\\b' + key + ':\\s*\\[(\\d+),\\s*(\\d+)\\]'));
  assert.ok(match, 'LIMITS.' + key + ' must exist');
  return [Number(match[1]), Number(match[2])];
}

var popupJs = read('popup/popup.js');
var popupHtml = read('popup/popup.html');
var content = read('content/content.js');
var background = read('background/background.js');
var overlay = read('content/overlay.js');
var styleCss = read('content/style.css');
var manifest = JSON.parse(read('manifest.json'));
var bullet = block(popupJs, 'bullet: {', 'blitz: {');

console.log('preset: bullet 1+0');

check('follows the account rating', function () {
  assert.strictEqual(bool(bullet, 'humanizeAdaptive'), true,
    'the account rating is the anchor: the games must look like that level');
  var target = block(content, 'function targetRating()', 'function currentStrength()');
  assert.ok(/if \(me\) return Math\.max\(400, Math\.min\(3500, me\)\)/.test(target),
    'the target must come from our own rating, not the opponent +100');
  assert.strictEqual(/them \+ 100/.test(target), false,
    'aiming above the opponent is what made the account look boosted');
});

check('strength is capped even for a low rating', function () {
  assert.ok(/mapped\.maxLoss = Math\.min\(mapped\.maxLoss, 200\)/.test(content));
  assert.ok(/mapped\.blunderPct = Math\.min\(mapped\.blunderPct, 5\)/.test(content));
  assert.ok(/if \(mapped\.depth > 0\) mapped\.depth = Math\.max\(mapped\.depth, 6\)/.test(content));
});

check('the rating table is built from review metrics', function () {
  var table = block(content, 'var PROFILE_TABLE = [', '];');
  var rows = (table.match(/\[\s*\d+,\s*\d+,\s*\d+,\s*\d+,\s*[\d.]+\s*\]/g) || [])
    .map(function (r) { return r.match(/[\d.]+/g).map(Number); });
  assert.strictEqual(rows.length, 12, '800..3000 in steps of 200');

  rows.forEach(function (row, i) {
    assert.strictEqual(row[0], 800 + i * 200);
    // Depth may only rise with rating: a 3000 profile that searches shallower
    // than a 1600 one cannot be real at any error rate.
    if (i) assert.ok(row[1] >= rows[i - 1][1],
      'depth must not fall at ' + row[0]);
    // So must accuracy: the loss budget can only shrink as the rating rises.
    if (i) assert.ok(row[3] <= rows[i - 1][3],
      'maxLoss must not grow at ' + row[0]);
    if (i) assert.ok(row[2] <= rows[i - 1][2],
      'errorPct must not grow at ' + row[0]);
  });

  // The point of the table: at the top the error rate flattens instead of
  // collapsing to zero. A 3000 still misses the top move ~half the time, it
  // just loses less when it does.
  var top = rows[rows.length - 1];
  assert.ok(top[2] >= 40, 'a 3000 profile is not "top move every time"');
  assert.ok(top[3] <= 70, 'and a mistake there has to be cheap');
  assert.ok(top[4] >= 0.5, 'zero blunders over hundreds of games is its own tell');
  assert.ok(top[4] <= 1.5, 'but not a blunder machine either');

  // The bottom must still be human, not a random mover.
  var bottom = rows[0];
  assert.ok(bottom[3] >= 250, 'an 800-level error may cost more than a knight');
  assert.ok(bottom[4] <= 10);

  assert.ok(content.indexOf('function strengthForRating') >= 0);
  assert.ok(/if \(n <= PROFILE_TABLE\[0\]\[0\]\)/.test(content));
  assert.strictEqual(/STRENGTH_TABLE/.test(content), false,
    'the old table is what gave 6 % blunders at 1800');
});

check('searches deep enough to see mates', function () {
  assert.ok(num(bullet, 'engineDepth') >= 6, 'depth cap must not be human-blind');
});

check('mistakes stay below a piece', function () {
  assert.ok(num(bullet, 'humanizeMaxLossCp') <= 240,
    'a 320 cp budget is a knight, which is exactly the loss that gets you mated');
  assert.ok(num(bullet, 'humanizeErrorPct') >= 35,
    'some inaccuracy has to remain, otherwise the game looks like an engine');
});

check('blunders exist, but are rare and cheap', function () {
  assert.strictEqual(num(bullet, 'humanizeBlunderPct'), 4);
  // The blunder tier can only pick a line whose loss is under the budget, and
  // mate-scored lines are dropped before the choice is made.
  assert.ok(/cp <= -8000\) continue;/.test(content));
});

check('no forecast work between moves', function () {
  assert.strictEqual(bool(bullet, 'showOpponent'), false,
    'polling a multi-second forecast steals the engine right before our move');
});

check('thinks fast enough for 1+0, with real variance', function () {
  assert.ok(num(bullet, 'humanizeMaxMs') <= 1200);
  assert.ok(num(bullet, 'humanizeRareMs') <= 2500);
  assert.ok(num(bullet, 'humanizeRareMs') > num(bullet, 'humanizeMaxMs'),
    'a hard position has to be allowed a longer think');
  assert.ok(num(bullet, 'humanizeFastPct') >= 40);
  assert.ok(num(bullet, 'movetimeMs') <= 500);
});

check('the UI limits allow every preset number', function () {
  var pairs = bullet.match(/[A-Za-z_]+:\s*-?\d+(?:\.\d+)?/g) || [];
  assert.ok(pairs.length > 10);
  pairs.forEach(function (pair) {
    var parts = pair.split(':');
    var key = parts[0].trim();
    var value = Number(parts[1]);
    var range = null;
    try { range = limit(popupJs, key); } catch (e) { return; }
    assert.ok(value >= range[0] && value <= range[1],
      key + '=' + value + ' is outside LIMITS ' + range.join('..'));
  });
});

check('the ten-minute preset keeps its own, slower timing', function () {
  var ten = block(popupJs, 'ten: {', 'max: {');
  assert.ok(num(ten, 'humanizeMaxMs') > num(bullet, 'humanizeMaxMs'));
  assert.ok(num(ten, 'engineDepth') <= 8);
});

check('blitz is the honest high-rating preset', function () {
  var blitz = block(popupJs, 'blitz: {', 'ten: {');
  assert.strictEqual(bool(blitz, 'humanizeAdaptive'), true,
    'blitz has to follow the account too, otherwise it is a fixed 2200 bot');
  assert.ok(num(blitz, 'humanizeMinMs') >= 300,
    'a 3+0 player actually thinks; a 0.15 s tap would look wrong');
  assert.ok(num(blitz, 'humanizeMaxMs') >= 2500);
  assert.ok(num(blitz, 'humanizeMaxMs') < 6000,
    'but not enough to flag on time');
  assert.ok(num(blitz, 'humanizeMaxLossCp') <= 200);
  assert.ok(num(blitz, 'movetimeMs') >= 500);
  assert.ok(popupHtml.indexOf('id="presetBlitz"') >= 0);
  assert.ok(popupJs.indexOf("applyPreset('blitz')") >= 0);
});

check('the master preset is a fixed master anchor, not the account', function () {
  var master = block(popupJs, 'master: {', '};');
  assert.strictEqual(num(master, 'humanizeRating'), 2700,
    'the premise is playing at master level on an unknown account');
  assert.strictEqual(bool(master, 'humanizeAdaptive'), true,
    'adaptive must still run, so the 2700 anchor is what it reads');
  assert.strictEqual(bool(master, 'humanize'), true);
  assert.strictEqual(bool(master, 'showOpponent'), false);
  assert.ok(num(master, 'humanizeMinMs') >= 250, 'a master does not tap in 0.15 s');
  assert.ok(num(master, 'humanizeMaxMs') <= 3000,
    'but a 1+0 game still cannot pay 4 s on every move');
  assert.ok(num(master, 'humanizeRareMs') > num(master, 'humanizeMaxMs'),
    'a hard position gets a longer look');
  assert.ok(popupHtml.indexOf('id="presetMaster"') >= 0);
  assert.ok(popupJs.indexOf("applyPreset('master')") >= 0);
});

check('mistakes cluster in time pressure instead of spreading evenly', function () {
  var pick = block(content, 'function chooseHumanLine()', 'var maxLoss = human');
  assert.ok(/clock\.mine <= 20000\) pressure = 0\.30/.test(pick));
  assert.ok(/clock\.mine <= 45000\) pressure = 0\.12/.test(pick));
  assert.ok(/pct = Math\.min\(95, Math\.round\(pct \* \(1 \+ pressure\)\)\)/.test(pick));
  assert.ok(/blunderPct \* \(1 \+ pressure \* 2\.2\)/.test(pick),
    'a scramble raises the blunder chance more than the ordinary error rate');
});

check('game-to-game form has a real spread', function () {
  assert.ok(/state\.humanForm = 0\.6 \+ Math\.random\(\) \* 1\.0/.test(content),
    'a fixed error rate every game is a machine signature');
});

check('maximum plays at full strength and spends the clock', function () {
  var max = block(popupJs, 'max: {', 'master: {');
  assert.strictEqual(bool(max, 'humanize'), false, 'no error model at all');
  assert.strictEqual(num(max, 'engineDepth'), 0, 'no depth cap');
  assert.strictEqual(num(max, 'engineSkill'), 20);
  assert.strictEqual(num(max, 'multiPV'), 1, 'extra lines are search time wasted');
  assert.strictEqual(bool(max, 'showOpponent'), false,
    'a forecast would keep the engine busy for seconds before our move');

  var req = block(content, 'function requestAnalysis()', 'state.engine.analyze');
  assert.ok(/!humanizing && !opponentTurn && !state\.rescue/.test(req));
  assert.ok(/clampInt\(Math\.round\(myClock \/ 60\), 300, 30000\)/.test(req),
    'a sixtieth of the clock per move is what makes it strong without flagging');
  assert.ok(/movetime = Math\.max\(movetime, fair\)/.test(req));
  // The slice is redistributed, not spent flat: easy moves bank time that the
  // sharp ones spend.
  assert.ok(/var factor = 0\.55 \+ 0\.9 \* complexity/.test(req),
    'a quiet position must not cost the same as a critical one');
  assert.ok(/Math\.round\(myClock \/ 35\)/.test(req),
    'one move can never take more than a thirty-fifth of the clock');
  // A forced move is played without a search at all.
  assert.ok(/var only = state\.settings\.enabled && !state\.gameOver/.test(req));
  assert.ok(/function onlyLegalUci\(\)/.test(content));
  assert.ok(/moves\.length !== 1\) return null/.test(content));
});

check('auto rematch sometimes takes a real break', function () {
  var rematch = block(content, 'function tickRematch()', 'function scheduleAutoMove()');
  assert.ok(/1100 \+ Math\.random\(\) \* 2400/.test(rematch), 'short pause stays');
  assert.ok(/6000 \+ Math\.random\(\) \* 25000/.test(rematch),
    'a long pause now and then keeps the session from looking like a loop');
});

/*
 * The caption parser is pure, so it runs here instead of being pattern-matched:
 * the whole point of the change is that a 3-minute dialog is pressed exactly
 * like a 1-minute one.
 */
check('auto rematch accepts every time control, not just 1+0', function () {
  var src = block(content, 'var REMATCH_LABEL', 'function rematchButton()');
  var token = new Function(src + '\nreturn rematchToken;')();
  function at(text) { return token(text.toLowerCase()); }

  assert.strictEqual(at('Новая 1 мин.'), '1+0');
  assert.strictEqual(at('Новая 3 мин.'), '3+0');
  assert.strictEqual(at('Новая партия 10 мин'), '10+0');
  assert.strictEqual(at('Новая игра 5 мин.'), '5+0');
  assert.strictEqual(at('Новая 3+2'), '3+2');
  assert.strictEqual(at('new 1 min'), '1+0');
  // A caption with no clock is not a rematch offer.
  assert.strictEqual(at('Новая партия'), null);
  assert.strictEqual(at('Новая игра'), null);
  assert.strictEqual(at('Сыграть'), null);
  // A wrapper that repeats the whole dialog text still resolves to an offer.
  assert.strictEqual(at('Новая 3 мин. Новая 1 мин.'), '3+0');
});

check('the control played last wins when the dialog offers several', function () {
  var finder = block(content, 'function rematchButton()', 'function rememberRematchControl(');
  // Preference is applied before the size tie-break, otherwise a small button
  // for a control the user never plays would still get pressed.
  assert.ok(/token === state\.settings\.rematchControl/.test(finder));
  assert.ok(/bestPreferred && !preferred/.test(finder));
  assert.ok(/rememberRematchControl\(found\.token\)/.test(content));
  assert.ok(/storage\.local\.set\(\{ rematchControl: token \}\)/.test(content));
  assert.ok(/rematchControl: ''/.test(content), 'the preference has a default');
});

console.log('clock: pacing and scrambles');
check('the per-move budget is a fraction of the clock', function () {
  assert.ok(/remainingMs \* share/.test(content));
  assert.ok(/remainingMs > 120000 \? 0\.05/.test(content));
  assert.ok(/0\.04/.test(content) && /0\.03/.test(content));
  // The old fixed 0.10-0.15 share plus a 700 ms floor flagged 1+0 games.
  assert.strictEqual(/Math\.max\(700,/.test(content), false);
});

check('scrambles tighten before the clock is empty', function () {
  assert.ok(/c\.mine <= 4000\) return 3/.test(content));
  assert.ok(/c\.mine <= 10000\) return 2/.test(content));
  assert.ok(/c\.mine <= 20000\) return 1/.test(content));
});

check('a similar interval does not add a fixed second', function () {
  assert.ok(/delay \* 0\.45/.test(content));
  assert.strictEqual(/delay \+= 350 \+ Math\.random\(\) \* 900/.test(content), false);
});

check('think time follows the position, not a fixed band', function () {
  var complexity = block(content, 'function positionComplexity()', 'function humanThinkDelay');
  assert.ok(/state\.game\.moves\(\)/.test(complexity), 'branching factor feeds it');
  assert.ok(/var gap = Math\.abs\(best - second\)/.test(complexity),
    'the gap between the top two moves feeds it');
  assert.ok(/legalCount === 1\) return 0/.test(complexity), 'a forced move is trivial');

  var think = block(content, 'function humanThinkDelay', 'if (state.settings.humanizeClockAware');
  assert.ok(/var complexity = positionComplexity\(\)/.test(think));
  // Easy positions keep their fast taps; hard ones lose most of them and
  // stretch the window, which is what breaks the metronome.
  assert.ok(/fastPct \* \(1 - 0\.6 \* complexity\)/.test(think));
  assert.ok(/min \*= 1 \+ 0\.5 \* complexity/.test(think));
  assert.ok(/max \*= 1 \+ 0\.9 \* complexity/.test(think));
  assert.ok(/Math\.pow\(Math\.random\(\), 1\.6 - 0\.7 \* complexity\)/.test(think));
});

check('the human floor is low enough for a bullet tap', function () {
  assert.ok(/clampInt\(state\.settings\.humanizeMinMs, 150, 120000\)/.test(content));
  assert.ok(/140 \+ Math\.random\(\)/.test(content));
});

/* ---------------------------------------------------------------- tablebase */

/*
 * The picker is real logic, not a constant, so it is executed here instead of
 * only pattern-matched. The slice covers tbPieceCount, tbKey and
 * pickTablebaseMove plus the rank table, which is all they depend on.
 */
function loadTablebase() {
  var from = content.indexOf('var TB_ENDPOINT');
  var to = content.indexOf('function tablebaseEligible');
  assert.ok(from > 0 && to > from, 'the tablebase section must exist');
  var src = content.slice(from, to);
  return new Function(src + '\nreturn { pieceCount: tbPieceCount, key: tbKey, pick: pickTablebaseMove };')();
}

check('the tablebase picker takes the fastest win and the longest defence', function () {
  var tb = loadTablebase();

  // 7 pieces or fewer is the whole applicability rule.
  assert.strictEqual(tb.pieceCount('8/8/8/8/8/8/5K2/6Qk w - - 0 1'), 3);
  assert.strictEqual(tb.pieceCount('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 32);
  assert.strictEqual(tb.pieceCount('4k3/8/8/8/8/8/8/4K2R w K - 0 1'), 3);
  // The halfmove clock and move number must not split the cache.
  assert.strictEqual(tb.key('8/8/8/8/8/8/5K2/6Qk w - - 0 1'),
    tb.key('8/8/8/8/8/8/5K2/6Qk w - - 17 42'));

  // Winning: every move is a loss for the opponent, take the smallest DTZ so
  // the fifty-move counter has no way to bite.
  var win = tb.pick({
    category: 'win',
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'loss', dtz: 12 },
      { uci: 'b1b2', san: 'Kb2', category: 'loss', dtz: 3 },
      { uci: 'c1c2', san: 'Kc2', category: 'draw', dtz: 0 },
      { uci: 'd1d2', san: 'Kd2', category: 'cursed win', dtz: -20 }
    ]
  });
  assert.strictEqual(win.uci, 'b1b2', 'shortest forced win, not just any win');

  // Lost: every move is a win for the opponent, so the only value left is
  // making them work for it for as long as possible.
  var lost = tb.pick({
    category: 'loss',
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'win', dtz: 4 },
      { uci: 'b1b2', san: 'Kb2', category: 'win', dtz: 19 },
      { uci: 'd1d2', san: 'Kd2', category: 'win', dtz: 9 }
    ]
  });
  assert.strictEqual(lost.uci, 'b1b2', 'delay the loss as long as possible');

  // A cursed win for the opponent is a draw in practice: the fifty-move rule
  // saves us. It therefore ranks above a clean win for them.
  var saved = tb.pick({
    category: 'loss',
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'win', dtz: 3 },
      { uci: 'b1b2', san: 'Kb2', category: 'cursed win', dtz: 60 }
    ]
  });
  assert.strictEqual(saved.uci, 'b1b2', 'the practical half-point beats certain loss');

  // A blessed loss for the opponent outranks a draw: it is a win that only
  // fails on the fifty-move rule, which is still the better practical result.
  var blessed = tb.pick({
    category: 'cursed win',
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'draw', dtz: 0 },
      { uci: 'b1b2', san: 'Kb2', category: 'blessed loss', dtz: 40 }
    ]
  });
  assert.strictEqual(blessed.uci, 'b1b2');

  assert.strictEqual(tb.pick({ moves: [] }), null, 'an empty answer is not a move');
  assert.strictEqual(tb.pick({ moves: [{ san: 'no uci' }] }), null);
});

check('the phase is read off the board, not guessed from the move number', function () {
  var src = content.slice(content.indexOf('function gamePhase()'),
    content.indexOf('function positionComplexity()'));
  assert.ok(src.length > 100, 'gamePhase must exist');
  var phaseOf = new Function('state', src + '\nreturn gamePhase();');

  function boardFromFen(fen) {
    var rows = fen.split(' ')[0].split('/');
    var out = [];
    for (var r = 0; r < 8; r++) {
      var row = [];
      for (var i = 0; i < rows[r].length; i++) {
        var ch = rows[r].charAt(i);
        if (ch >= '1' && ch <= '8') {
          for (var k = 0; k < Number(ch); k++) row.push(null);
        } else {
          row.push({ type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' });
        }
      }
      out.push(row);
    }
    return out;
  }

  function phase(fen) {
    return phaseOf({ fen: fen, game: { board: function () { return boardFromFen(fen); } } });
  }

  assert.strictEqual(phase('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').key, 'open');
  assert.strictEqual(phase('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 12').key, 'mid');
  // No queens and little material left: the endgame, by any definition.
  assert.strictEqual(phase('8/8/4k3/8/8/3PK3/8/8 w - - 0 40').key, 'tb');
  assert.strictEqual(phase('8/5pk1/5p2/8/8/2P3K1/5P2/1R4R1 w - - 0 40').key, 'end');
  // Seven pieces or fewer is the part with an exact answer.
  assert.strictEqual(phase('8/8/8/3kp3/P2p4/3P4/3K4/R7 w - - 0 30').key, 'tb');
  // A full board late in the game is still the middlegame, not the opening.
  assert.strictEqual(phase('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 25').key, 'mid');
});

check('the tablebase is wired end to end and not just a setting', function () {
  // Popup: its own switch, off in every humanized preset, on in Max only.
  assert.strictEqual(bool(popupJs, 'tablebase'), false, 'off by default');
  assert.ok(popupHtml.indexOf('id="tablebase"') >= 0);
  assert.ok(popupJs.indexOf("save({ tablebase:") >= 0);
  var max = block(popupJs, 'max: {', 'master: {');
  assert.strictEqual(bool(max, 'tablebase'), true, 'Max is the preset that uses it');
  var spans = {
    bullet: ['bullet: {', 'blitz: {'],
    blitz: ['blitz: {', 'ten: {'],
    ten: ['ten: {', 'max: {'],
    master: ['master: {', '};']
  };
  Object.keys(spans).forEach(function (name) {
    var preset = block(popupJs, spans[name][0], spans[name][1]);
    assert.strictEqual(bool(preset, 'tablebase'), false,
      name + ' is humanized and must not play perfect endgames');
  });

  // Manifest: the fetch is allowed from the background page on both platforms.
  assert.ok(manifest.permissions.indexOf('https://tablebase.lichess.ovh/*') >= 0);

  // Background: the request is made there, with a timeout and a cache.
  assert.ok(/message\.type === 'ca-tablebase'/.test(background));
  assert.ok(/tablebaseQuery\(message\.fen, sendResponse\)/.test(background));
  assert.ok(/var TB_TIMEOUT_MS = \d+/.test(background));
  assert.ok(/tbCache\[key\] = data/.test(background));

  // Content: gated by piece count, disarmed for humanized play, and the answer
  // outranks the search in onBestMove.
  assert.ok(/var TB_MAX_PIECES = 7/.test(content));
  assert.ok(/if \(state\.settings\.humanize\) return false/.test(content));
  assert.ok(/tbPieceCount\(state\.fen\) <= TB_MAX_PIECES/.test(content));
  assert.ok(/requestTablebase\(\);/.test(block(content, 'function requestAnalysis()', 'state.engine.analyze')),
    'the request has to start with the search, not after it');
  assert.ok(/var tbNow = tablebaseChoiceFor\(state\.fen\);/.test(content),
    'onBestMove must prefer the exact answer');
  assert.ok(/state\.tbPending && state\.tbPending\.fen === state\.fen/.test(content),
    'a move due in an endgame waits briefly for the answer');
});

check('the chip says when the tablebase is playing and what phase it is', function () {
  // A tablebase move replaces the evaluation on the chip: the exact result is
  // worth more than an approximation of the same position.
  assert.ok(/function tablebaseChip\(\)/.test(content));
  assert.ok(/var score = tb \|\| state\.scoreText/.test(overlay),
    'the chip must show TB in place of the eval');
  assert.ok(/state\.tablebaseTone/.test(overlay));
  // The phase has its own cell and survives in the tooltip.
  assert.ok(/refs\.phase = el\('span', 'ca-hud__phase'/.test(overlay));
  assert.ok(/setText\(refs\.phase, state\.phase \|\| ''\)/.test(overlay));
  assert.ok(/\.ca-hud__phase \{/.test(styleCss), 'the phase needs its own styling');
  assert.ok(/width: 214px/.test(styleCss), 'and room next to the move');
  assert.ok(/function phaseChip\(\)/.test(content));
  assert.ok(/phase: phaseChip\(\)/.test(content));
  assert.ok(/phase: \(function \(\)/.test(content), 'the popup gets the long name');
  // The last exact decision is kept past the move, because in bullet the chip
  // shows it for less than a second.
  assert.ok(/state\.tbLast = \{/.test(content));
  assert.ok(/tablebaseLast: state\.tbLast \? \{/.test(content));
  assert.ok(/status \+= ' · таблицы: ' \+ state\.tablebaseLast\.text/.test(popupJs));
});

check('the root is split between engines, and only where that is honest', function () {
  var client = read('content/engine-client.js');

  // Content: the board is the authority on which moves exist.
  assert.ok(/function rootMoveList\(\)/.test(content));
  assert.ok(/rootMoves: rootMoveList\(\)/.test(content));
  assert.ok(/rootMoves: opts\.rootMoves \|\| null/.test(client));

  // Background: the division, the merge, and the reasons not to divide.
  assert.ok(/function splitWidth\(\)/.test(background));
  assert.ok(/if \(IS_MOBILE\) return 1;/.test(background),
    'a phone runs one engine: several networks in one tab is how the page dies');
  assert.ok(/if \(request\.multiPV > 1\) return null;/.test(background),
    'MultiPV already spends the same time on alternatives');
  assert.ok(/if \(request\.skill < 20\) return null;/.test(background),
    'a humanized search must keep its own error model');
  assert.ok(/if \(request\.movetime < SPLIT_MIN_MOVETIME\) return null;/.test(background));
  assert.ok(/go \+= ' searchmoves ' \+ primary\.join\(' '\)/.test(background));
  // UCI swallows the token that ends the move list, so a limit written after
  // "searchmoves" is lost and the search never stops on time.
  assert.ok(/go \+= ' movetime ' \+ request\.movetime;/.test(background));
  assert.ok(/function pickSplitWinner\(/.test(background));
  assert.ok(/destroyHelpers\(\);/.test(background), 'helpers die with their build');
  assert.ok(/if \(current\) stopSplitHelpers\(current\);/.test(background),
    'a stop has to reach the helpers too');

  // What the user can see.
  assert.ok(/parallel: parallelWidth\(\)/.test(background));
  assert.ok(/status\.parallel > 1/.test(popupJs));
  assert.ok(/state\.engineThreads > 1/.test(overlay));

  // Executable: the division and the merge, on their own.
  var src = background.slice(
    background.indexOf('function splitMoves('),
    background.indexOf('function parseHelperInfo(')
  );
  assert.ok(src.indexOf('function pickSplitWinner(') > 0);
  var split = new Function(src +
    '\nreturn { splitMoves: splitMoves, pickSplitWinner: pickSplitWinner };')();

  assert.deepStrictEqual(split.splitMoves(['a', 'b', 'c', 'd', 'e'], 2),
    [['a', 'c', 'e'], ['b', 'd']], 'round robin, nobody gets all the captures');

  var flat = split.splitMoves(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3);
  assert.deepStrictEqual(flat[0].concat(flat[1], flat[2]).sort(),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'every move is searched exactly once');

  function pick(list) { return split.pickSplitWinner(list); }

  // A mate is not a centipawn count.
  assert.strictEqual(pick([
    { uci: 'a1a2', score: { type: 'mate', value: 1 }, index: 1 },
    { uci: 'b1b2', score: { type: 'cp', value: 900 }, index: 0 }
  ]).uci, 'a1a2', 'mate in one beats +9');
  assert.strictEqual(pick([
    { uci: 'a1a2', score: { type: 'mate', value: 1 }, index: 1 },
    { uci: 'b1b2', score: { type: 'mate', value: 7 }, index: 0 }
  ]).uci, 'a1a2', 'mate in one beats mate in seven');
  // Being mated in seven is better than in three.
  assert.strictEqual(pick([
    { uci: 'a1a2', score: { type: 'mate', value: -3 }, index: 0 },
    { uci: 'b1b2', score: { type: 'mate', value: -7 }, index: 1 }
  ]).uci, 'b1b2', 'the longer defence wins');

  // Equal scores are everywhere in drawn positions: the primary keeps the move
  // so the same position does not answer differently every time.
  assert.strictEqual(pick([
    { uci: 'a1a2', score: { type: 'cp', value: 0 }, index: 2 },
    { uci: 'b1b2', score: { type: 'cp', value: 0 }, index: 0 }
  ]).uci, 'b1b2');
  assert.strictEqual(pick([{ uci: '(none)', score: null, index: 0 }]), null);
  assert.strictEqual(pick([]), null);
});

/* ------------------------------------------------------------------- report */

console.log('');
if (failures) {
  console.error(failures + ' test(s) failed');
  process.exit(1);
}
console.log('preset tests passed');
