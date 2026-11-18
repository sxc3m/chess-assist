/*
 * Firefox for Android support tests.
 *
 *   content/automove.js   touch event sequence for mobile boards
 *   manifest.json          MV2 + gecko id + options page (Android requirements)
 *   content/content.js     touch wiring, visualViewport, visibility recovery
 *   background/...         phone forces the Lite engine and a small hash
 *   tools/build-firefox.ps1 packages the Lite build only for Android
 *
 * The touch test runs the real automove.js in a sandbox with fake event
 * constructors, because the only thing that can be verified without a phone is
 * which events get dispatched and in what order.
 *
 * Usage: node tools/test-mobile.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

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

/* ----------------------------------------------------------- automove touch */

function makeAutomoveSandbox() {
  var events = [];
  var board = null;
  var target = null;

  function makeNode(name) {
    return {
      name: name,
      isConnected: true,
      dispatchEvent: function (event) {
        events.push({
          target: name,
          type: event.type,
          pointerType: event.pointerType || null
        });
        return true;
      },
      getBoundingClientRect: function () {
        return { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 };
      },
      scrollIntoView: function () {}
    };
  }

  board = makeNode('board');
  target = makeNode('piece');

  function FakeEvent(type, init) {
    this.type = type;
    Object.assign(this, init || {});
  }
  function FakePointerEvent(type, init) { FakeEvent.call(this, type, init); }
  FakePointerEvent.prototype = Object.create(FakeEvent.prototype);
  function FakeMouseEvent(type, init) { FakeEvent.call(this, type, init); }
  FakeMouseEvent.prototype = Object.create(FakeEvent.prototype);
  function FakeTouch(init) { Object.assign(this, init || {}); }
  function FakeTouchEvent(type, init) { FakeEvent.call(this, type, init); }
  FakeTouchEvent.prototype = Object.create(FakeEvent.prototype);

  var core = {
    moveToUci: function (from, to, promotion) {
      return 'uci-' + from + '-' + to + (promotion ? promotion : '');
    },
    squareCenter: function (index, rect, orientation) {
      var cell = Math.min(rect.width, rect.height) / 8;
      return {
        x: rect.left + (index % 8 + 0.5) * cell,
        y: rect.top + (Math.floor(index / 8) + 0.5) * cell,
        cell: cell
      };
    }
  };

  var windowObject = {
    screenX: 0,
    screenY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    innerWidth: 400,
    innerHeight: 800,
    visualViewport: null
  };

  var sandbox = {
    CA: { core: core },
    window: windowObject,
    document: {
      elementFromPoint: function () { return target; },
      querySelectorAll: function () { return []; }
    },
    Promise: Promise,
    Date: Date,
    Math: Math,
    Object: Object,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    PointerEvent: FakePointerEvent,
    MouseEvent: FakeMouseEvent,
    Touch: FakeTouch,
    TouchEvent: FakeTouchEvent,
    globalThis: null
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('content/automove.js'), sandbox, { filename: 'content/automove.js' });

  return {
    events: events,
    board: board,
    mover: new sandbox.CA.AutoMover(),
    clear: function () { events.length = 0; }
  };
}

var move = { from: 12, to: 28 };  // e2-e4

async function runTouchTests() {
  console.log('automove: touch path');

  var box = makeAutomoveSandbox();
  await box.mover.play(box.board, 'white', move, {
    mode: 'click', touch: true, color: 'w', site: 'generic'
  });

  check('touch tap sends touchstart/touchend', function () {
    var starts = box.events.filter(function (e) { return e.type === 'touchstart'; });
    var ends = box.events.filter(function (e) { return e.type === 'touchend'; });
    assert.strictEqual(starts.length, 2, 'two taps = two touchstarts');
    assert.strictEqual(ends.length, 2, 'two taps = two touchends');
  });

  check('touch tap marks pointer events as touch', function () {
    var downs = box.events.filter(function (e) { return e.type === 'pointerdown'; });
    assert.strictEqual(downs.length, 2);
    downs.forEach(function (e) { assert.strictEqual(e.pointerType, 'touch'); });
  });

  check('touchstart comes after pointerdown and before pointerup', function () {
    var index = function (type) {
      return box.events.findIndex(function (e) { return e.type === type; });
    };
    assert.ok(index('pointerdown') >= 0);
    assert.ok(index('touchstart') > index('pointerdown'));
    assert.ok(index('touchend') > index('touchstart'));
    assert.ok(index('pointerup') > index('touchend'));
  });

  check('touch tap still fires a click for click-driven boards', function () {
    var clicks = box.events.filter(function (e) { return e.type === 'click'; });
    assert.strictEqual(clicks.length, 2);
  });

  var mouseBox = makeAutomoveSandbox();
  await mouseBox.mover.play(mouseBox.board, 'white', move, {
    mode: 'click', touch: false, color: 'w', site: 'generic'
  });

  check('desktop path stays mouse-only', function () {
    var touch = mouseBox.events.filter(function (e) {
      return e.type.indexOf('touch') === 0;
    });
    assert.strictEqual(touch.length, 0);
    var downs = mouseBox.events.filter(function (e) { return e.type === 'pointerdown'; });
    assert.strictEqual(downs.length, 2);
    downs.forEach(function (e) { assert.strictEqual(e.pointerType, 'mouse'); });
  });

  var dragBox = makeAutomoveSandbox();
  await dragBox.mover.play(dragBox.board, 'white', move, {
    mode: 'drag', touch: true, color: 'w', site: 'generic'
  });

  check('touch drag sends touchmove between the squares', function () {
    var moves = dragBox.events.filter(function (e) { return e.type === 'touchmove'; });
    assert.ok(moves.length >= 5, 'drag should interpolate, got ' + moves.length);
    var start = dragBox.events.findIndex(function (e) { return e.type === 'touchstart'; });
    var end = dragBox.events.findIndex(function (e) { return e.type === 'touchend'; });
    assert.ok(start >= 0 && end > start);
  });
}

