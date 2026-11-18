/*
 * Chess Assist - background engine host.
 *
 * A single Stockfish 19 (WASM, single-threaded) worker is shared by all
 * chess tabs. Two builds are shipped: the full NNUE build (strongest, ~95 MB)
 * and the Lite build (small net, fast startup). Content scripts talk to the
 * worker through a runtime port named "ca-engine"; the popup asks for status
 * with runtime.sendMessage().
 *
 * The controller is deliberately conservative: Stockfish must answer "stop"
 * with a final "bestmove" before a new search starts, so stale evaluations
 * can never leak into a different position.
 */
(function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime) return;

  var core = (globalThis.CA && globalThis.CA.core) || null;
  var ENGINE_BUILDS = {
    full: {
      url: 'engine/stockfish-19-single.js',
      label: 'Stockfish 19 NNUE',
      hashMb: 256,
      initTimeoutMs: 60000
    },
    lite: {
      url: 'engine/stockfish.js',
      label: 'Stockfish 19 Lite',
      hashMb: 64,
      initTimeoutMs: 20000
    }
  };
  /*
   * Both builds ship in both packages, so the phone runs exactly what the
   * desktop runs. What changes on a mobile user agent is the transposition
   * table: 64 MB instead of 256 MB for the full build, 32 MB instead of 64 MB
   * for Lite. Search depth is not affected, only how much of the tree the
   * engine keeps in memory.
   */
  var IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(
    (globalThis.navigator && globalThis.navigator.userAgent) || ''
  );
  var MOBILE_HASH_MB = { full: 64, lite: 32 };
  // A phone can be killed for memory while the 96 MB NNUE build is running, so
  // two such deaths drop it back to Lite for the session. A fresh install or an
  // explicit restart tries the full build again.
  var MOBILE_FULL_CRASH_LIMIT = 2;
  var DEFAULT_BUILD = 'full';
  var MAX_MOVETIME = 30000;
  var INFO_THROTTLE_MS = 110;
  var INFO_PV_LIMIT = 24;
  var MAX_RESTARTS = 4;

  var engine = null;
  var ready = false;
  var starting = false;
  var error = null;
  var note = null;
  var current = null;
  var pending = null;
  var awaitingStop = false;
  var lastMultiPV = 1;
  var lastSkill = 20;
  var restartAttempts = 0;
  // 'full' | 'lite' as chosen by the user, and the build actually running
  // (which falls back to Lite when the full build cannot be loaded).
  var buildSetting = DEFAULT_BUILD;
  var fullBuildFailed = false;
  var mobileFullCrashes = 0;

  var initTimer = null;
  var stopTimer = null;
  var watchdogTimer = null;
  var infoTimer = null;
  var restartTimer = null;
  var engineLineBuffer = '';

  var ports = new Set();

  /*
   * Root-split parallelism. Firefox never hands a WebExtension page a
   * SharedArrayBuffer, and a pthread build of Stockfish cannot start without
   * one, so "setoption name Threads" is unreachable here. What is reachable is
   * several ordinary single-threaded workers, each given its own share of the
   * root moves with "searchmoves", the highest score winning at the end. There
   * is no shared hash and no cross-thread pruning, so the gain is a fraction of
   * true SMP - but the work really is parallel, and it needs no preference, no
   * rebuild and no phone-specific build.
   */
  var MAX_HELPERS = 3;
  // A helper is only worth its memory when there is time to spend it. Below the
  // spawn threshold the extra workers would be told what to do and then
  // immediately stopped, which costs more than it returns.
  var SPLIT_SPAWN_MOVETIME = 900;
  var SPLIT_MIN_MOVETIME = 220;
  var SPLIT_GRACE_MS = 1500;
  var helpers = [];

  /* ------------------------------------------------------------- utilities */

  function clampInt(value, lo, hi) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) n = lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function clearTimer(name) {
    if (name === 'init' && initTimer) { clearTimeout(initTimer); initTimer = null; }
    if (name === 'stop' && stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (name === 'watchdog' && watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    if (name === 'info' && infoTimer) { clearTimeout(infoTimer); infoTimer = null; }
    if (name === 'restart' && restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }

  function send(port, message) {
    if (!port) return;
    try {
      port.postMessage(message);
    } catch (e) {
      ports.delete(port);
    }
  }

  function broadcast(message) {
    ports.forEach(function (port) { send(port, message); });
  }

  function statusMessage() {
    var cfg = activeBuildConfig();
    return {
      type: 'status',
      ready: !!(ready && !error),
      starting: !!starting,
      searching: !!(current || awaitingStop || pending),
      error: error || null,
      note: note || null,
      engine: cfg.label,
      build: activeBuildId(),
      buildSetting: buildSetting,
      mobile: IS_MOBILE,
      hashMb: hashMbFor(cfg),
      maxMovetime: MAX_MOVETIME,
      multipv: lastMultiPV,
      skill: lastSkill,
      threads: splitWidth(),
      parallel: parallelWidth()
    };
  }

  function broadcastStatus() {
    broadcast(statusMessage());
  }

  function sendError(request, message) {
    if (!request) return;
    send(request.port, {
      type: 'error',
      id: request.id,
      message: message
    });
  }

  /* ----------------------------------------------------------- UCI parsing */

  function parseInfo(line) {
    if (core && typeof core.parseInfoLine === 'function') {
      return core.parseInfoLine(line);
    }
    // Minimal fallback. It is only used if core.js somehow did not load.
    if (line.indexOf('info ') !== 0 || line.indexOf(' pv ') < 0) return null;
    var tokens = line.split(/\s+/);
    var out = { depth: null, multipv: 1, score: null, pv: [] };
    for (var i = 1; i < tokens.length; i++) {
      if (tokens[i] === 'depth') out.depth = parseInt(tokens[++i], 10);
      else if (tokens[i] === 'multipv') out.multipv = parseInt(tokens[++i], 10) || 1;
      else if (tokens[i] === 'score') {
        var kind = tokens[++i];
        var value = parseInt(tokens[++i], 10);
        if (kind === 'cp' || kind === 'mate') out.score = { type: kind, value: value };
      } else if (tokens[i] === 'pv') {
        out.pv = tokens.slice(i + 1);
        break;
      }
    }
    return out.pv.length ? out : null;
  }

  function parseBestMove(line) {
    var match = /^bestmove\s+(\S+)/.exec(line);
    if (!match) return null;
    var uci = match[1];
    if (uci === '(none)' || uci === '0000') return '';
    return uci;
  }

  /* ------------------------------------------------------------- engine life */

  function activeBuildId() {
    // The user's choice wins on every device. The only override is a build
    // that already failed to load or was killed by the system twice.
    if (buildSetting === 'full' && fullBuildFailed) return 'lite';
    return ENGINE_BUILDS[buildSetting] ? buildSetting : DEFAULT_BUILD;
  }

  function activeBuildConfig() {
    return ENGINE_BUILDS[activeBuildId()];
  }

  function hashMbFor(cfg) {
    if (!cfg) return 32;
    var id = activeBuildId();
    var cap = MOBILE_HASH_MB[id] || MOBILE_HASH_MB.lite;
    return IS_MOBILE ? Math.min(cfg.hashMb, cap) : cfg.hashMb;
  }

  function loadBuildSetting() {
    function apply(values) {
      var value = values && values.engineBuild;
      if (value !== 'full' && value !== 'lite') return;
      if (value === buildSetting) return;
      buildSetting = value;
      // A tab may connect before this async read finishes. If the wrong build
      // is already loading, switch now instead of running it until the next
      // manual restart.
      if (engine || starting) restartEngine(false, value);
    }
    try {
      // Chrome's callback form returns nothing; Firefox returns a promise.
      // Supporting both keeps the background page honest on either engine.
      var result = api.storage.local.get('engineBuild', apply);
      if (result && typeof result.then === 'function') {
        result.then(apply, function () { /* keep the default */ });
      }
    } catch (e) {
      try {
        var fallback = api.storage.local.get('engineBuild');
        if (fallback && typeof fallback.then === 'function') {
          fallback.then(apply, function () { /* keep the default */ });
        }
      } catch (e2) { /* keep the default */ }
    }
  }

  function resetEngineState() {
    engine = null;
    ready = false;
    starting = false;
    current = null;
    pending = null;
    awaitingStop = false;
    lastMultiPV = 1;
    lastSkill = 20;
    error = null;
    engineLineBuffer = '';
    // The helpers belong to the build that is going away. Keeping them would
    // leave workers of the old build answering for the new one.
    destroyHelpers();
    clearTimer('init');
    clearTimer('stop');
    clearTimer('watchdog');
    clearTimer('info');
  }

  function restartEngine(resetFallback, build) {
    if (build === 'full' || build === 'lite') buildSetting = build;
    var worker = engine;
    engine = null;
    if (worker) {
      try { worker.terminate(); } catch (e) { /* ignore */ }
    }
    clearTimer('restart');
    // The worker is about to disappear. Tell whoever was waiting so they can
    // ask again when the replacement is ready instead of staying in
    // "thinking" forever.
    var active = current;
    var queued = pending;
    var cancelled = [];
    if (active) cancelled.push(active);
    if (queued && queued !== active) cancelled.push(queued);
    resetEngineState();
    for (var i = 0; i < cancelled.length; i++) {
      send(cancelled[i].port, { type: 'cancelled', id: cancelled[i].id });
    }
    note = null;
    restartAttempts = 0;
    if (resetFallback) {
      fullBuildFailed = false;
      mobileFullCrashes = 0;
    }
    broadcastStatus();
    ensureEngine();
  }

  function ensureEngine() {
    if (engine || starting || restartTimer) return;
    createEngine();
  }

  function createEngine() {
    if (engine || starting) return;
    starting = true;
    ready = false;
    error = null;
    lastMultiPV = 1;
    lastSkill = 20;
    current = null;
    awaitingStop = false;
    engineLineBuffer = '';
    clearTimer('init');
    clearTimer('stop');
    clearTimer('watchdog');
    clearTimer('info');

    var cfg = activeBuildConfig();
    var worker;
    try {
      worker = new Worker(api.runtime.getURL(cfg.url));
    } catch (e) {
      starting = false;
      onStartupFailure('Не удалось запустить Stockfish: ' +
        (e && e.message ? e.message : 'ошибка Worker'));
      return;
    }

    engine = worker;
    engine.onmessage = function (event) {
      if (engine !== worker) return;
      var data = event && event.data;
      if (typeof data !== 'string') {
        if (data && typeof data.data === 'string') data = data.data;
        else return;
      }
      feedEngineData(data);
    };

    engine.onerror = function (event) {
      if (engine !== worker) return;
      onStartupFailure('Stockfish: ' + ((event && event.message) || 'ошибка Worker'));
    };

    engine.onmessageerror = function () {
      if (engine !== worker) return;
      onStartupFailure('Stockfish: повреждённое сообщение Worker');
    };

    initTimer = setTimeout(function () {
      initTimer = null;
      if (!ready && engine === worker) {
        onStartupFailure('Stockfish не ответил при запуске');
      }
    }, cfg.initTimeoutMs);

    try {
      engine.postMessage('uci');
    } catch (e) {
      onStartupFailure('Stockfish: не удалось отправить команду');
      return;
    }

    broadcastStatus();
  }

  /*
   * The full build is ~95 MB of WASM. If it cannot be loaded (very slow disk,
   * out of memory, file missing) fall back to the Lite build automatically
   * instead of leaving the user without an engine.
   */
  function onStartupFailure(message) {
    if (buildSetting === 'full' && !fullBuildFailed && !ready) {
      fullBuildFailed = true;
      restartEngine(false);
      note = 'Полный Stockfish не загрузился, включён Lite: ' + message;
      broadcastStatus();
      return;
    }
    onEngineFailure(message);
  }

  function onEngineFailure(message) {
    // If the engine had already answered, this is not a bad install: the
    // worker died mid-run. On a phone that is usually the system reclaiming
    // memory from the 96 MB build, so count it and switch to Lite after the
    // second death instead of restarting into the same wall.
    var wasReady = ready;
    error = message;
    var active = current;
    current = null;
    awaitingStop = false;
    clearTimer('init');
    clearTimer('stop');
    clearTimer('watchdog');
    clearTimer('info');

    if (active && !active.cancelled) sendError(active, message);
    if (pending) sendError(pending, message);

    var worker = engine;
    engine = null;
    ready = false;
    starting = false;
    if (worker) {
      try { worker.terminate(); } catch (e) { /* ignore */ }
    }
    // Whatever took the primary out may take the helpers too; they are cheap to
    // rebuild on the next long search and worthless if half of them are dead.
    destroyHelpers();

    var hasWork = !!(active || pending);
    if (wasReady && IS_MOBILE && buildSetting === 'full' && !fullBuildFailed) {
      mobileFullCrashes++;
      if (mobileFullCrashes >= MOBILE_FULL_CRASH_LIMIT) {
        fullBuildFailed = true;
        note = 'Полный Stockfish дважды выгружался на телефоне, включён Lite';
      }
    }
    broadcastStatus();

    if (hasWork) {
      scheduleRestart();
    } else {
      restartAttempts = 0;
    }
  }

  function scheduleRestart() {
    if (restartTimer || restartAttempts >= MAX_RESTARTS) return;
    var delay = Math.min(800 * Math.pow(1.8, restartAttempts), 6000);
    restartAttempts++;
    restartTimer = setTimeout(function () {
      restartTimer = null;
      ensureEngine();
    }, delay);
  }

  function feedEngineData(data) {
    engineLineBuffer += data;

    // A browser Worker normally posts one complete UCI line at a time. Some
    // wasm builds batch output, so handle both shapes and keep a partial line
    // for the next message.
    if (engineLineBuffer.indexOf('\n') < 0 && engineLineBuffer.indexOf('\r') < 0) {
      var single = engineLineBuffer.trim();
      engineLineBuffer = '';
      if (single) handleEngineLine(single);
      return;
    }

    var parts = engineLineBuffer.split(/\r\n|\n|\r/);
    engineLineBuffer = parts.pop() || '';
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i].trim();
      if (line) handleEngineLine(line);
    }
  }

  function handleEngineLine(line) {
    if (!line) return;

    if (line === 'uciok') {
      if (!engine) return;
      var cfg = activeBuildConfig();
      try {
        engine.postMessage('setoption name Hash value ' + hashMbFor(cfg));
        engine.postMessage('setoption name MultiPV value 1');
        engine.postMessage('setoption name Skill Level value 20');
        lastSkill = 20;
        engine.postMessage('ucinewgame');
        engine.postMessage('isready');
      } catch (e) {
        onEngineFailure('Stockfish: не удалось инициализировать движок');
      }
      return;
    }

    if (line === 'readyok') {
      if (!ready) {
        ready = true;
        starting = false;
        error = null;
        if (activeBuildId() === 'full') note = null;
        restartAttempts = 0;
        clearTimer('init');
        broadcastStatus();
        if (pending && !current) {
          var next = pending;
          pending = null;
          startRequest(next);
        }
      }
      return;
    }

    if (line.indexOf('info ') === 0) {
      if (!current || awaitingStop) return;
      handleInfo(line);
      return;
    }

    var best = parseBestMove(line);
    if (best !== null) {
      onBestMove(best);
    }
  }

  /* ------------------------------------------------- root-split parallelism */

  /*
   * How many engines this machine can feed. Under four cores there is nothing
   * to divide, and a phone gets one: several copies of the 96 MB network inside
   * a single tab is how a phone decides to kill the page.
   */
  function splitWidth() {
    if (IS_MOBILE) return 1;
    var cores = parseInt(
      (globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 0, 10
    );
    if (!cores || cores < 4) return 1;
    return Math.min(MAX_HELPERS + 1, Math.max(2, Math.floor(cores / 2)));
  }

  // Round-robin, so every worker gets both cheap and expensive moves instead of
  // one of them inheriting all the captures.
  function splitMoves(moves, parts) {
    var groups = [];
    for (var i = 0; i < parts; i++) groups.push([]);
    for (var j = 0; j < moves.length; j++) groups[j % parts].push(moves[j]);
    return groups;
  }

  /*
   * Scores from different workers are comparable because they come from the
   * same evaluation on the same position. Mate scores need converting: +M1 must
   * outrank +M7, and -M7 must outrank -M1.
   */
  function scoreValue(score) {
    if (!score || typeof score.value !== 'number') return null;
    if (score.type === 'mate') {
      return score.value >= 0 ? 100000 - score.value : -100000 - score.value;
    }
    return score.value;
  }

  function pickSplitWinner(results) {
    var best = null;
    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      if (!item || !item.uci || item.uci === '(none)') continue;
      var value = scoreValue(item.score);
      if (!best) {
        best = { item: item, value: value };
        continue;
      }
      if (value == null) continue;
      if (best.value == null || value > best.value) {
        best = { item: item, value: value };
        continue;
      }
      // Drawn positions produce identical scores all the time. Keeping the
      // primary's move stops the same position from answering differently on
      // every visit.
      if (value === best.value && item.index < best.item.index) {
        best = { item: item, value: value };
      }
    }
    return best ? best.item : null;
  }

  function parseHelperInfo(line) {
    if (line.indexOf('info ') !== 0) return null;
    var depth = /\bdepth (\d+)/.exec(line);
    var score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    if (!score) return null;
    return {
      depth: depth ? parseInt(depth[1], 10) : 0,
      score: { type: score[1], value: parseInt(score[2], 10) }
    };
  }

  // How much of that ceiling is actually up right now: a helper that is still
  // loading the network is not searching anything, and saying otherwise would
  // be a lie in the popup.
  function parallelWidth() {
    var count = 1;
    for (var i = 0; i < helpers.length; i++) {
      if (helpers[i].ready && !helpers[i].dead) count++;
    }
    return count;
  }

  function helperHashMb() {
    // The table is shared in a real SMP build; here each engine needs its own,
    // so the total stays what one engine had.
    var parts = Math.max(1, splitWidth());
    return Math.max(16, Math.floor(hashMbFor(activeBuildConfig()) / parts));
  }

  function createHelper() {
    var cfg = activeBuildConfig();
    var worker;
    try {
      worker = new Worker(api.runtime.getURL(cfg.url));
    } catch (e) {
      return null;
    }
    var helper = {
      worker: worker,
      ready: false,
      armed: false,     // we are waiting for its bestmove
      busy: false,      // it has a search in flight we no longer want
      dead: false,
      buffer: '',
      index: helpers.length + 1,
      best: null,
      score: null,
      depth: 0,
      onDone: null
    };
    worker.onmessage = function (event) {
      if (helper.dead) return;
      var data = event && event.data;
      if (typeof data !== 'string') {
        if (data && typeof data.data === 'string') data = data.data;
        else return;
      }
      feedHelper(helper, data);
    };
    worker.onerror = function () { dropHelper(helper); };
    worker.onmessageerror = function () { dropHelper(helper); };
    try {
      worker.postMessage('uci');
    } catch (e) {
      dropHelper(helper);
      return null;
    }
    helpers.push(helper);
    return helper;
  }

  function feedHelper(helper, data) {
    helper.buffer += data;
    var parts = helper.buffer.split(/\r?\n/);
    helper.buffer = parts.pop();
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i].trim();
      if (!line) continue;
      if (line === 'uciok') {
        try {
          helper.worker.postMessage('setoption name Hash value ' + helperHashMb());
          helper.worker.postMessage('setoption name MultiPV value 1');
          helper.worker.postMessage('isready');
        } catch (e) {
          dropHelper(helper);
          return;
        }
        continue;
      }
      if (line === 'readyok') {
        helper.ready = true;
        // The popup and the chip both report how much of the ceiling is up.
        broadcastStatus();
        continue;
      }
      if (line.indexOf('info ') === 0) {
        var info = parseHelperInfo(line);
        if (info) {
          helper.score = info.score;
          helper.depth = info.depth;
        }
        continue;
      }
      if (line.indexOf('bestmove') === 0) {
        helper.busy = false;
        if (!helper.armed) continue;
        helper.armed = false;
        helper.best = parseBestMove(line);
        var done = helper.onDone;
        helper.onDone = null;
        if (done) done(helper);
      }
    }
  }

  function dropHelper(helper) {
    if (!helper || helper.dead) return;
    helper.dead = true;
    helper.armed = false;
    helper.busy = false;
    helper.onDone = null;
    try { helper.worker.terminate(); } catch (e) { /* already gone */ }
    var at = helpers.indexOf(helper);
    if (at >= 0) helpers.splice(at, 1);
    for (var i = 0; i < helpers.length; i++) helpers[i].index = i + 1;
  }

  function destroyHelpers() {
    var list = helpers.slice();
    helpers.length = 0;
    for (var i = 0; i < list.length; i++) {
      var helper = list[i];
      helper.dead = true;
      helper.armed = false;
      helper.busy = false;
      helper.onDone = null;
      try { helper.worker.terminate(); } catch (e) { /* already gone */ }
    }
  }

  function ensureHelpers(count) {
    for (var i = helpers.length; i < count; i++) {
      if (!createHelper()) break;
    }
  }

  /*
   * Workers are spawned after a long search finishes, never during one: the
   * opponent is thinking then, so the CPU is idle anyway and the next move
   * starts with them warm.
   */
  function warmHelpers() {
    if (!ready || error || restartTimer || starting) return;
    var width = splitWidth();
    if (width < 2) return;
    if (helpers.length >= width - 1) return;
    ensureHelpers(width - 1);
    broadcastStatus();
  }

  function planSplit(request) {
    // MultiPV already spends the same time on alternatives, and the humanized
    // presets deliberately play below their best move: handing the choice to a
    // score comparison would break both.
    if (request.multiPV > 1) return null;
    if (request.skill < 20) return null;
    if (request.movetime < SPLIT_MIN_MOVETIME) return null;
    var width = splitWidth();
    if (width < 2) return null;
    var moves = request.rootMoves || [];
    if (moves.length < width * 2) return null;

    var pool = [];
    for (var i = 0; i < helpers.length && pool.length < width - 1; i++) {
      var helper = helpers[i];
      if (helper.ready && !helper.armed && !helper.busy && !helper.dead) pool.push(helper);
    }
    if (!pool.length) return null;

    return {
      helpers: pool,
      groups: splitMoves(moves, pool.length + 1),
      results: [],
      done: 0,
      finished: false,
      timer: null
    };
  }

  function startHelperSearch(request, helper, moves) {
    if (!helper || helper.dead || !moves || !moves.length) return;
    helper.armed = true;
    helper.busy = true;
    helper.best = null;
    helper.score = null;
    helper.depth = 0;
    helper.onDone = function (finished) {
      if (current === request && request.split) recordSplitResult(request, finished);
    };
    try {
      helper.worker.postMessage('position fen ' + request.fen);
      helper.worker.postMessage('go movetime ' + request.movetime +
        ' searchmoves ' + moves.join(' '));
    } catch (e) {
      dropHelper(helper);
    }
  }

  function recordSplitResult(request, helper) {
    var split = request.split;
    if (!split || split.finished) return;
    split.results.push({
      uci: helper.best,
      score: helper.score,
      depth: helper.depth,
      index: helper.index
    });
    split.done++;
    if (split.done >= split.helpers.length + 1) finalizeSplit(request);
  }

  // Stop the helpers of a search whose answer can no longer be published, but
  // keep them in flight until their bestmove arrives: arming one that is still
  // searching would credit its old move to the next position.
  function stopSplitHelpers(request) {
    var split = request && request.split;
    if (!split) return;
    for (var i = 0; i < split.helpers.length; i++) {
      var helper = split.helpers[i];
      helper.onDone = null;
      if (!helper.armed) continue;
      helper.armed = false;
      try { helper.worker.postMessage('stop'); } catch (e) { /* gone */ }
    }
  }

  function releaseSplit(request) {
    var split = request && request.split;
    if (!split) return;
    if (split.timer) { clearTimeout(split.timer); split.timer = null; }
    split.finished = true;
    stopSplitHelpers(request);
  }

  function finalizeSplit(request) {
    var split = request.split;
    if (!split || split.finished) return;
    split.finished = true;
    if (split.timer) { clearTimeout(split.timer); split.timer = null; }
    stopSplitHelpers(request);

    var winner = pickSplitWinner(split.results);
    if (winner && winner.index > 0) {
      // The move came from a helper, so the primary's lines describe a
      // different part of the tree. Publish the winner's own evaluation.
      request.lines = [];
      request.lines[1] = {
        multipv: 1,
        depth: winner.depth || 0,
        seldepth: null,
        score: winner.score || null,
        pv: winner.uci ? [winner.uci] : []
      };
    }
    closeSearch(winner ? winner.uci : '');
  }

  /* -------------------------------------------------------------- searching */

  function normalizeRootMoves(value) {
    if (!value || !value.length) return null;
    var out = [];
    for (var i = 0; i < value.length && out.length < 40; i++) {
      var uci = String(value[i] || '');
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) continue;
      out.push(uci);
    }
    return out.length ? out : null;
  }

  function normalizeRequest(data, port) {
    if (!data || typeof data.fen !== 'string') return null;
    var fen = data.fen.trim().replace(/\s+/g, ' ');
    var fields = fen.split(' ');
    if (fields.length < 2) return null;
    if (fields[0].split('/').length !== 8) return null;
    if (fields[1] !== 'w' && fields[1] !== 'b') return null;
    if (fen.length > 120) return null;

    return {
      id: data.id,
      port: port,
      fen: fen,
      multiPV: clampInt(data.multiPV, 1, 6),
      movetime: clampInt(data.movetime, 100, MAX_MOVETIME),
      depth: clampInt(data.depth, 0, 60),
      skill: data.skill == null || data.skill === '' ? 20 : clampInt(data.skill, 0, 20),
      rootMoves: normalizeRootMoves(data.rootMoves),
      split: null,
      lines: [],
      cancelled: false,
      startedAt: 0
    };
  }

  function startRequest(request) {
    if (!request) return;
    if (!engine || !ready) {
      pending = request;
      ensureEngine();
      broadcastStatus();
      return;
    }
    if (current) {
      pending = request;
      requestStop();
      return;
    }

    clearTimer('watchdog');
    clearTimer('stop');
    clearTimer('info');
    awaitingStop = false;
    error = null;
    request.startedAt = Date.now();
    current = request;

    // Decide the division of labour before the first command goes out: the
    // primary has to be given its own share of the root moves in the same "go".
    var split = request.split = planSplit(request);
    var primary = split ? split.groups[0] : null;

    if (lastMultiPV !== request.multiPV) {
      lastMultiPV = request.multiPV;
      engine.postMessage('setoption name MultiPV value ' + request.multiPV);
    }
    // Skill Level is the engine's own strength limiter. It is set between
    // searches, never during one.
    if (lastSkill !== request.skill) {
      lastSkill = request.skill;
      engine.postMessage('setoption name Skill Level value ' + request.skill);
    }

    try {
      engine.postMessage('position fen ' + request.fen);
      // UCI eats the token that stops the move list: "searchmoves" has to come
      // last, or the limit after it is swallowed and the search never ends on
      // time.
      var go = 'go';
      if (request.depth > 0) go += ' depth ' + request.depth;
      go += ' movetime ' + request.movetime;
      if (primary) go += ' searchmoves ' + primary.join(' ');
      engine.postMessage(go);
    } catch (e) {
      onEngineFailure('Stockfish: не удалось начать поиск');
      return;
    }

    var limit = request.movetime + 7000;
    if (request.depth > 0) limit += 4000;
    watchdogTimer = setTimeout(function () {
      watchdogTimer = null;
      if (current === request && !awaitingStop) {
        onEngineFailure('Stockfish не ответил за ' + Math.round(limit / 1000) + ' с');
      }
    }, limit);

    if (split) {
      for (var i = 0; i < split.helpers.length; i++) {
        startHelperSearch(request, split.helpers[i], split.groups[i + 1]);
      }
      // The merge cannot wait for a worker that has gone quiet. This is a stop
      // like any other, so the primary's own bestmove remains the trigger - it
      // is the last answer to arrive, and whoever is asking still gets one.
      split.timer = setTimeout(function () {
        split.timer = null;
        if (current !== request || awaitingStop || request.cancelled) return;
        split.timedOut = true;
        requestStop();
      }, request.movetime + SPLIT_GRACE_MS);
    }

    broadcastStatus();
  }

  function requestStop() {
    if (awaitingStop) return;
    awaitingStop = true;
    if (current) stopSplitHelpers(current);
    try {
      if (engine) engine.postMessage('stop');
    } catch (e) { /* the stop watchdog will restart the engine */ }

    clearTimer('stop');
    stopTimer = setTimeout(function () {
      stopTimer = null;
      if (awaitingStop) onEngineFailure('Stockfish не остановился');
    }, 4500);

    broadcastStatus();
  }

  function handleInfo(line) {
    var parsed = parseInfo(line);
    if (!parsed || !parsed.pv || !parsed.pv.length) return;

    var request = current;
    if (!request) return;
    var index = parsed.multipv > 0 ? parsed.multipv : 1;
    request.lines[index] = {
      multipv: index,
      depth: parsed.depth || 0,
      seldepth: parsed.seldepth || null,
      score: parsed.score || null,
      pv: parsed.pv.slice(0, INFO_PV_LIMIT)
    };

    if (!infoTimer) {
      infoTimer = setTimeout(function () {
        infoTimer = null;
        flushLines(current);
      }, INFO_THROTTLE_MS);
    }
  }

  function collectLines(request) {
    if (!request) return [];
    var lines = [];
    for (var i = 0; i < request.lines.length; i++) {
      var line = request.lines[i];
      if (line && line.pv && line.pv.length) lines.push(line);
    }
    lines.sort(function (a, b) { return a.multipv - b.multipv; });
    return lines;
  }

  function flushLines(request) {
    if (!request || request.cancelled) return;
    var lines = collectLines(request);
    if (!lines.length) return;
    send(request.port, {
      type: 'analysis',
      id: request.id,
      fen: request.fen,
      lines: lines
    });
  }

  function onBestMove(uci) {
    var request = current;
    var split = request && request.split;

    if (request && split && !split.finished && !request.cancelled) {
      // A deadline stop is ours, not the user's: the primary's answer still
      // counts even though a stop is technically in flight.
      var usable = !awaitingStop || (split.timedOut && !pending);
      if (usable) {
        if (awaitingStop) awaitingStop = false;
        var lines = collectLines(request);
        split.results.push({
          uci: uci,
          score: lines.length ? lines[0].score : null,
          depth: lines.length ? lines[0].depth : 0,
          index: 0
        });
        split.done++;
        if (split.timedOut || split.done >= split.helpers.length + 1) {
          finalizeSplit(request);
        }
        return;
      }
    }

    closeSearch(uci);
  }

  function closeSearch(uci) {
    clearTimer('watchdog');
    clearTimer('stop');
    clearTimer('info');

    var request = current;
    current = null;
    var wasStopping = awaitingStop;
    awaitingStop = false;

    // Never publish a stale result after stop/replace/cancel.
    if (request && !wasStopping && !request.cancelled) {
      flushLines(request);
      if (uci) {
        send(request.port, {
          type: 'bestmove',
          id: request.id,
          fen: request.fen,
          uci: uci
        });
      } else {
        sendError(request, 'В позиции нет доступных ходов');
      }
    }
    if (request) releaseSplit(request);

    broadcastStatus();

    var next = pending;
    pending = null;
    if (next) startRequest(next);
    // A long search just proved this machine has time to spend, and the
    // opponent is thinking now: this is the moment to load the extra workers.
    else if (request && request.movetime >= SPLIT_SPAWN_MOVETIME) warmHelpers();
  }

  /* ------------------------------------------------------------ port routing */

  function cancelRequest(request, notify) {
    if (!request) return;
    request.cancelled = true;
    if (notify) {
      send(request.port, { type: 'cancelled', id: request.id });
    }
  }

  function handleAnalyze(port, data) {
    var request = normalizeRequest(data, port);
    if (!request) {
      send(port, {
        type: 'error',
        id: data && data.id,
        message: 'Некорректная позиция для анализа'
      });
      return;
    }

    ensureEngine();

    if (!ready) {
      pending = request;
      broadcastStatus();
      return;
    }

    if (current || awaitingStop) {
      // Only the newest position matters. Tell other tabs that their search
      // was superseded so their HUD does not stay in "thinking" forever.
      if (current && current.port !== port) {
        cancelRequest(current, true);
      }
      pending = request;
      if (!awaitingStop) requestStop();
      else broadcastStatus();
      return;
    }

    startRequest(request);
  }

  function handleStop(port) {
    var touched = false;

    if (current && current.port === port) {
      cancelRequest(current, true);
      if (pending && pending.port === port) pending = null;
      if (!awaitingStop) requestStop();
      touched = true;
    } else if (pending && pending.port === port) {
      send(port, { type: 'cancelled', id: pending.id });
      pending = null;
      touched = true;
    }

    if (touched) broadcastStatus();
  }

  function handlePortDisconnect(port) {
    ports.delete(port);
    var touched = false;

    if (current && current.port === port) {
      cancelRequest(current, false);
      if (!awaitingStop) requestStop();
      touched = true;
    }
    if (pending && pending.port === port) {
      pending = null;
      touched = true;
    }
    if (touched) broadcastStatus();
  }

  /* --------------------------------------------------------- tablebase */

  /*
   * Perfect endgame play without shipping the tables. A position with seven
   * pieces or fewer has an exact answer, and the Lichess tablebase serves it
   * over HTTPS. The request is made here rather than in the content script:
   * the background page has the host permission, is not subject to the page's
   * origin rules, and behaves identically on desktop and Android. Shipping
   * Syzygy instead would mean ~1 GB for five pieces and ~150 GB for six, which
   * is far outside both the package limit and a phone's memory.
   */
  var TB_ENDPOINT = 'https://tablebase.lichess.ovh/standard?fen=';
  var TB_TIMEOUT_MS = 4000;
  var TB_CACHE_MAX = 512;
  var tbCache = Object.create(null);
  var tbCacheKeys = [];

  function tbRemember(key, data) {
    if (tbCache[key]) return;
    tbCache[key] = data;
    tbCacheKeys.push(key);
    while (tbCacheKeys.length > TB_CACHE_MAX) {
      var old = tbCacheKeys.shift();
      delete tbCache[old];
    }
  }

  function tbReply(respond, payload) {
    try { respond(payload); } catch (e) { /* channel already closed */ }
  }

  function tablebaseQuery(fen, respond) {
    var key = String(fen || '').trim();
    if (!key) {
      tbReply(respond, { ok: false, error: 'empty fen' });
      return;
    }
    if (tbCache[key]) {
      tbReply(respond, { ok: true, data: tbCache[key], cached: true });
      return;
    }
    var url = TB_ENDPOINT + encodeURIComponent(key);
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      tbReply(respond, { ok: false, error: 'timeout' });
    }, TB_TIMEOUT_MS);

    fetch(url, { credentials: 'omit', cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!data || !data.moves) throw new Error('empty answer');
      tbRemember(key, data);
      tbReply(respond, { ok: true, data: data });
    }).catch(function (err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tbReply(respond, {
        ok: false,
        error: String((err && err.message) || err || 'failed')
      });
    });
  }

  api.runtime.onConnect.addListener(function (port) {
    if (!port || port.name !== 'ca-engine') return;
    ports.add(port);
    ensureEngine();
    send(port, statusMessage());

    port.onMessage.addListener(function (message) {
      if (!message || !message.type) return;

      if (message.type === 'analyze') {
        handleAnalyze(port, message);
        return;
      }
      if (message.type === 'stop') {
        handleStop(port);
        return;
      }
      if (message.type === 'ping' || message.type === 'status') {
        send(port, statusMessage());
      }
    });

    port.onDisconnect.addListener(function () {
      handlePortDisconnect(port);
    });
  });

  api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === 'ca-engine-status') {
      var cfg = activeBuildConfig();
      sendResponse({
        ready: !!(ready && !error),
        starting: !!starting,
        searching: !!(current || awaitingStop || pending),
        error: error || null,
        note: note || null,
        engine: cfg.label,
        build: activeBuildId(),
        buildSetting: buildSetting,
        mobile: IS_MOBILE,
        hashMb: hashMbFor(cfg),
        maxMovetime: MAX_MOVETIME,
        multipv: lastMultiPV,
        skill: lastSkill
      });
      return true;
    }

    if (message.type === 'ca-tablebase') {
      tablebaseQuery(message.fen, sendResponse);
      return true;
    }

    if (message.type === 'ca-engine-restart') {
      var build = message.build === 'full' || message.build === 'lite'
        ? message.build
        : buildSetting;
      restartEngine(true, build);
      sendResponse({ ok: true, build: activeBuildId(), buildSetting: buildSetting });
      return true;
    }
  });

  if (api.storage && api.storage.onChanged) {
    // The popup restarts the engine explicitly (ca-engine-restart) after it
    // saves a new build, so this listener only keeps the setting in sync.
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes || !changes.engineBuild) return;
      var value = changes.engineBuild.newValue;
      buildSetting = value === 'lite' ? 'lite' : 'full';
    });
  }

  // The persistent background page starts idly. The engine is created when a
  // chess tab connects, so browsing without a board costs no WASM memory.
  loadBuildSetting();
  broadcastStatus();
})();
