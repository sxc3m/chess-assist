/* Chess Assist - popup controller. */
(function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  if (!api) return;

  var DEFAULTS = {
    enabled: true,
    side: 'auto',
    seedTurn: 'w',
    showOpponent: true,
    showArrow: true,
    showHud: true,
    hideOverlay: false,
    autoPlay: false,
    autoPlayDelayMs: 700,
    multiPV: 1,
    movetimeMs: 1200,
    engineSkill: 20,
    engineDepth: 0,
    humanize: false,
    humanizeErrorPct: 25,
    humanizeMaxLossCp: 45,
    humanizeBlunderPct: 0,
    humanizeAdaptive: true,
    humanizeRating: 0,
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
    humanizeClockAware: true,
    engineBuild: 'full',
    autoRematch: false,
    humanInput: false,
    tablebase: false
  };

  var settings = Object.assign({}, DEFAULTS);
  var IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(
    (globalThis.navigator && navigator.userAgent) || ''
  );
  var tabId = null;
  var contentState = null;
  var engineStatus = null;
  var transientError = '';
  var transientTimer = null;
  var configTimer = null;
  var pollTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function formatSeconds(ms) {
    var value = (ms / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return value.replace('.', ',') + ' с';
  }

  function formatPawns(cp) {
    return '-' + (Number(cp) / 100).toFixed(1);
  }

  function updateRangeFill(input) {
    if (!input) return;
    var min = parseFloat(input.min);
    var max = parseFloat(input.max);
    var value = parseFloat(input.value);
    if (!isFinite(min) || !isFinite(max) || !isFinite(value) || max <= min) return;
    var pct = ((value - min) / (max - min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  }

  function friendlySite(id) {
    if (id === 'chesscom' || id === 'chess.com') return 'chess.com';
    if (id === 'lichess') return 'lichess.org';
    return id || 'сайт';
  }

  function scoreTone(text) {
    if (!text) return 'idle';
    var first = text.charAt(0);
    if (first === '+') return 'pos';
    if (first === '-' || first === '\u2212') return 'neg';
    if (first === '#') return text.charAt(1) === '-' ? 'neg' : 'pos';
    return 'idle';
  }

  function setText(id, value) {
    var node = $(id);
    var text = value == null ? '' : String(value);
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setDot(mode) {
    var dot = $('engineDot');
    if (!dot) return;
    dot.className = 'dot' + (mode ? ' is-' + mode : '');
  }

  function showError(message) {
    transientError = message || '';
    if (transientTimer) clearTimeout(transientTimer);
    if (message) {
      transientTimer = setTimeout(function () {
        transientTimer = null;
        transientError = '';
        render();
      }, 4500);
    }
    render();
  }

  /* --------------------------------------------------------------- settings */

  function save(patch, skipSync) {
    Object.assign(settings, patch);
    if (!skipSync) syncControls();
    try {
      var result = api.storage.local.set(patch);
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function setSegmented(groupId, value) {
    var group = $(groupId);
    if (!group) return;
    var buttons = group.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute('data-value') === value;
      buttons[i].classList.toggle('is-active', active);
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function syncControls() {
    if (IS_MOBILE) {
      // Both builds ship on the phone now. The size note would just be noise
      // there, so the option is renamed instead of removed.
      var full = document.querySelector('#engineBuild option[value="full"]');
      if (full) full.textContent = 'Stockfish 19 NNUE — максимум';
    }
    $('enabled').checked = !!settings.enabled;
    setSegmented('sideGroup', settings.side);
    setSegmented('seedGroup', settings.seedTurn);

    var hideUi = !!settings.hideOverlay;
    $('hideOverlay').checked = hideUi;
    $('showArrow').checked = !!settings.showArrow;
    $('showHud').checked = !!settings.showHud;
    $('showOpponent').checked = !!settings.showOpponent;
    $('autoPlay').checked = !!settings.autoPlay;
    $('autoRematch').checked = !!settings.autoRematch;
    $('humanInput').checked = !!settings.humanInput;
    $('tablebase').checked = !!settings.tablebase;

    var uiRows = document.querySelectorAll('[data-ui-row]');
    for (var i = 0; i < uiRows.length; i++) {
      uiRows[i].classList.toggle('is-disabled', hideUi);
      var input = uiRows[i].querySelector('input');
      if (input) input.disabled = hideUi;
    }

    $('autoDelay').value = String(settings.autoPlayDelayMs);
    $('movetime').value = String(settings.movetimeMs);
    $('multiPV').value = String(settings.multiPV);
    if ($('engineBuild')) $('engineBuild').value = settings.engineBuild || 'full';
    $('engineSkill').value = String(settings.engineSkill);
    $('engineDepth').value = String(settings.engineDepth);

    $('humanize').checked = !!settings.humanize;
    $('humanizeAdaptive').checked = !!settings.humanizeAdaptive;
    $('humanizeRating').value = String(settings.humanizeRating);
    $('humanizeRescue').checked = !!settings.humanizeRescue;
    $('humanizeRescueCp').value = String(settings.humanizeRescueCp);
    $('humanizeRescueExitCp').value = String(settings.humanizeRescueExitCp);
    $('humanizeRescueMs').value = String(settings.humanizeRescueMs);
    $('humanizeErrorPct').value = String(settings.humanizeErrorPct);
    $('humanizeMaxLossCp').value = String(settings.humanizeMaxLossCp);
    $('humanizeBlunderPct').value = String(settings.humanizeBlunderPct);
    $('humanizeMin').value = String(settings.humanizeMinMs);
    $('humanizeMax').value = String(settings.humanizeMaxMs);
    $('humanizeFastPct').value = String(settings.humanizeFastPct);
    $('humanizeFastMs').value = String(settings.humanizeFastMs);
    $('humanizeRarePct').value = String(settings.humanizeRarePct);
    $('humanizeRare').value = String(settings.humanizeRareMs);
    $('humanizeClockAware').checked = !!settings.humanizeClockAware;

    updateRangeFill($('autoDelay'));
    updateRangeFill($('movetime'));
    updateRangeFill($('engineSkill'));
    updateRangeFill($('engineDepth'));
    updateRangeFill($('humanizeErrorPct'));
    updateRangeFill($('humanizeMaxLossCp'));
    updateRangeFill($('humanizeBlunderPct'));
    updateRangeFill($('humanizeRating'));
    updateRangeFill($('humanizeRescueCp'));
    updateRangeFill($('humanizeRescueExitCp'));
    updateRangeFill($('humanizeRescueMs'));
    updateRangeFill($('humanizeMin'));
    updateRangeFill($('humanizeMax'));
    updateRangeFill($('humanizeFastPct'));
    updateRangeFill($('humanizeFastMs'));
    updateRangeFill($('humanizeRarePct'));
    updateRangeFill($('humanizeRare'));

    setText('delayOut', formatSeconds(settings.autoPlayDelayMs));
    setText('movetimeOut', formatSeconds(settings.movetimeMs));
    setText('engineSkillOut', String(settings.engineSkill));
    setText('engineDepthOut', settings.engineDepth > 0 ? 'гл. ' + settings.engineDepth : 'без лимита');
    setText('humanizeErrorPctOut', settings.humanizeErrorPct + ' %');
    setText('humanizeMaxLossCpOut', settings.humanizeMaxLossCp + ' ср');
    setText('humanizeBlunderPctOut', settings.humanizeBlunderPct + ' %');
    setText('humanizeRatingOut', settings.humanizeRating > 0
      ? String(settings.humanizeRating)
      : 'авто');
    setText('humanizeRescueCpOut', formatPawns(settings.humanizeRescueCp));
    setText('humanizeRescueExitCpOut', formatPawns(settings.humanizeRescueExitCp));
    setText('humanizeRescueMsOut', formatSeconds(settings.humanizeRescueMs));
    setText('humanizeMinOut', formatSeconds(settings.humanizeMinMs));
    setText('humanizeMaxOut', formatSeconds(settings.humanizeMaxMs));
    setText('humanizeFastPctOut', settings.humanizeFastPct + ' %');
    setText('humanizeFastMsOut', formatSeconds(settings.humanizeFastMs));
    setText('humanizeRarePctOut', settings.humanizeRarePct + ' %');
    setText('humanizeRareOut', formatSeconds(settings.humanizeRareMs));

    $('autoOptions').classList.toggle('is-hidden', !settings.autoPlay || !!settings.humanize);
    $('humanOptions').classList.toggle('is-hidden', !settings.humanize);
    document.body.classList.toggle('is-off', !settings.enabled);
  }

  function readHumanTimes() {
    var min = parseInt($('humanizeMin').value, 10);
    var max = parseInt($('humanizeMax').value, 10);
    var rare = parseInt($('humanizeRare').value, 10);
    if (!isFinite(min)) min = 5000;
    if (!isFinite(max)) max = 25000;
    if (!isFinite(rare)) rare = 40000;
    if (max < min) max = min;
    if (rare < max) rare = max;
    return { humanizeMinMs: min, humanizeMaxMs: max, humanizeRareMs: rare };
  }

  function saveHumanTimes() {
    save(readHumanTimes());
  }

  /*
   * The cushion needs hysteresis: the release threshold has to sit clearly
   * above (less negative than) the activation threshold, otherwise it would
   * switch off on the same eval that switched it on. Keep at least 0.25 pawns
   * of gap.
   */
  function readRescueTimes() {
    var enter = parseInt($('humanizeRescueCp').value, 10);
    var exit = parseInt($('humanizeRescueExitCp').value, 10);
    if (!isFinite(enter)) enter = 300;
    if (!isFinite(exit)) exit = 50;
    enter = Math.max(100, Math.min(1500, enter));
    exit = Math.max(0, Math.min(500, exit));
    if (exit > enter - 25) exit = Math.max(0, enter - 25);
    return { humanizeRescueCp: enter, humanizeRescueExitCp: exit };
  }

  function saveRescueTimes() {
    save(readRescueTimes());
  }

  /* ---------------------------------------------------------------- configs */

  var CONFIG_APP = 'chess-assist';
  var CONFIG_VERSION = 3;

  var LIMITS = {
    autoPlayDelayMs: [150, 5000],
    multiPV: [1, 3],
    movetimeMs: [300, 30000],
    engineSkill: [0, 20],
    engineDepth: [0, 40],
    humanizeErrorPct: [0, 100],
    humanizeMaxLossCp: [20, 500],
    humanizeBlunderPct: [0, 40],
    humanizeRating: [0, 3500],
    humanizeRescueCp: [100, 1500],
    humanizeRescueExitCp: [0, 500],
    humanizeRescueMs: [300, 5000],
    humanizeMinMs: [120, 30000],
    humanizeMaxMs: [200, 60000],
    humanizeRareMs: [300, 90000],
    humanizeRarePct: [0, 40],
    humanizeFastPct: [0, 70],
    humanizeFastMs: [120, 8000]
  };

  var ENUMS = {
    side: ['auto', 'w', 'b'],
    seedTurn: ['w', 'b'],
    engineBuild: ['full', 'lite']
  };

  /*
   * Ready-made profiles.
   *
   * The two "anti-ban" profiles are built from the same idea: the engine is
   * capped at a shallow depth (so it sees tactics like a human, not like a
   * 3000+ engine), the move is chosen from a wide MultiPV set with a centipawn
   * loss budget, and the clock use is tuned to the control. The goal is that a
   * post-game review with any engine shows the accuracy, mistake and blunder
   * rates of the stated rating, not a machine.
   *
   *   bullet - 1+0: ~0.5-1.6 s per move, mostly instant, rare short thinks.
   *            Tuned for a real ~1730 chess.com bullet account (~1850-1950
   *            Lichess): shallow search, visible but non-catastrophic errors.
   *   ten    - 10+0: ~1.5-13 s per move with occasional longer thinks.
   *            Tuned for the same player in a ~1900 rapid/blitz bracket.
   *
   * The "max" profile turns all of that off: full depth, full time, top line
   * only, no intentional errors.
   */
  var PRESETS = {
    bullet: {
      label: 'Пуля 1+0 (антибан)',
      settings: {
        enabled: true,
        side: 'auto',
        seedTurn: 'w',
        showArrow: true,
        showHud: true,
        hideOverlay: false,
        autoPlay: true,
        autoPlayDelayMs: 250,
        // No forecast while the opponent thinks. It would keep the engine busy
        // for seconds and force a stop-and-go handshake right before our own
        // move, which is exactly the latency a 1+0 game cannot pay.
        showOpponent: false,
        multiPV: 1,
        movetimeMs: 300,
        engineSkill: 20,
        // Search deep enough to see a two-move tactic, no deeper: the goal is
        // not to look like Stockfish, it is to stop walking into mates.
        engineDepth: 6,
        humanize: true,
        // Frequency of mistakes follows the account's rating (adaptive below),
        // while the size of any single slip is capped in content.js: a 320 cp
        // error at bullet speed is a piece, and that is what ended in a
        // suspension review.
        humanizeErrorPct: 60,
        humanizeMaxLossCp: 220,
        humanizeBlunderPct: 4,
        humanizeAdaptive: true,
        humanizeRating: 0,
        humanizeRescue: true,
        humanizeRescueCp: 250,
        humanizeRescueExitCp: 40,
        humanizeRescueMs: 900,
        // Fast, but not a metronome: 0.15-1.0 s with half the moves in the
        // first 0.4 s, and a 3% two-second think on a hard position. Constant
        // sub-second taps on every move is its own pattern.
        humanizeMinMs: 150,
        humanizeMaxMs: 1000,
        humanizeRareMs: 2000,
        humanizeRarePct: 3,
        humanizeFastPct: 50,
        humanizeFastMs: 400,
        humanizeClockAware: true,
        tablebase: false,
        engineBuild: 'full'
      }
    },
    blitz: {
      label: 'Блиц 3+0',
      settings: {
        enabled: true,
        side: 'auto',
        seedTurn: 'w',
        showArrow: true,
        showHud: true,
        hideOverlay: false,
        autoPlay: true,
        autoPlayDelayMs: 300,
        showOpponent: false,
        multiPV: 1,
        movetimeMs: 900,
        engineSkill: 20,
        // 3+0 is the honest place for a high rating: there is time to search a
        // position properly, and a 1-3 s pause is what a human actually takes.
        // The depth comes from the profile table, which follows the account.
        engineDepth: 10,
        humanize: true,
        humanizeErrorPct: 50,
        humanizeMaxLossCp: 160,
        humanizeBlunderPct: 2,
        humanizeAdaptive: true,
        humanizeRating: 0,
        humanizeRescue: true,
        humanizeRescueCp: 250,
        humanizeRescueExitCp: 40,
        humanizeRescueMs: 1200,
        humanizeMinMs: 400,
        humanizeMaxMs: 3500,
        humanizeRareMs: 8000,
        humanizeRarePct: 4,
        humanizeFastPct: 40,
        humanizeFastMs: 900,
        humanizeClockAware: true,
        tablebase: false,
        engineBuild: 'full'
      }
    },
    ten: {
      label: '10 минут (антибан)',
      settings: {
        enabled: true,
        side: 'auto',
        seedTurn: 'w',
        showOpponent: true,
        showArrow: true,
        showHud: true,
        hideOverlay: false,
        autoPlay: true,
        autoPlayDelayMs: 700,
        multiPV: 1,
        movetimeMs: 900,
        engineSkill: 20,
        engineDepth: 6,
        humanize: true,
        humanizeErrorPct: 55,
        humanizeMaxLossCp: 250,
        humanizeBlunderPct: 4,
        humanizeAdaptive: true,
        humanizeRating: 0,
        humanizeRescue: true,
        humanizeRescueCp: 250,
        humanizeRescueExitCp: 40,
        humanizeRescueMs: 1400,
        humanizeMinMs: 1500,
        humanizeMaxMs: 13000,
        humanizeRareMs: 26000,
        humanizeRarePct: 4,
        humanizeFastPct: 30,
        humanizeFastMs: 1500,
        humanizeClockAware: true,
        tablebase: false,
        engineBuild: 'full'
      }
    },
    max: {
      label: 'Максимум (без ошибок)',
      settings: {
        enabled: true,
        side: 'auto',
        seedTurn: 'w',
        showOpponent: false,
        showArrow: true,
        showHud: true,
        hideOverlay: false,
        autoPlay: true,
        autoPlayDelayMs: 150,
        multiPV: 1,
        // The search time is not fixed any more: with humanization off the
        // controller spends a sixtieth of the remaining clock per move (see
        // requestAnalysis), so a 3+0 game searches seconds and a 1+0 game
        // cannot flag. 300 is only the floor and the fallback when the clock
        // cannot be read.
        movetimeMs: 300,
        engineSkill: 20,
        engineDepth: 0,
        humanize: false,
        humanizeErrorPct: 0,
        humanizeMaxLossCp: 20,
        humanizeBlunderPct: 0,
        humanizeAdaptive: false,
        humanizeRating: 0,
        humanizeRescue: false,
        humanizeRescueCp: 250,
        humanizeRescueExitCp: 40,
        humanizeRescueMs: 1400,
        humanizeMinMs: 1500,
        humanizeMaxMs: 9000,
        humanizeRareMs: 20000,
        humanizeRarePct: 0,
        humanizeFastPct: 0,
        humanizeFastMs: 600,
        humanizeClockAware: true,
        // The only preset that uses the endgame tables: perfect play from
        // seven pieces down, which is exactly where a strong engine still
        // gives away half-points by playing a "good" move instead of the exact
        // one. Off everywhere else on purpose.
        tablebase: true,
        engineBuild: 'full'
      }
    },
    master: {
      label: 'Скрытый мастер 2700',
      settings: {
        enabled: true,
        side: 'auto',
        seedTurn: 'w',
        showArrow: true,
        showHud: true,
        hideOverlay: false,
        autoPlay: true,
        autoPlayDelayMs: 250,
        showOpponent: false,
        multiPV: 1,
        movetimeMs: 1200,
        engineSkill: 20,
        // Depth comes from the 2700 row of the profile table (12-13), so the
        // search is capped instead of running to whatever the clock allows.
        engineDepth: 0,
        humanize: true,
        humanizeErrorPct: 48,
        humanizeMaxLossCp: 160,
        humanizeBlunderPct: 1.5,
        humanizeAdaptive: true,
        // Manual anchor: the whole premise of this preset is playing at master
        // level on a fresh account, so the site rating must not pull it down.
        humanizeRating: 2700,
        humanizeRescue: true,
        humanizeRescueCp: 250,
        humanizeRescueExitCp: 40,
        humanizeRescueMs: 1200,
        // A master in bullet thinks in tenths, but not uniformly: 0.3-2.4 s,
        // with 5% of positions getting a real 3-6 s look.
        humanizeMinMs: 300,
        humanizeMaxMs: 2400,
        humanizeRareMs: 6000,
        humanizeRarePct: 5,
        humanizeFastPct: 35,
        humanizeFastMs: 700,
        humanizeClockAware: true,
        tablebase: false,
        engineBuild: 'full'
      }
    }
  };

  function settingsSnapshot() {
    var out = {};
    for (var key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) out[key] = settings[key];
    }
    return out;
  }

  function clampSetting(key, value) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return null;
    var range = LIMITS[key];
    if (!range) return n;
    return Math.max(range[0], Math.min(range[1], n));
  }

  /*
   * Accept either the exported envelope ({app, version, settings}) or a bare
   * settings object. Unknown keys and wrong types are dropped; numbers are
   * clamped to the ranges the popup can represent.
   */
  function normalizeSettings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.settings && typeof raw.settings === 'object') raw = raw.settings;

    var out = {};
    for (var key in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      var def = DEFAULTS[key];
      var value = raw[key];
      if (typeof def === 'boolean') {
        if (typeof value === 'boolean') out[key] = value;
      } else if (typeof def === 'number') {
        var n = clampSetting(key, value);
        if (n != null) out[key] = n;
      } else if (typeof def === 'string') {
        if (typeof value !== 'string') continue;
        var allowed = ENUMS[key];
        if (allowed && allowed.indexOf(value) < 0) continue;
        out[key] = value;
      }
    }
    if (!Object.keys(out).length) return null;

    // Keep the human timing windows in a sane order after any partial import.
    var effective = Object.assign({}, settings, out);
    if (effective.humanizeMaxMs < effective.humanizeMinMs) {
      effective.humanizeMaxMs = effective.humanizeMinMs;
      if (out.humanizeMaxMs != null) out.humanizeMaxMs = effective.humanizeMaxMs;
    }
    if (effective.humanizeRareMs < effective.humanizeMaxMs) {
      effective.humanizeRareMs = effective.humanizeMaxMs;
      if (out.humanizeRareMs != null) out.humanizeRareMs = effective.humanizeRareMs;
    }
    // Cushion hysteresis: the release eval must be clearly closer to zero than
    // the activation eval, whatever the imported pair says.
    if (effective.humanizeRescueExitCp > effective.humanizeRescueCp - 25) {
      effective.humanizeRescueExitCp = Math.max(0, effective.humanizeRescueCp - 25);
      if (out.humanizeRescueExitCp != null) {
        out.humanizeRescueExitCp = effective.humanizeRescueExitCp;
      }
    }
    return out;
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }, function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function setConfigStatus(message, isError) {
    var node = $('configStatus');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('is-error', !!isError);
    if (configTimer) clearTimeout(configTimer);
    if (message) {
      configTimer = setTimeout(function () {
        configTimer = null;
        node.textContent = '';
        node.classList.remove('is-error');
      }, 6000);
    }
  }

  function openConfigPaste(value, message) {
    var area = $('configPaste');
    if (!area) return;
    $('configText').value = value || '';
    area.classList.remove('is-hidden');
    setConfigStatus(message || 'Вставь JSON и нажми «Применить»', false);
    try { $('configText').focus(); } catch (e) { /* ignore */ }
  }

  function applyPreset(key) {
    var preset = PRESETS[key];
    if (!preset) return;
    save(Object.assign({}, preset.settings));
    setConfigStatus('Применён пресет «' + preset.label + '»');
  }

  function applyConfigText(text) {
    var parsed;
    try {
      parsed = JSON.parse(String(text || ''));
    } catch (e) {
      setConfigStatus('Это не JSON — проверь текст конфига', true);
      return false;
    }
    var normalized = normalizeSettings(parsed);
    if (!normalized) {
      setConfigStatus('В конфиге нет подходящих настроек', true);
      return false;
    }
    save(normalized);
    var paste = $('configPaste');
    if (paste) paste.classList.add('is-hidden');
    var area = $('configText');
    if (area) area.value = '';
    setConfigStatus('Импортировано настроек: ' + Object.keys(normalized).length + '. Обнови вкладку с шахматами.');
    return true;
  }

  function exportConfig() {
    var payload = {
      app: CONFIG_APP,
      type: 'settings',
      version: CONFIG_VERSION,
      exportedAt: new Date().toISOString(),
      settings: settingsSnapshot()
    };
    var text = JSON.stringify(payload, null, 2);
    copyText(text).then(function (ok) {
      if (ok) {
        setConfigStatus('Конфиг скопирован в буфер');
      } else {
        openConfigPaste(text, 'Скопируй текст ниже вручную (буфер недоступен)');
        setConfigStatus('Буфер недоступен — скопируй текст ниже', true);
      }
    });
  }

  function importConfig() {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      openConfigPaste('', 'Вставь JSON и нажми «Применить»');
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      if (!text || !String(text).trim()) {
        openConfigPaste('', 'Буфер пуст — вставь JSON вручную');
        return;
      }
      applyConfigText(text);
    }, function () {
      openConfigPaste('', 'Браузер не дал прочитать буфер — вставь JSON вручную');
    });
  }

  function bindControls() {
    $('enabled').addEventListener('change', function (event) {
      save({ enabled: !!event.target.checked });
    });

    $('sideGroup').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-value]');
      if (!button) return;
      save({ side: button.getAttribute('data-value') });
    });

    $('seedGroup').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-value]');
      if (!button) return;
      var value = button.getAttribute('data-value');
      var changed = settings.seedTurn !== value;
      save({ seedTurn: value });
      // Clicking the already selected value produces no storage event, but the
      // user still expects the current position to switch to that side.
      if (!changed) action('ca-set-turn', { turn: value });
    });

    $('turnGroup').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-value]');
      if (!button) return;
      action('ca-set-turn', { turn: button.getAttribute('data-value') });
    });

    $('hideOverlay').addEventListener('change', function (event) {
      save({ hideOverlay: !!event.target.checked });
    });
    $('showArrow').addEventListener('change', function (event) {
      save({ showArrow: !!event.target.checked });
    });
    $('showHud').addEventListener('change', function (event) {
      save({ showHud: !!event.target.checked });
    });
    $('showOpponent').addEventListener('change', function (event) {
      save({ showOpponent: !!event.target.checked });
    });
    $('autoPlay').addEventListener('change', function (event) {
      save({ autoPlay: !!event.target.checked });
    });
    $('autoRematch').addEventListener('change', function (event) {
      save({ autoRematch: !!event.target.checked });
    });
    $('humanInput').addEventListener('change', function (event) {
      save({ humanInput: !!event.target.checked });
    });
    $('tablebase').addEventListener('change', function (event) {
      save({ tablebase: !!event.target.checked });
    });

    $('autoDelay').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('delayOut', formatSeconds(parseInt(event.target.value, 10)));
    });
    $('autoDelay').addEventListener('change', function (event) {
      save({ autoPlayDelayMs: parseInt(event.target.value, 10) });
    });

    $('movetime').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('movetimeOut', formatSeconds(parseInt(event.target.value, 10)));
    });
    $('movetime').addEventListener('change', function (event) {
      save({ movetimeMs: parseInt(event.target.value, 10) });
    });

    $('multiPV').addEventListener('change', function (event) {
      save({ multiPV: parseInt(event.target.value, 10) });
    });

    $('engineSkill').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('engineSkillOut', event.target.value);
    });
    $('engineSkill').addEventListener('change', function (event) {
      save({ engineSkill: parseInt(event.target.value, 10) });
    });

    $('engineDepth').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      var depth = parseInt(event.target.value, 10);
      setText('engineDepthOut', depth > 0 ? 'гл. ' + depth : 'без лимита');
    });
    $('engineDepth').addEventListener('change', function (event) {
      save({ engineDepth: parseInt(event.target.value, 10) });
    });

    $('humanize').addEventListener('change', function (event) {
      save({ humanize: !!event.target.checked });
    });

    $('humanizeAdaptive').addEventListener('change', function (event) {
      save({ humanizeAdaptive: !!event.target.checked });
    });

    $('humanizeRating').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      var value = parseInt(event.target.value, 10);
      setText('humanizeRatingOut', value > 0 ? String(value) : 'авто');
    });
    $('humanizeRating').addEventListener('change', function (event) {
      save({ humanizeRating: parseInt(event.target.value, 10) });
    });

    $('humanizeRescue').addEventListener('change', function (event) {
      save({ humanizeRescue: !!event.target.checked });
    });

    $('humanizeRescueCp').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeRescueCpOut', formatPawns(event.target.value));
    });
    $('humanizeRescueCp').addEventListener('change', saveRescueTimes);

    $('humanizeRescueExitCp').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeRescueExitCpOut', formatPawns(event.target.value));
    });
    $('humanizeRescueExitCp').addEventListener('change', saveRescueTimes);

    $('humanizeRescueMs').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeRescueMsOut', formatSeconds(parseInt(event.target.value, 10)));
    });
    $('humanizeRescueMs').addEventListener('change', function (event) {
      save({ humanizeRescueMs: parseInt(event.target.value, 10) });
    });

    $('humanizeErrorPct').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeErrorPctOut', event.target.value + ' %');
    });
    $('humanizeErrorPct').addEventListener('change', function (event) {
      save({ humanizeErrorPct: parseInt(event.target.value, 10) });
    });

    $('humanizeMaxLossCp').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeMaxLossCpOut', event.target.value + ' ср');
    });
    $('humanizeMaxLossCp').addEventListener('change', function (event) {
      save({ humanizeMaxLossCp: parseInt(event.target.value, 10) });
    });

    $('humanizeBlunderPct').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeBlunderPctOut', event.target.value + ' %');
    });
    $('humanizeBlunderPct').addEventListener('change', function (event) {
      save({ humanizeBlunderPct: parseInt(event.target.value, 10) });
    });

    $('humanizeMin').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeMinOut', formatSeconds(parseInt(event.target.value, 10)));
    });
    $('humanizeMin').addEventListener('change', saveHumanTimes);

    $('humanizeMax').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeMaxOut', formatSeconds(parseInt(event.target.value, 10)));
    });
    $('humanizeMax').addEventListener('change', saveHumanTimes);

    $('humanizeFastPct').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeFastPctOut', event.target.value + ' %');
    });
    $('humanizeFastPct').addEventListener('change', function (event) {
      save({ humanizeFastPct: parseInt(event.target.value, 10) });
    });

    $('humanizeFastMs').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeFastMsOut', formatSeconds(parseInt(event.target.value, 10)));
    });
    $('humanizeFastMs').addEventListener('change', function (event) {
      save({ humanizeFastMs: parseInt(event.target.value, 10) });
    });

    $('humanizeRarePct').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeRarePctOut', event.target.value + ' %');
    });
    $('humanizeRarePct').addEventListener('change', function (event) {
      save({ humanizeRarePct: parseInt(event.target.value, 10) });
    });

    $('humanizeRare').addEventListener('input', function (event) {
      updateRangeFill(event.target);
      setText('humanizeRareOut', formatSeconds(parseInt(event.target.value, 10)));
    });
    $('humanizeRare').addEventListener('change', saveHumanTimes);

    $('humanizeClockAware').addEventListener('change', function (event) {
      save({ humanizeClockAware: !!event.target.checked });
    });

    $('engineBuild').addEventListener('change', function (event) {
      save({ engineBuild: event.target.value === 'lite' ? 'lite' : 'full' });
      restartEngine();
    });

    $('playNow').addEventListener('click', function () {
      action('ca-play-now');
    });
    $('recalc').addEventListener('click', function () {
      action('ca-recalc');
    });
    $('flipTurn').addEventListener('click', function () {
      action('ca-flip-turn');
    });

    $('presetBullet').addEventListener('click', function () { applyPreset('bullet'); });
    $('presetMaster').addEventListener('click', function () { applyPreset('master'); });
    $('presetBlitz').addEventListener('click', function () { applyPreset('blitz'); });
    $('presetTen').addEventListener('click', function () { applyPreset('ten'); });
    $('presetMax').addEventListener('click', function () { applyPreset('max'); });
    $('exportConfig').addEventListener('click', exportConfig);
    $('importConfig').addEventListener('click', importConfig);
    $('applyConfig').addEventListener('click', function () {
      applyConfigText($('configText').value);
    });
  }

  /* ------------------------------------------------------------------- data */

  function readContentState() {
    if (tabId == null) return Promise.resolve(null);
    try {
      var result = api.tabs.sendMessage(tabId, { type: 'ca-state' });
      if (result && typeof result.then === 'function') {
        return result.catch(function () { return null; });
      }
      return Promise.resolve(result || null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function readEngineStatus() {
    try {
      var result = api.runtime.sendMessage({ type: 'ca-engine-status' });
      if (result && typeof result.then === 'function') {
        return result.catch(function () { return null; });
      }
      return Promise.resolve(result || null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function refresh() {
    return Promise.all([readContentState(), readEngineStatus()]).then(function (values) {
      contentState = values[0];
      engineStatus = values[1];
      render();
    });
  }

  function action(type, extra) {
    if (tabId == null) return;
    var message = Object.assign({ type: type }, extra || {});
    try {
      var result = api.tabs.sendMessage(tabId, message);
      if (result && typeof result.then === 'function') {
        result.then(function (response) {
          if (response && response.ok === false && response.error) {
            showError(response.error);
          }
          refresh();
        }).catch(function () {
          showError('Нет связи со страницей. Обнови её.');
        });
      }
    } catch (e) {
      showError('Нет связи со страницей. Обнови её.');
    }
  }

  /*
   * Restart the background worker with the build that is selected now. The
   * build is sent explicitly so the worker does not depend on the storage
   * listener having seen the new value first.
   */
  function restartEngine() {
    var build = settings.engineBuild === 'lite' ? 'lite' : 'full';
    try {
      var result = api.runtime.sendMessage({ type: 'ca-engine-restart', build: build });
      if (result && typeof result.then === 'function') {
        result.then(function () { refresh(); }).catch(function () {});
      }
    } catch (e) { /* the poll will show the engine state anyway */ }
  }

  /* ------------------------------------------------------------------ render */

  function renderEngine() {
    var status = engineStatus || {};
    var ready = !!status.ready;
    var starting = !!status.starting;
    var searching = !!status.searching;
    var error = status.error;
    // Always name the build that is really running: switching to Lite or
    // falling back after a failed full load must be visible here.
    var label = status.engine || 'Stockfish';
    if (status.mobile) label += ' (телефон)';
    // Above one, the root moves are split between independent engines working
    // at the same time - there is no SharedArrayBuffer in a Firefox extension,
    // so this is how far the parallelism goes.
    if (status.parallel > 1) label += ' · ' + status.parallel + ' потока';

    if (error) {
      setText('engineText', label + ': ошибка');
      setDot('error');
    } else if (ready && searching) {
      setText('engineText', label + ' · думает');
      setDot('busy');
    } else if (ready) {
      setText('engineText', label + ' · готов');
      setDot('ready');
    } else if (starting) {
      setText('engineText', label + ' · запуск…');
      setDot('busy');
    } else {
      setText('engineText', label);
      setDot('');
    }
  }

  function renderSite() {
    var line = $('siteLine');
    var text = $('siteText');
    line.classList.remove('is-live', 'is-warn');

    if (!contentState) {
      text.textContent = 'Нет доски на этой странице';
      line.classList.add('is-warn');
      return;
    }
    if (!contentState.boardFound) {
      text.textContent = friendlySite(contentState.site) + ' · доска не найдена';
      line.classList.add('is-warn');
      return;
    }
    text.textContent = friendlySite(contentState.site) + ' · доска найдена';
    if (contentState.targetRating) {
      text.textContent += ' · ~' + contentState.targetRating;
    }
    if (contentState.phase) {
      text.textContent += ' · ' + contentState.phase;
    }
    line.classList.add('is-live');
  }

  function renderStatus() {
    var status = '';
    var tone = '';
    var state = contentState;

    if (state) {
      if (state.gameOver) status = 'Партия окончена';
      else if (state.rescue && state.myTurn) { status = 'Спасательная подушка: играю в полную силу'; tone = 'is-busy'; }
      else if (state.autoStatus) { status = state.autoStatus; tone = 'is-busy'; }
      else if (state.thinking) { status = 'Stockfish думает…'; tone = 'is-busy'; }
      else if (state.bestSan) {
        if (state.myTurn) {
          status = 'Твой ход — можно играть';
          tone = 'is-ok';
        } else {
          status = state.showOpponent ? 'Ход соперника — прогноз' : 'Ход соперника — ждём';
        }
      } else {
        status = state.error ? 'Ошибка чтения позиции' : 'Ожидаю позицию…';
      }
    } else if (engineStatus && engineStatus.error) {
      status = 'Stockfish не запустился';
    } else {
      status = 'Открой доску на chess.com или lichess.org';
    }

    var node = $('statusText');
    if (state && state.tablebaseLast) {
      // The chip carries the tablebase result for a fraction of a second in
      // bullet, so the last exact decision is also kept here, where it stays.
      status += ' · таблицы: ' + state.tablebaseLast.text;
      if (state.tablebaseLast.count) {
        status += ' (' + state.tablebaseLast.count + ')';
      }
    }
    node.textContent = status;
    node.className = 'status' + (tone ? ' ' + tone : '');
  }

  function render() {
    renderEngine();
    renderSite();
    renderStatus();

    var state = contentState;
    var active = !!(state && state.ok && state.boardFound);
    var error = transientError || (state && state.error) || (engineStatus && engineStatus.error) || '';

    if (state && state.depth) {
      setText('depthBadge', 'гл. ' + state.depth);
    } else {
      setText('depthBadge', '');
    }

    var badge = $('turnBadge');
    if (state && state.boardFound) {
      if (state.gameOver) {
        badge.textContent = 'Финал';
        badge.setAttribute('data-side', 'x');
      } else {
        badge.textContent = state.turn === 'b' ? 'Ход чёрных' : 'Ход белых';
        badge.setAttribute('data-side', state.turn === 'b' ? 'b' : 'w');
      }
    } else {
      badge.textContent = '—';
      badge.setAttribute('data-side', 'x');
    }

    var showBest = !!(state && (state.myTurn || state.showOpponent));
    setText('bestMove', active && state.bestSan && showBest ? state.bestSan : '—');
    var evalText = active && state.score ? state.score : '—';
    setText('eval', evalText);
    var evalNode = $('eval');
    if (evalNode) evalNode.setAttribute('data-tone', active ? scoreTone(state.score) : 'idle');

    // "Чей ход" is an override, not a stored preference: it goes back to Auto
    // as soon as the position changes.
    setSegmented('turnGroup', state && state.turnLocked ? state.turn : 'auto');

    var errorNode = $('errorText');
    var note = engineStatus && engineStatus.note;
    if (error) {
      errorNode.textContent = error;
      errorNode.classList.remove('hidden', 'is-note');
    } else if (note) {
      errorNode.textContent = note;
      errorNode.classList.remove('hidden');
      errorNode.classList.add('is-note');
    } else {
      errorNode.classList.add('hidden');
      errorNode.classList.remove('is-note');
    }

    $('playNow').disabled = !(active && state.myTurn && state.bestSan && !state.gameOver && !state.autoBusy);
    $('recalc').disabled = !active;
    $('flipTurn').disabled = !active;
  }

  /* -------------------------------------------------------------------- init */

  /*
   * The popup is also the options page, which Firefox for Android opens as a
   * full tab. In that tab `active, currentWindow` is the settings page itself
   * and it has no content script, so fall back to the newest chess tab.
   */
  function isOwnPage(tab) {
    if (!tab || !tab.url) return false;
    try { return tab.url.indexOf(api.runtime.getURL('')) === 0; } catch (e) { return false; }
  }

  function findChessTab() {
    try {
      var result = api.tabs.query({
        url: [
          'https://chess.com/*',
          'https://*.chess.com/*',
          'https://lichess.org/*',
          'https://*.lichess.org/*'
        ]
      });
      if (!result || typeof result.then !== 'function') return Promise.resolve(null);
      return result.then(function (tabs) {
        if (!tabs || !tabs.length) return null;
        return tabs[tabs.length - 1];
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function resolveTargetTab() {
    var active;
    try {
      active = api.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      active = null;
    }
    if (!active || typeof active.then !== 'function') active = Promise.resolve([]);
    return active.then(function (tabs) {
      var tab = tabs && tabs[0];
      if (tab && typeof tab.id === 'number' && !isOwnPage(tab)) return tab.id;
      return findChessTab().then(function (chessTab) {
        return chessTab && typeof chessTab.id === 'number' ? chessTab.id : null;
      });
    }).catch(function () {
      return findChessTab().then(function (chessTab) {
        return chessTab && typeof chessTab.id === 'number' ? chessTab.id : null;
      });
    });
  }

  function init() {
    bindControls();

    var manifest = null;
    try { manifest = api.runtime.getManifest(); } catch (e) { manifest = null; }
    var versionNode = $('version');
    if (versionNode && manifest && manifest.version) versionNode.textContent = 'v' + manifest.version;

    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes) return;
      var touched = false;
      for (var key in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          settings[key] = changes[key].newValue;
          touched = true;
        }
      }
      if (touched) syncControls();
    });

    // get(null) returns only stored keys, so a missing key still picks up the
    // current defaults (showOpponent is enabled by default now).
    var loading = api.storage.local.get(null);
    if (!loading || typeof loading.then !== 'function') {
      loading = Promise.resolve(Object.assign({}, DEFAULTS));
    }

    loading.then(function (stored) {
      settings = Object.assign({}, DEFAULTS, stored || {});
      syncControls();
      return refresh();
    }).then(function () {
      pollTimer = setInterval(refresh, 900);
    }).catch(function () {
      syncControls();
      render();
      pollTimer = setInterval(refresh, 900);
    });

    resolveTargetTab().then(function (id) {
      tabId = id;
      return refresh();
    }).catch(function () {
      tabId = null;
      render();
    });

    window.addEventListener('unload', function () {
      if (pollTimer) clearInterval(pollTimer);
      if (transientTimer) clearTimeout(transientTimer);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
