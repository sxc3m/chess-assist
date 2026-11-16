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
      skill: lastSkill
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

  /* -------------------------------------------------------------- searching */

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
      if (request.depth > 0) {
        engine.postMessage('go depth ' + request.depth + ' movetime ' + request.movetime);
      } else {
        engine.postMessage('go movetime ' + request.movetime);
      }
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

    broadcastStatus();
  }

  function requestStop() {
    if (awaitingStop) return;
    awaitingStop = true;
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

    broadcastStatus();

    var next = pending;
    pending = null;
    if (next) startRequest(next);
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
