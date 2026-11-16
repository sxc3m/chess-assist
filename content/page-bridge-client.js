/*
 * Chess Assist - content-script side of the page bridge.
 *
 * Injects content/page-bridge.js into the page's JS world and exposes a small
 * promise API for Lichess and Chess.com. All messages carry a random token so
 * unrelated page scripts cannot fake a bridge response.
 */
(function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  var TOKEN = 'ca-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  var seq = 0;
  var pending = {};
  var injection = null;
  var bridgeReady = false;
  var bridgeInfo = null;

  function onMessage(event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__ca !== 'bridge-response' || data.token !== TOKEN) return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    clearTimeout(entry.timer);
    entry.resolve(data);
  }

  window.addEventListener('message', onMessage);

  function request(action, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('bridge-timeout'));
      }, timeoutMs || 1600);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var message = {
        __ca: 'bridge-request',
        token: TOKEN,
        id: id,
        action: action
      };
      if (params) {
        for (var key in params) {
          if (Object.prototype.hasOwnProperty.call(params, key)) message[key] = params[key];
        }
      }
      try {
        window.postMessage(message, '*');
      } catch (e) {
        clearTimeout(timer);
        delete pending[id];
        reject(e);
      }
    });
  }

  function inject() {
    if (injection) return injection;
    injection = new Promise(function (resolve) {
      var url = null;
      try {
        url = api && api.runtime && api.runtime.getURL
          ? api.runtime.getURL('content/page-bridge.js')
          : null;
      } catch (e) { url = null; }
      if (!url) { resolve(false); return; }

      var script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.onerror = function () { resolve(false); };
      (document.head || document.documentElement).appendChild(script);

      // The script tag can load before the bridge has installed its listener,
      // and a page CSP can silently block it. Ping until it answers.
      var attempts = 0;
      function probe() {
        request('ping', null, 320).then(function (response) {
          bridgeReady = true;
          bridgeInfo = response && response.info ? response.info : null;
          resolve(true);
        }, function () {
          if (++attempts >= 8) {
            resolve(false);
            return;
          }
          setTimeout(probe, 110);
        });
      }
      probe();
    });
    return injection;
  }

  function lichessError(code) {
    if (code === 'no-live-socket') return 'Lichess: не нашёл сокет партии. Обнови страницу и повтори.';
    if (code === 'not-a-player') return 'Lichess: эта партия открыта как наблюдение, ходы недоступны.';
    if (code === 'socket-send-failed') return 'Lichess: не удалось отправить ход в сокет партии.';
    if (code === 'bad-uci') return 'Lichess: движок вернул некорректный ход.';
    if (code === 'bridge-exception') return 'Lichess: страница отклонила ход. Обнови вкладку.';
    if (code === 'bridge-timeout') return 'Lichess: страница не ответила. Обнови вкладку.';
    return 'Lichess: не удалось подключиться к странице. Обнови вкладку.';
  }

  function chesscomError(code) {
    if (code === 'no-game') return 'Chess.com: не нашёл объект партии. Обнови страницу и начни партию.';
    if (code === 'no-fen') return 'Chess.com: партия есть, но позицию прочитать не удалось. Обнови страницу.';
    if (code === 'not-your-turn') return 'Chess.com: сейчас ход соперника.';
    if (code === 'illegal-move') return 'Chess.com: ход не входит в список допустимых на доске.';
    if (code === 'move-failed') return 'Chess.com: страница отклонила ход. Обнови вкладку.';
    if (code === 'bad-uci') return 'Chess.com: движок вернул некорректный ход.';
    if (code === 'bridge-exception') return 'Chess.com: страница отклонила запрос. Обнови вкладку.';
    if (code === 'bridge-timeout') return 'Chess.com: страница не ответила. Обнови вкладку.';
    return 'Chess.com: не удалось подключиться к странице. Обнови вкладку.';
  }

  /*
   * The round socket can still be CONNECTING when the content script first
   * asks for a move. `subscribeToMoveLatency()` makes Lichess queue a tiny
   * send on that socket; the page bridge records it as soon as the socket
   * opens. A few quick retries close that race without delaying normal moves.
   */
  var MOVE_RETRY_MS = 250;
  var MOVE_RETRIES = 3;

  function requestMove(uci, retriesLeft) {
    return request('move', { uci: uci }, 2500).then(function (response) {
      if (response && !response.ok && response.error === 'no-live-socket' && retriesLeft > 0) {
        return new Promise(function (resolve) {
          setTimeout(resolve, MOVE_RETRY_MS);
        }).then(function () {
          return requestMove(uci, retriesLeft - 1);
        });
      }
      return response;
    });
  }

  function move(uci) {
    return inject().then(function (ok) {
      if (!ok) return { via: 'bridge', error: lichessError('bridge-unavailable') };
      return requestMove(uci, MOVE_RETRIES).then(function (response) {
        if (response && response.ok) {
          return {
            via: response.via === 'analysis' ? 'lichess-api' : 'lichess-socket',
            mode: response.via || 'socket',
            uci: uci
          };
        }
        return { via: 'bridge', error: lichessError(response && response.error) };
      }, function () {
        return { via: 'bridge', error: lichessError('bridge-timeout') };
      });
    });
  }

  function chesscomState() {
    return inject().then(function (ok) {
      if (!ok) {
        return {
          ok: false,
          code: 'bridge-unavailable',
          error: chesscomError('bridge-unavailable')
        };
      }
      return request('chesscom-state', null, 1200).then(function (response) {
        if (response && response.ok && response.state) {
          return { ok: true, state: response.state };
        }
        var code = (response && response.error) || 'no-game';
        return { ok: false, code: code, error: chesscomError(code) };
      }, function () {
        return {
          ok: false,
          code: 'bridge-timeout',
          error: chesscomError('bridge-timeout')
        };
      });
    });
  }

  function chesscomMove(uci) {
    return inject().then(function (ok) {
      if (!ok) {
        return {
          via: 'bridge',
          code: 'bridge-unavailable',
          fallback: true,
          error: chesscomError('bridge-unavailable')
        };
      }
      return request('chesscom-move', { uci: uci }, 2500).then(function (response) {
        if (response && response.ok) {
          return { via: 'chesscom-api', mode: 'game-api', uci: uci };
        }
        var code = (response && response.error) || 'move-failed';
        return {
          via: 'bridge',
          code: code,
          // If there is no game object at all, the old DOM-event fallback
          // still has a chance on legacy pages. A rejected legal move does
          // not: retrying it with synthetic events would only duplicate work.
          fallback: code === 'no-game' || code === 'no-fen' || code === 'bridge-unavailable',
          error: chesscomError(code)
        };
      }, function () {
        return {
          via: 'bridge',
          code: 'bridge-timeout',
          fallback: false,
          error: chesscomError('bridge-timeout')
        };
      });
    });
  }

  function info() {
    return inject().then(function (ok) {
      return ok ? bridgeInfo : null;
    });
  }

  CA.PageBridge = {
    install: function () { return inject(); },
    isReady: function () { return bridgeReady; },
    info: info,
    move: move,
    chesscomState: chesscomState,
    chesscomMove: chesscomMove,
    error: function (code) { return lichessError(code); },
    chesscomError: chesscomError
  };
})();
