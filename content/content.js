/*
 * Chess Assist controller. Reads the site board, keeps a FEN, asks the
 * background Stockfish worker for analysis and (optionally) plays the move.
 */
(function () {
  'use strict';

  if (window.top !== window) return;
  if (!globalThis.CA || !CA.core || !CA.sites) return;

  var core = CA.core;
  var api = globalThis.browser || globalThis.chrome;
  var ChessCtor = globalThis.Chess;

  /*
   * Phone detection. The board there is driven by touch, and the overlay has
   * to stay finger-sized. Desktop Firefox and Chrome take the mouse path, so
   * nothing changes for them.
   */
  var IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(
    (globalThis.navigator && navigator.userAgent) || ''
  );
  var TOUCH = IS_MOBILE || (function () {
    if (!navigator.maxTouchPoints) return false;
    try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  })();

  var DEFAULTS = {
    enabled: true,
    side: 'auto',            // 'auto' | 'w' | 'b'
    seedTurn: 'w',           // whose move it is when the extension first reads a position
    showOpponent: true,      // keep the best-move arrow while the opponent is thinking
    showArrow: true,
    showHud: true,
    hideOverlay: false,
    autoPlay: false,
    autoPlayDelayMs: 700,
    multiPV: 1,
    movetimeMs: 1200,
    // Search strength. engineDepth > 0 caps the search so the engine sees
    // tactics like a human of the target strength instead of a 3000+ engine.
    // engineSkill is Stockfish's own Skill Level (0 = weakest, 20 = full).
    engineSkill: 20,
    engineDepth: 0,
    // Humanization: deliberately imperfect move choice plus a human-like
    // randomized think time. The played move is picked from a wide MultiPV
    // set with an evaluation-loss budget, so the game matches the target
    // rating instead of the engine's full strength.
    humanize: false,
    humanizeErrorPct: 25,
    humanizeMaxLossCp: 45,
    humanizeBlunderPct: 0,
    // Adaptive strength: read both ratings from the site and scale the error
    // budget to the real opponent instead of a hard-coded Elo. A manual
    // humanizeRating > 0 overrides the site value.
    humanizeAdaptive: true,
    humanizeRating: 0,
    // Safety cushion: when the game is clearly lost, play the engine's top
    // move at full strength until the evaluation is back near equal.
    humanizeRescue: true,
    humanizeRescueCp: 250,
    humanizeRescueExitCp: 40,
    humanizeRescueMs: 900,
    humanizeMinMs: 5000,
    humanizeMaxMs: 25000,
    humanizeRareMs: 40000,
    humanizeRarePct: 8,
    humanizeFastPct: 15,
    humanizeFastMs: 3000,
    humanizeClockAware: true
  };

  var state = {
    settings: Object.assign({}, DEFAULTS),
    adapter: null,
    boardEl: null,
    orientation: 'white',
    myColor: null,
    myColorResolved: false,
    manualTurn: null,        // 'w' | 'b' forced by the user for manualBoard
    manualBoard: null,
    overlay: null,
    engine: null,
    autoMover: null,
    prev: null,
    turn: 'w',
    turnSource: null,        // 'manual' | 'infer' | 'clock' | 'lastMove' | 'seed' | 'start'
    fen: null,
    game: null,
    gameOver: false,
    castling: core.newCastlingTracker(),
    ep: null,
    lines: [],
    bestUci: null,
    bestMove: null,
    bestSan: '',
    scoreText: '',
    depth: null,
    thinking: false,
    thinkStart: null,        // Date.now() of the running search, null when idle
    thinkMs: null,           // duration of the last finished search, for the HUD
    engineReady: false,
    engineError: null,
    engineLabel: 'Stockfish 19',
    error: null,
    clockTurn: null,
    clockDisagreement: 0,
    clocks: { w: null, b: null }, // remaining time in ms from the site clocks
    clockAt: 0,
    turnStartedAt: 0,
    humanChoice: null,        // { fen, uci, firstSan, lossCp } chosen once per position
    humanTargetFen: null,
    humanTargetAt: 0,
    humanLastDelay: 0,
    humanForm: 1,             // per-game form factor around the preset strength
    ratings: { w: null, b: null }, // live site ratings for both colours
    rescue: false,            // safety cushion currently on
    rescueStreak: 0,          // consecutive lost positions seen
    rescueMoves: 0,           // our moves played while rescuing
    rescueCount: 0,           // activations this game
    rescueFen: null,          // position already counted for the cushion
    carefulMoves: 0,          // moves left of the post-rescue calm period
    siteColor: null,         // colour reported by the site's own game object
    bridge: {                // chess.com page-bridge snapshot cache
      state: null,
      at: 0,
      pending: false,
      error: null
    },
    lastRequestedFen: null,
    lastAutoFen: null,
    lastAutoKey: null,
    autoTimer: null,
    autoKey: null,
    autoBusy: false,
    autoStatus: '',
    badReads: 0,
    pendingBoard: null,
    pendingSince: 0,
    wasEnabled: true,
    engineWasReady: false
  };

  function clampInt(value, lo, hi) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) n = lo;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ---------------------------------------------------------- humanization */

  function clockValueOk(ms) {
    return typeof ms === 'number' && isFinite(ms) && ms >= 0 && ms <= 24 * 3600 * 1000;
  }

  /*
   * Read both clocks from the site DOM. Adapters return milliseconds; the
   * running side is known from the site's active-clock marker.
   */
  function updateSiteClocks() {
    if (!state.adapter || typeof state.adapter.readClocks !== 'function') return;
    // Use the cached orientation only after the first successful board read;
    // before that the adapter locates the board itself.
    var orientation = state.prev ? state.orientation : null;
    var clocks = null;
    try { clocks = state.adapter.readClocks(orientation); } catch (e) { clocks = null; }
    if (!clocks) return;
    var changed = false;
    if (clockValueOk(clocks.w) && clocks.w !== state.clocks.w) {
      state.clocks.w = clocks.w;
      changed = true;
    }
    if (clockValueOk(clocks.b) && clocks.b !== state.clocks.b) {
      state.clocks.b = clocks.b;
      changed = true;
    }
    if (clocks.turn === 'w' || clocks.turn === 'b') state.clockTurn = clocks.turn;
    if (changed) state.clockAt = Date.now();
  }

  function clockRemaining(color) {
    if (color !== 'w' && color !== 'b') return null;
    var ms = state.clocks[color];
    if (!clockValueOk(ms)) return null;
    // If either the running-clock marker or our own turn says this clock is
    // ticking, subtract the time since the last DOM read. Being conservative
    // here protects against an active-clock marker the site did not render.
    if (state.clockTurn === color || state.turn === color) {
      var elapsed = Date.now() - (state.clockAt || 0);
      if (elapsed > 0) ms -= elapsed;
    }
    return Math.max(0, ms);
  }

  function clockState() {
    if (!state.myColor) return { mine: null, theirs: null, lead: null };
    var mine = clockRemaining(state.myColor);
    var theirs = clockRemaining(core.otherColor(state.myColor));
    return {
      mine: mine,
      theirs: theirs,
      lead: mine != null && theirs != null ? mine - theirs : null
    };
  }

  /*
   * 0 = normal, 1 = keep it short, 2 = move almost instantly, 3 = flag panic.
   * Absolute thresholds always apply. The relative part only applies with the
   * clock-aware setting and below one minute, so a 10-minute game still gets
   * normal human timing at the start.
   */
  function clockStage() {
    var c = clockState();
    if (c.mine == null) return 0;
    if (c.mine <= 3000) return 3;
    if (c.mine <= 8000) return 2;
    if (c.mine <= 15000) return 1;
    if (state.settings.humanizeClockAware && c.mine <= 60000 && c.lead != null) {
      if (c.lead <= -5000) return 2;
      if (c.lead <= 0) return 1;
      if (c.lead < 4000) return 1;
    }
    return 0;
  }

  function remainingForMe() {
    if (!state.settings.humanizeClockAware) return null;
    return clockRemaining(state.myColor);
  }

  function resetHumanState() {
    state.humanChoice = null;
    state.humanTargetFen = null;
    state.humanTargetAt = 0;
    state.turnStartedAt = 0;
  }

  /*
   * Humans do not hit the same accuracy every game. A per-game form factor
   * spreads error and blunder rates around the preset, so a series of games
   * looks like one person's good and bad days instead of a constant machine.
   */
  function newHumanForm() {
    state.humanForm = 0.8 + Math.random() * 0.45;
    state.humanLastDelay = 0;
    // A new game starts with a fresh cushion budget.
    state.rescue = false;
    state.rescueStreak = 0;
    state.rescueMoves = 0;
    state.rescueCount = 0;
    state.rescueFen = null;
    state.carefulMoves = 0;
  }

  function humanFormFactor() {
    return state.humanForm > 0 ? state.humanForm : 1;
  }

  function fullmoveNumber() {
    if (!state.fen) return 1;
    var parts = state.fen.split(/\s+/);
    var n = parseInt(parts[5], 10);
    return isFinite(n) ? Math.max(1, n) : 1;
  }

  /*
   * Rating -> play-style table. Columns: chess.com-equivalent Elo, search
   * depth cap, chance of a non-top move, centipawn loss budget, blunder
   * chance. The numbers are calibrated so a full game review lands in the
   * accuracy / ACPL / blunder ranges those ratings actually produce, not just
   * "roughly weaker".
   */
  var STRENGTH_TABLE = [
    [ 800,  2, 80, 420, 11],
    [1000,  2, 76, 400, 10],
    [1200,  3, 72, 380,  9],
    [1400,  3, 68, 350,  8],
    [1600,  4, 64, 320, 6.5],
    [1750,  5, 60, 300,  6],
    [1900,  6, 55, 250, 4.5],
    [2050,  8, 47, 190, 3.5],
    [2200, 10, 38, 140, 2.5],
    [2400, 12, 28,  90, 1.5],
    [2600, 14, 18,  50, 0.6],
    [2800, 20, 10,  30,   0]
  ];

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function strengthForRating(elo) {
    var n = Number(elo);
    if (!isFinite(n) || n <= 0) return null;
    if (n <= STRENGTH_TABLE[0][0]) {
      var first = STRENGTH_TABLE[0];
      return { depth: first[1], errorPct: first[2], maxLoss: first[3], blunderPct: first[4] };
    }
    for (var i = 1; i < STRENGTH_TABLE.length; i++) {
      var a = STRENGTH_TABLE[i - 1];
      var b = STRENGTH_TABLE[i];
      if (n > b[0]) continue;
      var t = (n - a[0]) / (b[0] - a[0]);
      var depth = Math.round(lerp(a[1], b[1], t));
      return {
        depth: depth >= 16 ? 0 : Math.max(1, depth),
        errorPct: Math.round(lerp(a[2], b[2], t)),
        maxLoss: Math.round(lerp(a[3], b[3], t)),
        blunderPct: Math.round(lerp(a[4], b[4], t) * 10) / 10
      };
    }
    var last = STRENGTH_TABLE[STRENGTH_TABLE.length - 1];
    return { depth: 0, errorPct: last[2], maxLoss: last[3], blunderPct: last[4] };
  }

  /*
   * The rating the game should look like. Prefer the player's own rating,
   * fall back to the opponent's, and aim slightly above the opponent so the
   * game is winnable while the numbers still fit the account's rating band.
   * A manual humanizeRating overrides everything.
   */
  function targetRating() {
    var manual = clampInt(state.settings.humanizeRating, 0, 3500);
    if (manual > 0) return manual;
    var r = state.ratings || {};
    var me = state.myColor === 'b' ? r.b : r.w;
    var them = state.myColor === 'b' ? r.w : r.b;
    if (!me && !them) return 0;
    if (!me) return them + 100;
    var target = me;
    if (them) target = Math.max(target, them + 100);
    // Never stray outside the plausible band of this account: at most ~120
    // above its rating, at most 40 below.
    return Math.max(me - 40, Math.min(me + 120, target));
  }

  /*
   * Lichess ratings run roughly 200 points above chess.com at the same
   * playing strength, so normalise before looking up the table.
   */
  function currentStrength() {
    var base = {
      depth: clampInt(state.settings.engineDepth, 0, 40),
      errorPct: clampInt(state.settings.humanizeErrorPct, 0, 100),
      maxLoss: clampInt(state.settings.humanizeMaxLossCp, 20, 500),
      blunderPct: clampInt(state.settings.humanizeBlunderPct, 0, 40)
    };
    if (!state.settings.humanize || !state.settings.humanizeAdaptive) return base;
    var elo = targetRating();
    if (!elo) return base;
    var site = state.adapter ? state.adapter.id : null;
    var chesscomElo = site === 'lichess' ? elo - 200 : elo;
    var mapped = strengthForRating(chesscomElo);
    if (!mapped) return base;
    return mapped;
  }

  /* ---------------------------------------------------------- safety cushion */

  function rescueEnabled() {
    return !!state.settings.humanize && !!state.settings.humanizeRescue;
  }

  function rescueEnterCp() {
    return clampInt(state.settings.humanizeRescueCp, 100, 1500);
  }

  function rescueExitCp() {
    var exit = clampInt(state.settings.humanizeRescueExitCp, 0, 500);
    // Hysteresis is mandatory: the release point must stay above the trigger.
    return Math.min(exit, Math.max(0, rescueEnterCp() - 25));
  }

  /*
   * Material the cushion uses as a second trigger, because a shallow search
   * can underestimate a lost position. Positive = pawns down.
   */
  function materialDeficit() {
    var board = state.prev && state.prev.board;
    if (!board || !state.myColor) return 0;
    var balance = core.materialBalance(board);
    var mine = state.myColor === 'w' ? balance : -balance;
    return Math.max(0, -mine);
  }

  function rescueSearchMs() {
    return clampInt(state.settings.humanizeRescueMs, 300, 5000);
  }

  /*
   * Safety cushion. A losing position does not make a human keep blundering:
   * they buckle down and play their best. Once the engine confirms the game is
   * going away, the error model is switched off, the depth cap is lifted, the
   * search gets real time and the top move is played until the evaluation is
   * back near equal. Then the human model resumes, but carefully for a few
   * moves instead of instantly blundering again.
   *
   * Smart rather than loud: two confirmations for a normal trigger, an
   * immediate arm only when it is objectively gone (a rook down or -4+), at
   * most four activations per game, and the release point sits well above the
   * trigger. It only reacts to our own moves.
   */
  function noteRescuePosition(cp) {
    if (!state.fen || state.rescueFen === state.fen) return false;
    state.rescueFen = state.fen;

    if (!state.rescue && state.carefulMoves > 0) state.carefulMoves--;

    if (!rescueEnabled()) {
      if (state.rescue) {
        state.rescue = false;
        state.humanChoice = null;
        return true;
      }
      return false;
    }

    if (!state.rescue) {
      var materialLost = materialDeficit();
      var enter = rescueEnterCp();
      var isLost = cp != null && cp <= -enter;
      // Down a real piece with a losing eval counts even if the shallow search
      // has not caught up yet.
      if (!isLost && materialLost >= Math.max(2, Math.round(enter / 100)) &&
          cp != null && cp <= -80) {
        isLost = true;
      }
      // Urgent: clearly gone already, no second confirmation needed.
      var urgent = (cp != null && cp <= -(enter + 150)) || materialLost >= 4;
      if (isLost && state.rescueCount < 4) {
        state.rescueStreak += urgent ? 2 : 1;
        if (state.rescueStreak >= 2) {
          state.rescue = true;
          state.rescueStreak = 0;
          state.rescueMoves = 0;
          state.rescueCount++;
          state.carefulMoves = 0;
          state.humanChoice = null;
          return true;
        }
      } else {
        state.rescueStreak = 0;
      }
      return false;
    }

    state.rescueMoves++;
    if (cp != null && cp >= -rescueExitCp() && state.rescueMoves >= 2) {
      state.rescue = false;
      // Do not fall straight back into the full error model: a human who just
      // survived a bad position keeps playing carefully for a while.
      state.carefulMoves = 8;
      state.humanChoice = null;
      return true;
    }
    return false;
  }

  /*
   * A human does not spend a fixed share of the clock. Most moves take a
   * random time from [min, max], some are quick "obvious" moves and a few are
   * long thinks. The choice is nudged by the position: a forced move or a
   * capture is faster, a quiet sharp position takes longer.
   */
  function humanThinkDelay(remainingMs) {
    var min = clampInt(state.settings.humanizeMinMs, 400, 120000);
    var max = clampInt(state.settings.humanizeMaxMs, Math.max(500, min), 180000);
    var rare = clampInt(state.settings.humanizeRareMs, Math.max(1000, max), 240000);
    var rarePct = clampInt(state.settings.humanizeRarePct * humanFormFactor(), 0, 60);
    var fastPct = clampInt(state.settings.humanizeFastPct, 0, 70);
    var fastMax = clampInt(state.settings.humanizeFastMs, 400, 15000);

    var delay;
    if (fastPct > 0 && Math.random() * 100 < fastPct) {
      // An obvious recapture or a known line: a human barely stops to think.
      delay = 350 + Math.random() * Math.max(0, fastMax - 350);
    } else {
      // Skew towards the lower half: short thinks are common, long ones rare.
      var t = Math.pow(Math.random(), 1.6);
      delay = min + (max - min) * t;
      if (rarePct > 0 && Math.random() * 100 < rarePct) {
        delay = max + Math.random() * Math.max(0, rare - max);
      }
    }

    var onlyMove = false;
    try {
      if (state.game && typeof state.game.moves === 'function') {
        var legal = state.game.moves();
        onlyMove = !!(legal && legal.length === 1);
      }
    } catch (e) { onlyMove = false; }
    var forcing = !!state.bestSan &&
      (state.bestSan.indexOf('x') >= 0 || /[+#]$/.test(state.bestSan));
    var gap = null;
    if (state.lines && state.lines.length > 1) {
      var best = lineScoreCp(state.lines[0]);
      var second = lineScoreCp(state.lines[1]);
      if (best != null && second != null) gap = best - second;
    }

    if (onlyMove) {
      // There is nothing to calculate; a human still takes a short beat.
      delay = Math.min(delay, 1400 + Math.random() * 1100);
    } else if (forcing) {
      delay *= 0.8;
    } else if (gap != null && gap >= 150) {
      delay *= 0.75;
    } else if (gap != null && gap < 40) {
      delay *= 1.15;
    }

    // Continuous jitter means two moves never get exactly the same delay.
    delay *= 0.9 + Math.random() * 0.2;
    if (state.humanLastDelay > 0 && Math.abs(delay - state.humanLastDelay) < 350) {
      delay += 350 + Math.random() * 900;
    }
    delay = Math.max(350, delay);

    if (state.settings.humanizeClockAware && remainingMs != null) {
      var reserve = Math.max(1500, Math.min(8000, remainingMs * 0.06));
      var usable = Math.max(500, remainingMs - reserve);
      var share = remainingMs > 60000 ? 0.15 : (remainingMs > 20000 ? 0.10 : 0.06);
      var cap = Math.max(700, Math.min(usable, remainingMs * share));
      if (remainingMs <= 4000) cap = Math.max(250, remainingMs * 0.12);
      delay = Math.min(delay, cap);
    }

    // Time safety comes first: under pressure the move must be sent now, even
    // if the user turned the clock-aware timing off.
    var stage = clockStage();
    if (stage >= 3) delay = Math.min(delay, 80);
    else if (stage === 2) delay = Math.min(delay, 200);
    else if (stage === 1 && remainingMs != null) delay = Math.min(delay, 500);
    state.humanLastDelay = delay;
    return Math.round(delay);
  }

  /*
   * Absolute time by which the move must be sent. Keeps a reserve for the
   * move itself (bridge call + board update) and for network/lag spikes.
   */
  function humanSafeAt(remainingMs) {
    if (!state.settings.humanizeClockAware || remainingMs == null) return Infinity;
    var reserve = Math.max(1200, Math.min(5000, remainingMs * 0.07));
    return Date.now() + Math.max(0, remainingMs - reserve - 900);
  }

  function lineScoreCp(line) {
    var score = line && line.score;
    if (!score) return null;
    if (score.type === 'cp') return score.value;
    if (score.type === 'mate') {
      if (!score.value) return 0;
      return score.value > 0
        ? 10000 - Math.min(999, score.value)
        : -10000 + Math.min(999, Math.abs(score.value));
    }
    return null;
  }

  /*
   * Pick the move to play from the analysed lines. With humanize on the top
   * line is only the most likely choice: the rest of the probability mass goes
   * to lines whose centipawn loss fits a realistic error budget. That yields
   * the accuracy, mistake and blunder rates of a human at the target rating
   * instead of a near-perfect engine.
   *
   * The candidate set is produced by a deliberately shallow search (see
   * requestAnalysis), so even the "best" line is a human-level move.
   */
  function chooseHumanLine() {
    var lines = state.lines || [];
    if (!lines.length) return null;
    var top = lines[0];
    var human = !!state.settings.humanize;
    var strength = currentStrength();

    var pct = human
      ? clampInt(strength.errorPct * humanFormFactor(), 0, 95)
      : 0;
    var blunderPct = human
      ? clampInt(strength.blunderPct * humanFormFactor(), 0, 40)
      : 0;

    // Post-rescue calm: after the cushion let go, a human keeps playing
    // carefully for a few moves instead of immediately returning to the full
    // error rate. This is what stops the same losing sequence repeating.
    if (human && state.carefulMoves > 0) {
      pct = Math.round(pct * 0.55);
      blunderPct *= 0.35;
    }

    // Try-hard mode: a human concentrates when the game is going badly and
    // stops taking risks when it is winning. Graduated, so a slightly worse
    // position already gets a calmer error rate instead of waiting for the
    // cushion to fire at -2.5.
    var topEvalCp = lineScoreCp(top);
    var deficit = materialDeficit();
    if (topEvalCp != null && topEvalCp <= -150 && deficit >= 2) {
      // Down material and already worse: a real player stops gambling here.
      // They still play imperfect moves, but they stop hanging more pieces.
      pct = Math.round(pct * 0.6);
      blunderPct = 0;
    } else if (topEvalCp != null && topEvalCp <= -250) {
      pct = Math.round(pct * 0.7);
      blunderPct *= 0.5;
    } else if (topEvalCp != null && topEvalCp <= -100) {
      pct = Math.round(pct * 0.85);
      blunderPct *= 0.7;
    } else if (topEvalCp != null && topEvalCp > 250) {
      blunderPct *= 0.25;
      pct = Math.round(pct * 0.9);
    }

    if (!human || !pct || lines.length < 2 || Math.random() * 100 >= pct) {
      return { line: top, loss: 0, alternative: false };
    }

    var topCp = topEvalCp;
    if (topCp == null || topCp >= 8000) {
      return { line: top, loss: 0, alternative: false };
    }

    var maxLoss = human
      ? clampInt(strength.maxLoss, 20, 500)
      : 45;
    // A human does not start blundering on move two: keep the opening sane.
    var opening = fullmoveNumber() <= 6;
    if (opening) maxLoss = Math.min(maxLoss, 70);
    // Converting a won position: humans tighten up and do not hand back a
    // winning advantage with a three-pawn error.
    if (topCp >= 500) maxLoss = Math.min(maxLoss, 90);
    else if (topCp >= 250) maxLoss = Math.min(maxLoss, 140);

    var pool = [];
    var blunders = [];
    // Damage cap for the blunder tier. The *frequency* of mistakes stays at the
    // rating's human level (so accuracy, ACPL and blunder% still look human),
    // but the *cost* is capped relative to the position: an ordinary club player
    // does not repeatedly hang a full piece from a level position. This is the
    // difference between "made a mistake" and "lost the game on move 18".
    var blunderCap = maxLoss;
    if (topCp >= -100) {
      blunderCap = Math.min(blunderCap, Math.max(160, Math.round(maxLoss * 0.6)));
    } else if (topCp >= -250) {
      blunderCap = Math.min(blunderCap, Math.max(140, Math.round(maxLoss * 0.5)));
    }
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.uci) continue;
      var cp = lineScoreCp(line);
      if (cp == null) continue;
      var loss = topCp - cp;
      if (loss < 0) loss = 0;
      if (loss > maxLoss) continue;
      if (cp <= -8000) continue;                 // never walk into mate
      if (topCp >= 600 && cp <= -200) continue;  // do not throw a won game
      var candidate = { line: line, loss: loss };
      pool.push(candidate);
      if (loss >= 120 && loss <= blunderCap) blunders.push(candidate);
    }
    if (!pool.length) {
      return { line: top, loss: 0, alternative: false };
    }

    // Blunder tier: the "I simply missed it" move. Rare, picked from the
    // strongest errors already in the candidate set, never in the opening, and
    // weighted towards the cheaper end of that range so the damage stays
    // recoverable.
    if (!opening && blunderPct > 0 && blunders.length &&
        Math.random() * 100 < blunderPct) {
      var bTotal = 0;
      for (var b = 0; b < blunders.length; b++) {
        blunders[b].weight = Math.exp(-(blunders[b].loss - 120) / 90);
        bTotal += blunders[b].weight;
      }
      var bRoll = Math.random() * bTotal;
      var bPick = blunders[blunders.length - 1];
      for (var b2 = 0; b2 < blunders.length; b2++) {
        bRoll -= blunders[b2].weight;
        if (bRoll <= 0) { bPick = blunders[b2]; break; }
      }
      return { line: bPick.line, loss: bPick.loss, alternative: true };
    }

    // Weight the rest towards small losses with a fat tail, so most "errors"
    // are harmless inaccuracies and only a few are real mistakes.
    var tau = Math.max(18, maxLoss / 3.2);
    var total = 0;
    for (var p = 0; p < pool.length; p++) {
      var weight = Math.exp(-pool[p].loss / tau);
      weight *= 0.75 + Math.random() * 0.5;
      pool[p].weight = weight;
      total += weight;
    }
    var roll = Math.random() * total;
    for (var q = 0; q < pool.length; q++) {
      roll -= pool[q].weight;
      if (roll <= 0) {
        return { line: pool[q].line, loss: pool[q].loss, alternative: true };
      }
    }
    var last = pool[pool.length - 1];
    return { line: last.line, loss: last.loss, alternative: true };
  }

  function loadGame(fen) {
    if (typeof ChessCtor !== 'function') return null;
    try { return new ChessCtor(fen); } catch (e) { return null; }
  }

  function buildFenFor(board, turn, ep, castlingStr) {
    var castling = castlingStr != null ? castlingStr : core.castlingString(board, state.castling);
    var epValue = ep != null ? ep : (state.ep || '-');
    var fen = core.buildFen(board, turn, { castling: castling, ep: epValue });
    var game = loadGame(fen);
    if (!game && typeof ChessCtor === 'function') {
      var alt = core.buildFen(board, turn, { castling: '-', ep: '-' });
      game = loadGame(alt);
      if (!game) return null;
      fen = alt;
    }
    return { fen: fen, game: game };
  }

  function validateTurn(board, turn, game) {
    if (!game) return turn;
    var opp = core.otherColor(turn);
    var kingSq = core.findKing(board, opp);
    if (kingSq < 0) return turn;
    var attacked = false;
    try { attacked = game.isAttacked(core.squareName(kingSq), turn); } catch (e) { attacked = false; }
    return attacked ? opp : turn;
  }

  function isGameOver(game) {
    if (!game) return false;
    try { return !!game.isGameOver(); } catch (e) { return false; }
  }

  function resolveMyColor() {
    if (state.settings.side === 'w' || state.settings.side === 'b') {
      state.myColor = state.settings.side;
      state.myColorResolved = true;
      return;
    }
    if (!state.boardEl) {
      state.myColor = null;
      state.myColorResolved = false;
      return;
    }
    state.myColor = state.siteColor ||
      (state.orientation === 'black' ? 'b' : 'w');
    state.myColorResolved = true;
  }

  /*
   * A manual "whose move" choice is tied to one concrete position. It wins
   * over clocks and last-move guesses until the board changes, so pressing
   * "White to move" is not undone a moment later by the site clock.
   */
  function manualTurnFor(board) {
    if (!state.manualTurn || !state.manualBoard || !board) return null;
    return core.sameBoard(state.manualBoard, board) ? state.manualTurn : null;
  }

  function clearManualTurn() {
    state.manualTurn = null;
    state.manualBoard = null;
  }

  function lockManualTurn(turn, board) {
    if ((turn !== 'w' && turn !== 'b') || !board) {
      clearManualTurn();
      return;
    }
    state.manualTurn = turn;
    state.manualBoard = board.slice();
  }

  function isTurnLocked() {
    return !!manualTurnFor(state.prev && state.prev.board);
  }

  function clearAnalysis() {
    state.lines = [];
    state.bestUci = null;
    state.bestMove = null;
    state.bestSan = '';
    state.scoreText = '';
    state.depth = null;
    state.thinking = false;
    // The last search time belongs to the position being left behind.
    state.thinkMs = null;
    state.thinkStart = null;
    state.lastRequestedFen = null;
    state.lastAutoFen = null;
    state.lastAutoKey = null;
    state.autoKey = null;
    state.autoStatus = '';
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
  }

  function requestAnalysis() {
    if (!state.engine || !state.fen || state.gameOver || !state.settings.enabled) return;
    if (state.fen === state.lastRequestedFen) return;
    state.lastRequestedFen = state.fen;
    state.thinking = true;
    state.thinkStart = Date.now();
    state.thinkMs = null;
    state.error = null;
    var opponentTurn = !!state.myColor && state.turn !== state.myColor;
    var predicting = opponentTurn && !!state.settings.showOpponent;
    // Humanization needs alternatives to choose from even if the visible
    // panel is configured for a single line. The opponent prediction is not
    // humanized, so it only needs the lines the user chose to display.
    var multiPV = clampInt(state.settings.multiPV, 1, 3);
    var humanizing = state.settings.humanize && !state.rescue;
    if (humanizing && !opponentTurn) multiPV = Math.max(6, multiPV);
    var movetime = clampInt(state.settings.movetimeMs, 300, 30000);
    // The cushion gets real search time: a lost position needs calculation,
    // not another fast human guess. It is still bounded by the clock checks
    // below, so this cannot flag us in a scramble.
    if (state.rescue) movetime = Math.max(movetime, rescueSearchMs());
    // Strength: the humanized move is chosen from a deliberately shallow
    // search, otherwise even a 45 cp "error" is still a 2800-level move. The
    // opponent forecast keeps full depth so the arrow stays exact. With
    // adaptive strength the depth follows the site ratings.
    //
    // In a time scramble humanization is skipped entirely (see onBestMove), so
    // the cap is lifted as well: fast + strong is both safer for the clock and
    // exactly how a human plays on the increment-less flag.
    var pressure = !!state.myColor && state.turn === state.myColor && clockStage() >= 2;
    var depth = 0;
    if (!predicting) {
      if (state.rescue) {
        // Full strength: this is the whole point of the cushion. The preset
        // depth cap is for human play, not for saving a lost game.
        depth = 0;
      } else {
        depth = humanizing && !pressure
          ? currentStrength().depth
          : clampInt(state.settings.engineDepth, 0, 40);
      }
    }
    var skill = clampInt(state.settings.engineSkill, 0, 20);
    // While the opponent is thinking their clock is running, not ours, so a
    // deeper forecast costs nothing. Keep it above the fast autoplay time.
    if (predicting) movetime = Math.max(movetime, 3000);
    // On a low clock, search only the top line and return almost immediately.
    // The anti-flag guard will use any line that already arrived.
    if (state.turn === state.myColor) {
      var stage = clockStage();
      var left = clockRemaining(state.myColor);
      if (stage >= 2) {
        multiPV = 1;
        movetime = Math.min(movetime, 100);
      } else if (stage === 1) {
        movetime = Math.min(movetime, 300);
      }
      if (left != null && left < 30000) {
        movetime = Math.min(movetime, Math.max(120, left - 1500));
      }
    }
    state.engine.analyze({
      fen: state.fen,
      multiPV: multiPV,
      movetime: movetime,
      depth: depth,
      skill: skill
    });
    // If the port is not connected the request never leaves the page. Forget
    // it so the engine-ready handler can ask again after reconnecting.
    if (!state.engine.port) state.lastRequestedFen = null;
    render();
  }

  function linesForDisplay() {
    var count = clampInt(state.settings.multiPV, 1, 3);
    var shown = state.lines.slice(0, count);
    if (state.settings.humanize && state.humanChoice &&
        state.humanChoice.fen === state.fen) {
      for (var i = 0; i < state.lines.length; i++) {
        if (state.lines[i].uci !== state.humanChoice.uci) continue;
        if (shown.indexOf(state.lines[i]) < 0) {
          shown = [state.lines[i]].concat(shown.slice(0, count - 1));
        }
        break;
      }
    }
    return shown;
  }

  function render() {
    if (!state.overlay) return;
    if (!state.boardEl || !state.adapter) {
      state.overlay.hide();
      return;
    }
    state.overlay.setBoard(state.boardEl, state.orientation);
    var primary = state.lines[0] || null;
    var myTurn = !!state.myColor && state.turn === state.myColor;
    var showBest = myTurn || !!state.settings.showOpponent;
    var uiVisible = !state.settings.hideOverlay;
    var showArrow = uiVisible && !!state.settings.showArrow;
    var showHud = uiVisible && !!state.settings.showHud;
    state.overlay.update({
      showArrow: showArrow,
      showHud: showHud,
      lines: showArrow && showBest ? linesForDisplay() : [],
      turn: state.turn,
      myTurn: myTurn,
      myColor: state.myColor,
      prediction: !myTurn && showBest,
      showOpponent: !!state.settings.showOpponent,
      bestUci: state.bestUci,
      scoreText: state.scoreText || (primary ? primary.scoreText : ''),
      san: showBest ? (state.bestSan || (primary ? primary.firstSan : '')) : '',
      depth: state.depth || (primary ? primary.depth : null),
      thinking: !!state.thinking,
      thinkMs: state.thinkMs,
      thinkStart: state.thinkStart,
      engineReady: !!state.engineReady,
      engineLabel: state.engineLabel,
      gameOver: !!state.gameOver,
      autoPlay: !!state.settings.autoPlay,
      autoStatus: state.autoStatus,
      error: state.error || state.engineError || null,
      site: state.adapter.id
    });
  }

  function publicState() {
    return {
      ok: true,
      site: state.adapter ? state.adapter.id : null,
      boardFound: !!state.boardEl,
      enabled: !!state.settings.enabled,
      fen: state.fen,
      turn: state.turn,
      turnText: state.turn === 'w' ? 'белые' : 'чёрные',
      turnSource: state.turnSource,
      myColor: state.myColor,
      myColorText: state.myColor === 'b' ? 'чёрные' : state.myColor === 'w' ? 'белые' : null,
      myTurn: !!state.myColor && state.turn === state.myColor,
      ratings: { w: state.ratings.w, b: state.ratings.b },
      targetRating: targetRating(),
      rescue: !!state.rescue,
      prediction: !!state.myColor && state.turn !== state.myColor &&
        !!state.settings.showOpponent,
      turnLocked: isTurnLocked(),
      manualTurn: manualTurnFor(state.prev && state.prev.board),
      showOpponent: !!state.settings.showOpponent,
      thinking: !!state.thinking,
      engineReady: !!state.engineReady,
      engineLabel: state.engineLabel,
      depth: state.depth,
      thinkMs: state.thinkMs,
      score: state.scoreText,
      bestSan: state.bestSan,
      lines: state.lines.slice(0, 3).map(function (line) {
        return {
          san: line.san,
          firstSan: line.firstSan,
          score: line.scoreText,
          depth: line.depth,
          multipv: line.multipv
        };
      }),
      autoPlay: !!state.settings.autoPlay,
      autoBusy: !!state.autoBusy,
      autoStatus: state.autoStatus,
      gameOver: !!state.gameOver,
      error: state.error || state.engineError || null
    };
  }

  function isLegalMove(fen, move) {
    if (typeof ChessCtor !== 'function') return true;
    try {
      var game = new ChessCtor(fen);
      var result = game.move({
        from: core.squareName(move.from),
        to: core.squareName(move.to),
        promotion: move.promotion || undefined
      });
      return !!result;
    } catch (e) {
      return false;
    }
  }

  function waitForBoardChange(previousBoard, timeoutMs) {
    return new Promise(function (resolve) {
      var started = Date.now();
      function check() {
        if (!state.boardEl || !state.adapter) { resolve(false); return; }
        var read = readCurrent();
        if (read && read.board && !core.sameBoard(read.board, previousBoard)) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) { resolve(false); return; }
        setTimeout(check, 90);
      }
      check();
    });
  }

  function scheduleAutoMove() {
    if (!state.settings.autoPlay || state.autoBusy || state.gameOver) return;
    if (!state.myColor || state.turn !== state.myColor) return;
    if (!state.bestMove || !state.fen) return;
    if (state.lastAutoFen === state.fen) return;
    var key = state.fen + '|' + state.bestUci;
    if (state.lastAutoKey === key) return;
    var human = !!state.settings.humanize;

    if (state.autoTimer && state.autoKey === key) {
      if (!human) return;
      // The clock may have dropped since the timer was set. Pull the move
      // forward instead of letting the last seconds run out.
      var safeNow = humanSafeAt(remainingForMe());
      if (safeNow === Infinity || state.humanTargetAt <= safeNow) return;
    }
    if (state.autoTimer) clearTimeout(state.autoTimer);

    state.autoKey = key;
    var delay;
    if (human) {
      if (clockStage() >= 2) {
        if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
        doAutoMove(false);
        return;
      }
      if (state.humanTargetFen !== state.fen || !state.humanTargetAt) {
        var think = humanThinkDelay(remainingForMe());
        var base = state.turnStartedAt || Date.now();
        state.humanTargetFen = state.fen;
        state.humanTargetAt = base + think;
        // If the turn started long ago, still leave a short human beat before
        // the move instead of firing instantly.
        if (state.humanTargetAt < Date.now() + 450) {
          state.humanTargetAt = Date.now() + 450 + Math.random() * 700;
        }
      }
      var deadline = humanSafeAt(remainingForMe());
      var targetAt = Math.min(state.humanTargetAt, deadline);
      delay = Math.max(0, targetAt - Date.now());
      if (delay > 0) state.autoStatus = 'думаю как человек…';
    } else {
      delay = clampInt(state.settings.autoPlayDelayMs, 150, 5000);
    }

    if (delay <= 30) {
      state.autoTimer = null;
      doAutoMove(false);
      return;
    }
    state.autoTimer = setTimeout(function () {
      state.autoTimer = null;
      doAutoMove(false);
    }, delay);
    if (human) render();
  }

  /*
   * Last-resort legal move. The engine normally answers in time; if it does
   * not, any legal move is better than losing on the flag.
   */
  function emergencyFallback() {
    if (!state.game || typeof state.game.moves !== 'function') return null;
    var moves = null;
    try { moves = state.game.moves({ verbose: true }); } catch (e) { moves = null; }
    if (!moves || !moves.length) return null;
    var value = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    var best = moves[0];
    var bestScore = -1;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var score = m.captured ? (value[m.captured] || 1) : 0;
      if (m.promotion) score += 8;
      if (m.san && /[+#]/.test(m.san)) score += 1;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  function playEmergency() {
    if (state.autoBusy || state.gameOver || !state.myColor) return false;
    if (state.turn !== state.myColor || !state.fen) return false;
    if (state.lastAutoFen === state.fen) return false;

    var uci = state.bestUci || (state.lines[0] && state.lines[0].uci) || null;
    if (uci) {
      var parsed = core.uciToMove(uci);
      if (!parsed || !isLegalMove(state.fen, parsed)) uci = null;
    }
    if (!uci) {
      var fallback = emergencyFallback();
      if (!fallback) return false;
      uci = String(fallback.from) + String(fallback.to) +
        (fallback.promotion ? fallback.promotion : '');
      state.bestSan = fallback.san || uci;
    }
    state.bestUci = uci;
    state.bestMove = core.uciToMove(uci);
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
    state.humanTargetAt = 0;
    state.autoStatus = 'спасаю часы…';
    doAutoMove(false);
    return true;
  }

  /*
   * Independent 100 ms watchdog. The normal timer is enough for human pacing,
   * but it must not be the only thing standing between the clock and zero.
   */
  function clockGuard() {
    if (!state.settings.enabled || !state.settings.autoPlay) return;
    if (!state.myColor || !state.fen || state.gameOver || state.autoBusy) return;
    if (state.turn !== state.myColor || state.lastAutoFen === state.fen) return;
    var c = clockState();
    if (c.mine == null || c.mine > 4000) return;
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
    state.humanTargetAt = 0;
    // With four seconds left, send whatever the engine already found. With
    // less than 1.8 seconds, use a legal fallback if the search is still out.
    if (state.bestMove || state.bestUci || (state.lines[0] && state.lines[0].uci) ||
        c.mine <= 1800) {
      playEmergency();
    }
  }

  async function doAutoMove(force) {
    if (state.autoBusy) return;
    if (!state.boardEl || !state.adapter || !state.bestMove || !state.fen) return;
    if (state.gameOver || !state.myColor) return;
    if (state.turn !== state.myColor) {
      if (force) state.error = 'Сейчас ход соперника';
      render();
      return;
    }
    if (!force) {
      if (!state.settings.autoPlay) return;
      if (state.lastAutoFen === state.fen) return;
    } else {
      state.lastAutoFen = null;
      state.lastAutoKey = null;
    }

    var move = state.bestMove;
    if (!isLegalMove(state.fen, move)) {
      state.error = 'Движок предложил недопустимый ход';
      render();
      return;
    }
    var read = readCurrent();
    if (!read || !state.prev || !core.sameBoard(read.board, state.prev.board)) return;

    state.autoBusy = true;
    state.lastAutoFen = state.fen;
    state.lastAutoKey = state.fen + '|' + state.bestUci;
    state.autoStatus = 'делаю ход…';
    state.error = null;
    render();

    var ok = false;
    var via = '';
    try {
      var attempt = await state.autoMover.play(state.boardEl, state.orientation, move, {
        mode: 'click',
        touch: TOUCH,
        color: state.turn,
        site: state.adapter.id
      });
      via = attempt && attempt.via ? attempt.via : '';
      var apiMove = via === 'lichess-api' || via === 'lichess-socket' || via === 'chesscom-api';
      var waitMs = via === 'lichess-socket' ? 4000 : (apiMove ? 3000 : 1900);
      ok = await waitForBoardChange(state.prev.board, waitMs);
      if (!ok && !apiMove) {
        state.autoStatus = 'пробую перетаскивание…';
        render();
        attempt = await state.autoMover.play(state.boardEl, state.orientation, move, {
          mode: 'drag',
          touch: TOUCH,
          color: state.turn,
          site: state.adapter.id
        });
        via = attempt && attempt.via ? attempt.via : via;
        ok = await waitForBoardChange(state.prev.board, 1900);
      }
    } catch (e) {
      state.error = 'Автоход: ' + (e && e.message ? e.message : 'ошибка');
    }

    state.autoBusy = false;
    if (ok) {
      state.autoStatus = via === 'lichess-api' ? 'ход сделан через Lichess'
        : (via === 'chesscom-api' ? 'ход сделан через Chess.com' : 'ход сделан');
      state.error = null;
    } else {
      state.autoStatus = '';
      if (!state.error) {
        if (via === 'lichess-api') {
          state.error = 'Lichess не применил ход через playUci. Обнови страницу анализа.';
        } else if (via === 'lichess-socket') {
          state.error = 'Lichess принял ход в сокет, но доска не обновилась. Проверь партию.';
        } else if (via === 'chesscom-api') {
          state.error = 'Chess.com принял ход, но доска не обновилась. Проверь партию.';
        } else if (state.adapter.id === 'lichess') {
          state.error = 'Lichess не принял ход. Обнови вкладку и повтори.';
        } else if (state.adapter.id === 'chess.com') {
          state.error = 'Chess.com не принял ход. Обнови вкладку и повтори.';
        } else {
          state.error = 'Автоход не сработал: сайт не принял синтетические события. Сделай ход вручную.';
        }
      }
    }
    render();
    if (ok) {
      setTimeout(function () {
        if (state.autoStatus.indexOf('ход сделан') === 0) {
          state.autoStatus = '';
          render();
        }
      }, 1600);
      tick();
    }
  }

  function playNow() {
    if (!state.boardEl || !state.fen) return { ok: false, error: 'Доска не найдена' };
    if (state.gameOver) return { ok: false, error: 'Партия окончена' };
    if (!state.myColor) return { ok: false, error: 'Не определён твой цвет' };
    if (state.turn !== state.myColor) return { ok: false, error: 'Сейчас ход соперника' };
    if (state.autoBusy) return { ok: false, error: 'Ход уже выполняется' };
    if (!state.bestMove) return { ok: false, error: 'Движок ещё думает' };
    state.lastAutoFen = null;
    state.lastAutoKey = null;
    doAutoMove(true);
    return { ok: true };
  }

  /*
   * Rebuild the FEN for a different side to move on the current board.
   * `manual` marks the choice as a user override; automatic clock fixes pass
   * false and keep following the site.
   */
  function rebuildForTurn(turn, manual) {
    if (!state.prev || !state.prev.board) return { ok: false, error: 'Нет позиции' };
    if (turn !== 'w' && turn !== 'b') return { ok: false, error: 'Неверный цвет' };
    var board = state.prev.board;
    // An en passant target only belongs to the side that was to move. When the
    // turn is changed, the right disappears with it.
    var ep = turn === state.turn ? state.ep : '-';
    var built = buildFenFor(
      board,
      turn,
      ep,
      core.castlingString(board, state.castling)
    );
    if (!built) return { ok: false, error: 'Не удалось собрать позицию' };
    if (manual) lockManualTurn(turn, board);
    else clearManualTurn();
    state.ep = ep;
    state.turn = turn;
    state.turnSource = manual ? 'manual' : 'clock';
    state.prev.turn = turn;
    state.fen = built.fen;
    state.game = built.game;
    state.gameOver = isGameOver(built.game);
    state.lines = [];
    state.bestUci = null;
    state.bestMove = null;
    state.bestSan = '';
    state.scoreText = '';
    state.depth = null;
    state.lastRequestedFen = null;
    state.lastAutoFen = null;
    state.lastAutoKey = null;
    state.autoStatus = '';
    state.error = null;
    resetHumanState();
    if (state.myColor && turn === state.myColor) state.turnStartedAt = Date.now();
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
    if (state.gameOver) {
      state.thinking = false;
      state.engine.stop();
    } else {
      requestAnalysis();
    }
    render();
    return { ok: true, turn: turn };
  }

  function flipTurn() {
    return rebuildForTurn(core.otherColor(state.turn), true);
  }

  function setTurn(turn) {
    if (turn === 'auto') {
      clearManualTurn();
      state.clockDisagreement = 0;
      state.prev = null;
      state.lastRequestedFen = null;
      tick();
      render();
      return { ok: true, turn: state.turn };
    }
    return rebuildForTurn(turn, true);
  }

  function correctTurnFromClock(turn) {
    rebuildForTurn(turn, false);
  }

  function acceptRead(read, inferred) {
    var board = read.board;
    var previousBoard = state.prev ? state.prev.board : null;
    var isStart = core.isStartBoard(board);
    var oldFen = state.fen;
    var siteFen = typeof read.fen === 'string' && read.fen.split(/\s+/).length >= 4
      ? read.fen
      : null;
    var siteTurn = read.turn === 'w' || read.turn === 'b' ? read.turn : null;
    var turn;

    var forcedTurn = manualTurnFor(board);
    if (state.manualTurn && !forcedTurn) clearManualTurn();

    var turnSource;
    if (forcedTurn) {
      turn = forcedTurn;
      turnSource = 'manual';
    } else if (siteTurn) {
      // The site's own game object is the most reliable source. It also knows
      // whose turn it is after a jump or when the renderer drops an animation.
      turn = siteTurn;
      turnSource = 'site';
    } else if (isStart) {
      turn = 'w';
      turnSource = 'start';
    } else if (previousBoard) {
      if (inferred) {
        // A clean single-move diff is authoritative. Do not let a clock that
        // updates a moment earlier flip it back and forth.
        turn = core.otherColor(inferred.color);
        turnSource = 'infer';
      } else if (read.clockTurn) {
        turn = read.clockTurn;
        turnSource = 'clock';
      } else if (read.lastMoveColor) {
        turn = core.otherColor(read.lastMoveColor);
        turnSource = 'lastMove';
      } else {
        // One move was probably played manually but the animation dropped a
        // frame. Toggling is a better guess than always falling back to White.
        turn = core.otherColor(state.prev.turn);
        turnSource = 'toggle';
      }
    } else if (read.clockTurn) {
      // Joining a game in progress: the running clock is the best hint.
      turn = read.clockTurn;
      turnSource = 'clock';
    } else if (read.lastMoveColor) {
      turn = core.otherColor(read.lastMoveColor);
      turnSource = 'lastMove';
    } else {
      turn = state.settings.seedTurn === 'b' ? 'b' : 'w';
      turnSource = 'seed';
    }

    if (isStart) {
      state.castling = core.newCastlingTracker();
      state.ep = null;
      // A rematch can swap colours without replacing the board element.
      state.myColorResolved = false;
      // New game, new form: a rematch should not replay the previous game's
      // accuracy with the same settings.
      newHumanForm();
    } else if (siteFen) {
      // The FEN carries the real castling rights and en passant target.
      state.castling = core.newCastlingTracker();
      state.ep = null;
      if (!previousBoard) newHumanForm();
    } else if (!inferred && previousBoard && core.countDiff(previousBoard, board) > 4) {
      // A new game or a large jump: old castling rights are meaningless.
      state.castling = core.newCastlingTracker();
      state.ep = null;
      newHumanForm();
    }
    core.updateCastlingTracker(board, state.castling);
    var fenParts = siteFen ? siteFen.split(/\s+/) : null;
    state.ep = fenParts && fenParts[3] && fenParts[3] !== '-'
      ? fenParts[3].toLowerCase()
      : (isStart ? null : (inferred ? core.enPassantFromMove(board, inferred) : null));

    var built = null;
    if (siteFen && !forcedTurn) {
      var siteGame = loadGame(siteFen);
      // Only trust the site FEN when its side to move matches the chosen turn.
      if (siteGame && fenParts[1] === turn) built = { fen: siteFen, game: siteGame };
    }
    if (!built) {
      built = buildFenFor(
        board,
        turn,
        state.ep,
        core.castlingString(board, state.castling)
      );
    }
    if (!built) {
      state.prev = { board: board, turn: turn };
      state.turn = turn;
      state.turnSource = turnSource;
      state.fen = null;
      state.game = null;
      state.gameOver = false;
      state.thinking = false;
      state.lines = [];
      state.bestUci = null;
      state.bestMove = null;
      state.bestSan = '';
      state.scoreText = '';
      state.depth = null;
      state.error = 'Не удалось прочитать позицию';
      render();
      return;
    }

    var game = built.game;
    if (game) {
      var fixedTurn = validateTurn(board, turn, game);
      if (fixedTurn !== turn) {
        turn = fixedTurn;
        turnSource = 'validate';
        if (forcedTurn) clearManualTurn();
        var rebuilt = buildFenFor(
          board,
          turn,
          state.ep,
          core.castlingString(board, state.castling)
        );
        if (rebuilt) {
          built = rebuilt;
          game = built.game;
        }
      }
    }

    var fenChanged = built.fen !== oldFen;
    state.prev = { board: board, turn: turn };
    state.turn = turn;
    state.turnSource = turnSource;
    state.fen = built.fen;
    state.game = game;
    state.gameOver = isGameOver(game) || !!read.gameOver;
    state.clockTurn = read.clockTurn || state.clockTurn || null;
    state.clockDisagreement = 0;
    state.badReads = 0;
    state.pendingBoard = null;
    state.error = null;

    if (read.myColor === 'w' || read.myColor === 'b') state.siteColor = read.myColor;
    if (read.ratings) {
      // Merge, not replace: a single failed scrape must not drop the rating
      // that the whole adaptive strength model depends on.
      if (read.ratings.w) state.ratings.w = read.ratings.w;
      if (read.ratings.b) state.ratings.b = read.ratings.b;
    }
    if (!state.myColorResolved) {
      resolveMyColor();
    } else if (read.myColor &&
               state.settings.side !== 'w' && state.settings.side !== 'b' &&
               state.myColor !== read.myColor) {
      // A rematch can swap colours while keeping the same board element.
      state.myColor = read.myColor;
      state.myColorResolved = true;
    }

    if (fenChanged || state.gameOver) {
      state.lines = [];
      state.bestUci = null;
      state.bestMove = null;
      state.bestSan = '';
      state.scoreText = '';
      state.depth = null;
      state.thinking = false;
      state.lastAutoFen = null;
      state.lastAutoKey = null;
      state.autoStatus = '';
      if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
      resetHumanState();
    }

    // The human think time is measured from the moment the turn appeared, not
    // from the moment Stockfish finished. Joining mid-turn starts it now.
    if (!state.gameOver && state.myColor && state.turn === state.myColor) {
      if (!state.turnStartedAt) state.turnStartedAt = Date.now();
    } else {
      state.turnStartedAt = 0;
    }

    if (state.gameOver) {
      state.thinking = false;
      state.lastRequestedFen = null;
      state.engine.stop();
    } else if (fenChanged) {
      requestAnalysis();
    }
    render();
  }

  function initBoard(boardEl) {
    state.engine.stop();
    state.boardEl = boardEl;
    state.prev = null;
    state.castling = core.newCastlingTracker();
    state.ep = null;
    state.lines = [];
    state.bestUci = null;
    state.bestMove = null;
    state.bestSan = '';
    state.scoreText = '';
    state.depth = null;
    state.thinking = false;
    state.gameOver = false;
    state.game = null;
    state.turnSource = null;
    state.error = null;
    state.autoStatus = '';
    state.clockTurn = null;
    state.clockDisagreement = 0;
    state.clocks = { w: null, b: null };
    state.clockAt = 0;
    state.siteColor = null;
    state.ratings = { w: null, b: null };
    state.badReads = 0;
    state.pendingBoard = null;
    state.lastRequestedFen = null;
    state.lastAutoFen = null;
    state.lastAutoKey = null;
    state.autoKey = null;
    state.myColorResolved = false;
    clearManualTurn();
    resetHumanState();
    newHumanForm();
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
    // With side "auto" the colour comes from the board orientation, which is
    // only known after the first read. Resolve it there instead of assuming
    // White; otherwise joining a flipped game picks the wrong side.
    if (state.settings.side === 'w' || state.settings.side === 'b') resolveMyColor();
    else state.myColor = null;
    if (state.engine && !state.engine.port) state.engine.connect();
    state.overlay.setBoard(boardEl, state.orientation);
  }

  function resetBoard() {
    state.engine.stop();
    state.boardEl = null;
    state.prev = null;
    state.fen = null;
    state.game = null;
    state.gameOver = false;
    state.turn = 'w';
    state.turnSource = null;
    state.lines = [];
    state.bestUci = null;
    state.bestMove = null;
    state.bestSan = '';
    state.scoreText = '';
    state.depth = null;
    state.thinking = false;
    state.error = null;
    state.autoStatus = '';
    state.clockTurn = null;
    state.clockDisagreement = 0;
    state.clocks = { w: null, b: null };
    state.clockAt = 0;
    state.siteColor = null;
    state.ratings = { w: null, b: null };
    state.bridge.state = null;
    state.bridge.at = 0;
    state.bridge.error = null;
    state.badReads = 0;
    state.pendingBoard = null;
    state.lastRequestedFen = null;
    state.lastAutoFen = null;
    state.lastAutoKey = null;
    state.autoKey = null;
    clearManualTurn();
    resetHumanState();
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
    state.overlay.hide();
  }

  function elementShown(el) {
    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style;
    try { style = getComputedStyle(el); } catch (e) { return true; }
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  /*
   * The chess.com page bridge returns the board's descriptor because the
   * content script cannot reach the page-world element directly. Prefer the
   * exact element over the adapter's heuristic when both are available.
   */
  function bridgeBoardElement(snapshot) {
    if (!snapshot || !snapshot.board) return null;
    var desc = snapshot.board;
    var nodes = [];
    function add(node) {
      if (node && nodes.indexOf(node) < 0) nodes.push(node);
    }
    try {
      if (desc.id) add(document.getElementById(desc.id));
      if (desc.tag) {
        var tags = document.getElementsByTagName(desc.tag);
        for (var t = 0; t < tags.length; t++) add(tags[t]);
      }
      if (!nodes.length && desc.className) {
        var cls = String(desc.className).trim().split(/\s+/)[0];
        if (cls) {
          var byClass = document.getElementsByClassName(cls);
          for (var c = 0; c < byClass.length; c++) add(byClass[c]);
        }
      }
    } catch (e) { /* fall back to the adapter */ }

    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!elementShown(el)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 120) continue;
      var score = rect.width * rect.height;
      if (desc.rect) {
        var delta = Math.abs(rect.left - desc.rect.left) +
                    Math.abs(rect.top - desc.rect.top) +
                    Math.abs(rect.width - desc.rect.width) +
                    Math.abs(rect.height - desc.rect.height);
        if (delta < 8) score += 100000000;
        else score -= delta * 1000;
      }
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function chesscomBridgeRead() {
    var snapshot = state.bridge.state;
    if (!snapshot || !snapshot.fen) return null;
    if (Date.now() - state.bridge.at > 3000) return null;

    var parts = String(snapshot.fen).split(/\s+/);
    if (parts.length < 4 || parts[0].split('/').length !== 8) return null;
    var board = core.boardFromFen(parts[0]);
    if (core.countPieces(board) < 2) return null;

    var turn = snapshot.turn === 'w' || snapshot.turn === 'b' ? snapshot.turn : parts[1];
    if (turn !== 'w' && turn !== 'b') return null;
    var myColor = snapshot.playingAs === 'w' || snapshot.playingAs === 'b'
      ? snapshot.playingAs
      : null;

    return {
      board: board,
      fen: snapshot.fen,
      turn: turn,
      myColor: myColor,
      orientation: snapshot.orientation === 'black' ? 'black' : 'white',
      gameOver: !!snapshot.gameOver
    };
  }

  function pollChesscomBridge() {
    var bridge = state.bridge;
    if (!CA.PageBridge || bridge.pending) return;
    if (Date.now() - bridge.at < 200) return;

    bridge.pending = true;
    CA.PageBridge.chesscomState().then(function (result) {
      bridge.pending = false;
      bridge.at = Date.now();
      if (result && result.ok && result.state) {
        bridge.state = result.state;
        bridge.error = null;
        return;
      }
      // A missing game/FEN means the page moved on to a lobby or a new game.
      // A transient timeout should keep the last good snapshot for a moment.
      if (result && (result.code === 'no-game' || result.code === 'no-fen')) {
        bridge.state = null;
      }
      bridge.error = result && result.error ? result.error : null;
    }, function () {
      bridge.pending = false;
      bridge.at = Date.now();
    });
  }

  function readCurrent() {
    if (!state.boardEl || !state.adapter) return null;
    if (state.adapter.id === 'chess.com') {
      var bridged = chesscomBridgeRead();
      if (bridged) return bridged;
    }
    try { return state.adapter.read(state.boardEl); } catch (e) { return null; }
  }

  function tick() {
    if (!state.overlay) return;
    if (!state.settings.enabled) {
      if (state.wasEnabled !== false) {
        state.wasEnabled = false;
        state.overlay.hide();
      }
      return;
    }
    state.wasEnabled = true;

    var adapter = CA.sites.detect();
    if (!adapter) return;
    state.adapter = adapter;
    updateSiteClocks();

    if (adapter.id === 'chess.com') pollChesscomBridge();

    var boardEl = null;
    if (adapter.id === 'chess.com') boardEl = bridgeBoardElement(state.bridge.state);
    if (!boardEl) {
      try { boardEl = adapter.findBoard(); } catch (e) { boardEl = null; }
    }
    if (!boardEl) {
      if (state.boardEl) resetBoard();
      return;
    }
    if (boardEl !== state.boardEl) initBoard(boardEl);

    var read = null;
    if (adapter.id === 'chess.com') read = chesscomBridgeRead();
    if (!read) {
      try { read = adapter.read(boardEl); } catch (e) { read = null; }
    }
    if (!read || !read.board) return;

    var colorChanged = false;
    if (read.myColor === 'w' || read.myColor === 'b') {
      state.siteColor = read.myColor;
      if (state.settings.side !== 'w' && state.settings.side !== 'b' &&
          state.myColor !== read.myColor) {
        state.myColor = read.myColor;
        state.myColorResolved = true;
        colorChanged = true;
      }
    }

    var orientationChanged = !!read.orientation && read.orientation !== state.orientation;
    if (read.orientation) state.orientation = read.orientation;
    state.clockTurn = read.clockTurn || state.clockTurn || null;

    if (state.prev && core.sameBoard(state.prev.board, read.board)) {
      state.badReads = 0;
      state.pendingBoard = null;
      if (!state.myColorResolved) resolveMyColor();
      if (!state.gameOver && state.myColor && state.turn === state.myColor && !state.turnStartedAt) {
        state.turnStartedAt = Date.now();
      }
      if (orientationChanged || colorChanged) render();
      if (read.gameOver && !state.gameOver) {
        state.gameOver = true;
        state.thinking = false;
        state.lastRequestedFen = null;
        state.engine.stop();
        render();
      }
      // The site's game object wins over a weak inferred/toggle turn. A manual
      // choice stays locked for this exact position.
      if (read.turn && read.turn !== state.turn && state.turnSource !== 'site' &&
          !isTurnLocked() && !state.autoBusy && !state.gameOver) {
        acceptRead(read, null);
        return;
      }
      // A clock value that arrived after the first read may correct a weak
      // seed/toggle guess once. It must never override a turn obtained from a
      // clean board diff or from the user: that causes the side to flicker.
      var weakTurn = state.turnSource === 'seed' || state.turnSource === 'toggle';
      if (weakTurn && !isTurnLocked() && read.clockTurn && read.clockTurn !== state.turn &&
          !state.autoBusy && !state.gameOver) {
        state.clockDisagreement++;
        if (state.clockDisagreement >= 2) {
          state.clockDisagreement = 0;
          correctTurnFromClock(read.clockTurn);
          return;
        }
      } else {
        state.clockDisagreement = 0;
      }
      if (state.settings.autoPlay && state.bestMove && !state.gameOver && !state.autoBusy) {
        scheduleAutoMove();
      }
      return;
    }

    var inferred = state.prev ? core.inferMove(state.prev.board, read.board) : null;
    if (state.prev && !inferred && !read.fen) {
      state.badReads++;
      if (!state.pendingBoard || !core.sameBoard(state.pendingBoard, read.board)) {
        state.pendingBoard = read.board;
        state.pendingSince = Date.now();
      }
      if (state.badReads < 3 && Date.now() - state.pendingSince < 900) {
        return;
      }
    } else {
      state.badReads = 0;
      state.pendingBoard = null;
    }

    acceptRead(read, inferred);
  }

  function onEngineStatus(msg) {
    var wasReady = state.engineWasReady;
    state.engineWasReady = !!msg.ready;
    state.engineReady = !!msg.ready;
    if (msg.engine) state.engineLabel = msg.engine;
    if (msg.error) state.engineError = msg.error;
    else if (msg.ready) state.engineError = null;
    // A restarted engine has no search for our position. Ask again unless the
    // pending request survived (lastRequestedFen matches the current FEN).
    if (!wasReady && state.engineReady && state.fen && !state.gameOver &&
        state.settings.enabled && state.lastRequestedFen !== state.fen) {
      state.thinking = true;
      requestAnalysis();
    }
    render();
  }

  function onAnalysis(msg) {
    if (!state.fen || !msg || msg.fen !== state.fen) return;
    var lines = (msg.lines || []).map(function (line) {
      if (!line || !line.pv || !line.pv.length) return null;
      var sans = core.sanLines(state.fen, line.pv, 10);
      return {
        uci: line.pv[0],
        pv: line.pv,
        multipv: line.multipv || 1,
        depth: line.depth,
        score: line.score,
        scoreText: core.formatScore(line.score, state.turn, state.myColor || 'w'),
        san: sans.join(' '),
        firstSan: sans[0] || line.pv[0]
      };
    }).filter(Boolean).sort(function (a, b) { return a.multipv - b.multipv; });
    if (!lines.length) return;
    state.lines = lines;
    state.depth = lines[0].depth;
    state.scoreText = lines[0].scoreText;
    // Once a humanized move is chosen for this position, do not let a late
    // analysis update replace it in the panel/overlay.
    state.bestSan = state.settings.humanize && state.humanChoice &&
      state.humanChoice.fen === state.fen
      ? state.humanChoice.firstSan
      : lines[0].firstSan;
    if (!state.bestUci) state.bestUci = lines[0].uci;
    state.engineError = null;
    state.thinking = true;
    render();
  }

  function onBestMove(msg) {
    if (!state.fen || !msg || (msg.fen && msg.fen !== state.fen)) return;
    // Search time for the chip. Measured here rather than read from the engine
    // so it also covers the round trip through the worker on a slow phone.
    if (state.thinkStart) {
      state.thinkMs = Date.now() - state.thinkStart;
      state.thinkStart = null;
    }
    state.thinking = false;

    var myTurn = !!state.myColor && state.turn === state.myColor;

    // Safety cushion: decided once per position, before the human pick.
    if (myTurn) {
      var modeChanged = noteRescuePosition(
        state.lines.length ? lineScoreCp(state.lines[0]) : null
      );
      // The lines in hand were produced by the human model (shallow depth, wide
      // alternatives). If the cushion just armed, using them as the rescue move
      // would waste the whole point of it. Re-request the position at full
      // strength and let the next result play. Same on release, so the human
      // model gets lines at its own depth instead of engine-depth leftovers.
      if (modeChanged && state.lines.length) {
        state.lastRequestedFen = null;
        state.thinking = false;
        requestAnalysis();
        if (state.thinking) {
          render();
          return;
        }
      }
    }

    var choice = state.humanChoice && state.humanChoice.fen === state.fen
      ? state.humanChoice
      : null;
    // Humanization only affects the move we actually play. The opponent
    // prediction keeps the true engine best move, so the forecast stays exact.
    // Under time pressure the top move is both faster and stronger.
    if (!choice && myTurn && state.settings.humanize && !state.rescue &&
        clockStage() < 2) {
      var picked = chooseHumanLine();
      if (picked) {
        choice = {
          fen: state.fen,
          uci: picked.line.uci,
          firstSan: picked.line.firstSan,
          lossCp: picked.loss || 0,
          alternative: !!picked.alternative
        };
        state.humanChoice = choice;
      }
    }

    if (choice) {
      state.bestUci = choice.uci;
      state.bestMove = core.uciToMove(choice.uci);
      state.bestSan = choice.firstSan;
    } else {
      state.bestUci = msg.uci || null;
      state.bestMove = msg.uci ? core.uciToMove(msg.uci) : null;
      if (state.bestMove) {
        var sans = core.sanLines(state.fen, [msg.uci], 1);
        state.bestSan = sans[0] || msg.uci;
      }
    }
    state.engineError = null;
    render();
    scheduleAutoMove();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes) return;
    var touched = false;
    var reanalyze = false;
    var humanTouched = false;
    for (var key in changes) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      state.settings[key] = changes[key].newValue;
      touched = true;
      if (key === 'multiPV' || key === 'movetimeMs' || key === 'humanize' ||
          key === 'engineDepth' || key === 'engineSkill' ||
          key === 'humanizeAdaptive' || key === 'humanizeRating') reanalyze = true;
      if (key.indexOf('humanize') === 0) {
        humanTouched = true;
        state.humanChoice = null;
        state.humanTargetFen = null;
        state.humanTargetAt = 0;
        if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
        if (key === 'humanizeRescue') {
          state.rescue = false;
          state.rescueStreak = 0;
          state.rescueMoves = 0;
          state.rescueCount = 0;
          state.rescueFen = null;
        }
      }
    }
    if (!touched) return;

    if (changes.side) {
      state.myColorResolved = false;
      resolveMyColor();
      // Evaluation is shown from the player's point of view, so the old
      // numbers no longer apply after switching sides.
      reanalyze = true;
    }
    if (!state.settings.enabled) {
      if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
      state.thinking = false;
      if (state.engine) state.engine.stop();
      if (state.overlay) state.overlay.hide();
      return;
    }
    if (changes.enabled && state.settings.enabled) {
      // The board may not have changed while the extension was off, so tick()
      // alone would not start a new search. Reset the bookkeeping and ask for
      // analysis explicitly after the board is read.
      state.lastRequestedFen = null;
      state.lines = [];
      state.bestUci = null;
      state.bestMove = null;
      state.bestSan = '';
      state.scoreText = '';
      state.depth = null;
      state.thinking = true;
      state.autoStatus = '';
      state.lastAutoFen = null;
      state.lastAutoKey = null;
      if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
      tick();
      if (state.fen && !state.gameOver) requestAnalysis();
      render();
      return;
    }
    if (changes.seedTurn && state.prev && state.prev.board &&
        (state.settings.seedTurn === 'w' || state.settings.seedTurn === 'b')) {
      // Picking "White to move" must take effect immediately, even when the
      // site clock disagrees and even when the setting already had that value.
      rebuildForTurn(state.settings.seedTurn, true);
      return;
    }
    if (changes.autoPlay) {
      if (!state.settings.autoPlay) {
        if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
      } else {
        state.lastAutoFen = null;
        state.lastAutoKey = null;
        scheduleAutoMove();
      }
    }
    if (reanalyze) {
      state.lastRequestedFen = null;
      state.lines = [];
      state.bestUci = null;
      state.bestMove = null;
      state.bestSan = '';
      state.scoreText = '';
      state.depth = null;
      state.thinking = true;
      requestAnalysis();
    } else if (humanTouched && state.settings.autoPlay && state.bestMove &&
               !state.gameOver && !state.autoBusy) {
      scheduleAutoMove();
    }
    render();
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'ca-state') {
      sendResponse(publicState());
      return true;
    }
    if (msg.type === 'ca-play-now') {
      sendResponse(playNow());
      return true;
    }
    if (msg.type === 'ca-flip-turn') {
      sendResponse(flipTurn());
      return true;
    }
    if (msg.type === 'ca-set-turn') {
      sendResponse(setTurn(msg.turn));
      return true;
    }
    if (msg.type === 'ca-recalc') {
      var ok = !!state.fen;
      if (ok) {
        state.lastRequestedFen = null;
        state.lines = [];
        state.bestUci = null;
        state.bestMove = null;
        state.bestSan = '';
        state.scoreText = '';
        state.depth = null;
        state.thinking = true;
        requestAnalysis();
        render();
      }
      sendResponse({ ok: ok });
      return true;
    }
  }

  var syncQueued = false;
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(function () {
      syncQueued = false;
      if (state.boardEl) state.overlay.setBoard(state.boardEl, state.orientation);
    });
  }

  async function init() {
    if (!api || !api.storage) return;
    try {
      // Read only what is actually stored. get(DEFAULTS) would also return
      // the defaults for missing keys, which would hide a changed default
      // (for example the persistent opponent arrow).
      var stored = await api.storage.local.get(null);
      state.settings = Object.assign({}, DEFAULTS, stored || {});
    } catch (e) {
      state.settings = Object.assign({}, DEFAULTS);
    }

    state.overlay = CA.createOverlay();
    state.overlay.mount();
    state.autoMover = new CA.AutoMover();
    // Site moves go through the page-world bridge (Lichess analysis/socket,
    // Chess.com game API). Inject it early so the user does not lose the first
    // auto-move to a slow script load.
    try {
      if (/(^|\.)lichess\.org$/.test(location.hostname) ||
          /(^|\.)chess\.com$/.test(location.hostname)) {
        CA.PageBridge.install();
      }
    } catch (e) { /* the bridge is optional until a move is needed */ }
    state.engine = new CA.EngineClient();
    state.engine.on('status', onEngineStatus);
    state.engine.on('analysis', onAnalysis);
    state.engine.on('bestmove', onBestMove);
    state.engine.on('cancelled', function () {
      state.thinking = false;
      // The background dropped this search (port loss, superseded request or
      // explicit stop). Allow a later ready transition to ask again.
      state.lastRequestedFen = null;
      render();
    });
    state.engine.on('error', function (msg) {
      state.thinking = false;
      state.engineError = (msg && msg.message) || 'Ошибка Stockfish';
      // The search died with the engine; retry once it reports ready again.
      state.lastRequestedFen = null;
      render();
    });

    try {
      api.runtime.onMessage.addListener(onRuntimeMessage);
      api.storage.onChanged.addListener(onStorageChanged);
    } catch (e) { /* extension context may be invalidated */ }

    window.addEventListener('resize', scheduleSync);
    window.addEventListener('scroll', scheduleSync, true);
    document.addEventListener('fullscreenchange', scheduleSync);
    // The mobile URL bar collapses as the page scrolls, which resizes the
    // visual viewport without firing a window resize on every frame.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleSync);
      window.visualViewport.addEventListener('scroll', scheduleSync);
    }
    // A phone suspends timers while another app is in front. On return the
    // board may have moved without us: forget the cached position and re-read.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      state.lastRequestedFen = null;
      state.lastAutoFen = null;
      scheduleSync();
      tick();
    });
    setInterval(tick, 250);
    setInterval(clockGuard, 100);
    tick();
  }

  init();
})();
