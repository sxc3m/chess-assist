/* Content-side client for the background Stockfish worker. */
(function () {
  'use strict';

  function EngineClient() {
    this.port = null;
    this.nextId = 0;
    this.requestId = null;
    this.handlers = {};
    this.ready = false;
    this.searching = false;
    this.error = null;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  EngineClient.prototype.on = function (name, fn) {
    if (!this.handlers[name]) this.handlers[name] = [];
    this.handlers[name].push(fn);
    return this;
  };

  EngineClient.prototype.emit = function (name, value) {
    var list = this.handlers[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](value); } catch (e) { /* ignore listener errors */ }
    }
  };

  EngineClient.prototype.connect = function () {
    if (this.stopped || this.port) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    var api = globalThis.browser || globalThis.chrome;
    if (!api || !api.runtime) return;
    try {
      this.port = api.runtime.connect({ name: 'ca-engine' });
    } catch (e) {
      this.port = null;
      this.scheduleReconnect();
      return;
    }
    var self = this;
    this.port.onMessage.addListener(function (msg) { self.handle(msg); });
    this.port.onDisconnect.addListener(function () {
      self.port = null;
      self.ready = false;
      self.searching = false;
      self.requestId = null;
      self.emit('status', { ready: false, searching: false, error: self.error });
      self.emit('cancelled', {});
      self.scheduleReconnect();
    });
  };

  EngineClient.prototype.scheduleReconnect = function () {
    if (this.stopped || this.reconnectTimer) return;
    var self = this;
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = null;
      self.connect();
    }, 1200);
  };

  EngineClient.prototype.handle = function (msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'status') {
      this.ready = !!msg.ready;
      this.searching = !!msg.searching;
      this.error = msg.error || null;
      this.emit('status', msg);
      return;
    }
    if (msg.id != null && (this.requestId == null || msg.id !== this.requestId)) return;
    if (msg.type === 'analysis') {
      this.emit('analysis', msg);
      return;
    }
    if (msg.type === 'bestmove') {
      this.searching = false;
      this.emit('bestmove', msg);
      return;
    }
    if (msg.type === 'cancelled') {
      this.searching = false;
      this.emit('cancelled', msg);
      return;
    }
    if (msg.type === 'error') {
      this.error = msg.message || 'Ошибка движка';
      this.searching = false;
      this.emit('error', msg);
    }
  };

  EngineClient.prototype.analyze = function (opts) {
    this.connect();
    this.requestId = ++this.nextId;
    if (!this.port) return this.requestId;
    try {
      this.port.postMessage({
        type: 'analyze',
        id: this.requestId,
        fen: opts.fen,
        multiPV: opts.multiPV || 1,
        movetime: opts.movetime || 1200,
        depth: opts.depth || 0,
        skill: typeof opts.skill === 'number' ? opts.skill : 20,
        // Forwarded untouched: the background decides whether it can be split.
        rootMoves: opts.rootMoves || null
      });
    } catch (e) {
      this.error = 'Нет связи с фоновым движком';
      this.emit('error', { message: this.error });
    }
    return this.requestId;
  };

  EngineClient.prototype.stop = function () {
    this.requestId = null;
    this.searching = false;
    if (!this.port) return;
    try { this.port.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ }
  };

  EngineClient.prototype.destroy = function () {
    this.stopped = true;
    this.requestId = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.port) {
      try { this.port.disconnect(); } catch (e) { /* ignore */ }
      this.port = null;
    }
  };

  CA.EngineClient = EngineClient;
})();