/* --------------------------------------------------------------- manifest */

console.log('manifest: Firefox for Android requirements');

var manifest = JSON.parse(read('manifest.json'));

check('stays Manifest V2 (Android has no background service workers)', function () {
  assert.strictEqual(manifest.manifest_version, 2);
  assert.ok(manifest.background.scripts.length > 0);
});

check('has a gecko id for unsigned installs', function () {
  assert.ok(manifest.browser_specific_settings.gecko.id);
  assert.ok(/@/.test(manifest.browser_specific_settings.gecko.id));
});

check('exposes an options page that Android can open in a tab', function () {
  assert.strictEqual(manifest.options_ui.page, 'popup/popup.html');
  assert.strictEqual(manifest.options_ui.open_in_tab, true);
});

check('content scripts cover both boards on mobile hosts', function () {
  var script = manifest.content_scripts[0];
  assert.ok(script.js.indexOf('content/automove.js') >= 0);
  assert.ok(script.js.indexOf('content/content.js') >= 0);
  assert.ok(script.matches.indexOf('https://*.chess.com/*') >= 0);
  assert.ok(script.matches.indexOf('https://*.lichess.org/*') >= 0);
});

/* ------------------------------------------------------------ source wiring */

console.log('wiring: mobile code paths');

var content = read('content/content.js');
var background = read('background/background.js');
var popupJs = read('popup/popup.js');
var contentCss = read('content/style.css');
var popupCss = read('popup/popup.css');

check('content detects touch and passes it to the mover', function () {
  assert.ok(content.indexOf('var TOUCH =') >= 0);
  var calls = content.split('touch: TOUCH').length - 1;
  assert.strictEqual(calls, 2, 'both play() calls must carry touch');
});

check('content follows the mobile visual viewport', function () {
  assert.ok(content.indexOf('window.visualViewport') >= 0);
  assert.ok(content.indexOf("'visibilitychange'") >= 0);
});

check('phone runs the same builds with a smaller hash', function () {
  assert.ok(background.indexOf('IS_MOBILE') >= 0);
  assert.ok(background.indexOf('MOBILE_HASH_MB') >= 0);
  assert.ok(background.indexOf('full: 64') >= 0);
  assert.strictEqual(/if \(IS_MOBILE\) return 'lite'/.test(background), false,
    'the full build must stay selectable on a phone');
  assert.ok(background.indexOf('mobile: IS_MOBILE') >= 0);
});

check('phone falls back to Lite when the heavy build keeps dying', function () {
  assert.ok(background.indexOf('MOBILE_FULL_CRASH_LIMIT') >= 0);
  assert.ok(background.indexOf('mobileFullCrashes') >= 0);
});

check('popup opens the newest chess tab when it is itself a tab', function () {
  assert.ok(popupJs.indexOf('findChessTab') >= 0);
  assert.ok(popupJs.indexOf('isOwnPage') >= 0);
  assert.ok(popupJs.indexOf('IS_MOBILE') >= 0);
});

check('overlay grows for fingers and has a settings gesture', function () {
  assert.ok(contentCss.indexOf('@media (max-width: 820px)') >= 0);
  assert.ok(read('content/overlay.js').indexOf('openSettings') >= 0);
});

