'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function adapter() {
  let socket, received = [], dispatched = [];
  class FakeSocket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; }
    send() {} close() { this.readyState = 3; }
  }
  const window = { dispatchEvent: e => dispatched.push(e), Mihayou: { receiveAction: a => received.push(a) } };
  const context = { window, WebSocket: FakeSocket, performance: { now: () => 5000 },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 2, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/game-link.js'), 'utf8'), context);
  return { window, received, dispatched, socket: () => socket, message: m => socket.onmessage({ data: JSON.stringify(m) }) };
}
test('adapter blocks tests, stale runs and unverified legacy by default, reconnect changes session', () => {
  const f = adapter();
  f.window.MihayouLink.connect('ws://127.0.0.1/ws');
  f.message({ event: 'hello', data: { runId: 'r1' } });
  const action = { sessionId: 'r1', sequence: 1, action: 'swing_up', legacy: false, estimatedServerSourceMs: null };
  f.message({ event: 'action', data: { ...action, isTest: true } });
  f.message({ event: 'action', data: { ...action, sessionId: 'old' } });
  f.message({ event: 'action', data: { ...action, legacy: true } });
  assert.equal(f.received.length, 0);
  f.message({ event: 'action', data: action });
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].receivedAtMs, 5000);
  f.message({ event: 'run', data: { runId: 'r2' } });
  f.message({ event: 'action', data: action });
  assert.equal(f.received.length, 1);
  f.window.MihayouLink.disconnect();
});
test('music mapping uses output timestamp and subtracts positive offset exactly once', () => {
  const f = adapter();
  const audio = { getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 4000 }) };
  const value = f.window.MihayouLink.toMusicTimeMs({ receivedAtMs: 4500 }, audio, 8, 80);
  assert.equal(value, 2420);
});