check('settings page fills a phone tab and enlarges touch controls', function () {
  assert.ok(popupCss.indexOf('@media (min-width: 480px)') >= 0);
  assert.ok(popupCss.indexOf('@media (pointer: coarse)') >= 0);
});

check('android package carries both engine builds', function () {
  var build = read('tools/build-firefox.ps1');
  assert.strictEqual(build.indexOf('excludeAndroid'), -1,
    'the phone package must ship the full NNUE build too');
  assert.ok(build.indexOf('chess-assist-android-nightly.xpi') >= 0);
});

check('the phone keeps both engine builds in the picker', function () {
  assert.ok(popupJs.indexOf("option[value=\"full\"]") >= 0);
  assert.strictEqual(popupJs.indexOf('removeChild(full)'), -1,
    'the full build must not be removed from the phone UI');
  assert.strictEqual(popupJs.indexOf("save({ engineBuild: 'lite' })"), -1,
    'the phone must not force the Lite build');
});

check('the chip shows the search time', function () {
  var overlay = read('content/overlay.js');
  assert.ok(overlay.indexOf('ca-hud__time') >= 0);
  assert.ok(overlay.indexOf('formatThink') >= 0);
  assert.ok(content.indexOf('state.thinkStart = Date.now()') >= 0);
  assert.ok(content.indexOf('state.thinkMs = Date.now() - state.thinkStart') >= 0);
  assert.ok(contentCss.indexOf('.ca-hud__time') >= 0);
});

check('archives store forward-slash entry names', function () {
  var build = read('tools/build-firefox.ps1');
  assert.ok(build.indexOf("Replace('\\', '/')") >= 0);
  assert.ok(build.indexOf('uses a backslash separator') >= 0);
});

check('auto rematch is wired through the settings page', function () {
  assert.ok(content.indexOf("autoRematch: false") >= 0);
  assert.ok(content.indexOf('autoRematch: !!state.settings.autoRematch') >= 0);
  assert.ok(popupJs.indexOf('autoRematch: false') >= 0);
  assert.ok(popupJs.indexOf("$('autoRematch').checked") >= 0);
  assert.ok(popupJs.indexOf("save({ autoRematch: !!event.target.checked })") >= 0);
  var popupHtml = read('popup/popup.html');
  assert.ok(popupHtml.indexOf('id="autoRematch"') >= 0);
});

check('the board-event move path is wired but off by default', function () {
  // Off by default on purpose: the DOM path depends on the site's markup, and
  // it is only worth its extra latency once the user asks for it.
  assert.ok(content.indexOf("humanInput: false") >= 0);
  assert.ok(popupJs.indexOf("humanInput: false") >= 0);
  assert.ok(popupJs.indexOf("$('humanInput').checked") >= 0);
  assert.ok(popupJs.indexOf("save({ humanInput: !!event.target.checked })") >= 0);
  assert.ok(read('popup/popup.html').indexOf('id="humanInput"') >= 0);
  // The controller must forward the choice, and the mover must honour it.
  assert.ok(content.indexOf("state.settings.humanInput ? 'events' : 'auto'") >= 0);
  assert.ok(read('content/automove.js').indexOf("opts.input !== 'events'") >= 0);
});

check('auto rematch presses the offer on any time control', function () {
  assert.ok(content.indexOf('tickRematch()') >= 0);
  assert.ok(content.indexOf('function rematchButton()') >= 0);
  // The caption is what identifies the button: chess.com's classes and the
  // dialog markup change, the caption does not.
  assert.ok(content.indexOf('var REMATCH_LABEL') >= 0,
    'the rematch label regex must be present');
  // content.js lowercases the button caption before matching it.
  assert.ok(/toLowerCase\(\)/.test(content.slice(content.indexOf('function rematchButton()'))));
  // 1+0 is no longer the only accepted control: the clock is parsed out of the
  // caption so every offer on the dialog is usable.
  assert.ok(content.indexOf('function rematchToken(') >= 0);
  assert.ok(content.indexOf('rememberRematchControl(found.token)') >= 0);
  // No win/loss condition anywhere in the rematch module: the same press
  // runs after a win, a loss, and a draw.
  var module = content.slice(content.indexOf('function tickRematch()'));
  module = module.slice(0, module.indexOf('function scheduleAutoMove()'));
  assert.strictEqual(/win|lose|loss|побед|пораж/i.test(module), false,
    'the rematch must not branch on the result');
});

/* ------------------------------------------------------------------- report */

runTouchTests().then(function () {
  console.log('');
  if (failures) {
    console.error(failures + ' test(s) failed');
    process.exit(1);
  }
  console.log('mobile tests passed');
}).catch(function (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
