'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp, summarize } = require('../server');
const { WebSocket } = require('../vendor/ws');
async function fixture(t, options) {
  const app = createApp(options);
  const address = await app.listen();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${address.port}`;
  const get = async route => (await fetch(url + route)).json();
  const post = async (route, value) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    return { status: response.status, data: await response.json() };
  };
  const run = await get('/api/config');
  return { app, url, get, post, run };
}
test('legacy HTTP event is normalized and relayed using existing browser wire format', async t => {
  const { url, post, get } = await fixture(t);
  const peer = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  await once(peer, 'open');
  const messages = [];
  peer.on('message', data => messages.push(JSON.parse(data)));
  const result = await post('/api/action', { session_id: 'phone-a', sequence: 1, action: '上挥', elapsed_realtime_ms: 6500 });
  assert.equal(result.data.status, 'accepted');
  await new Promise(resolve => setTimeout(resolve, 30));
  const action = messages.find(m => m.event === 'action');
  assert.equal(action.data.type, 'swing_up');
  assert.equal(action.data.gameSessionVerified, false);
  const exported = await get('/api/export');
  assert.equal(exported.events[0].estimatedUplinkMs, null);
  peer.close();
});
test('100 controlled events, duplicates, unsupported types, sequence gap and retired sessions', async t => {
  const { post, get, run } = await fixture(t);
  for (let i = 1; i <= 100; i++) {
    const result = await post('/api/action', { clientId: 'test', sessionId: 's1', runId: run.runId, sequence: i, action: i % 2 ? 'swing_up' : 'swing_down', isTest: true });
    assert.equal(result.data.status, 'accepted');
  }
  assert.equal((await post('/api/action', { clientId: 'test', sessionId: 's1', sequence: 100, action: '上挥' })).data.status, 'duplicate');
  assert.equal((await post('/api/action', { clientId: 'test', sessionId: 's1', sequence: 102, action: '左倾' })).data.status, 'ignored');
  assert.equal((await post('/api/action', { clientId: 'test', sessionId: 's1', sequence: 101, action: '下挥' })).data.status, 'stale');
  assert.equal((await post('/api/action', { clientId: 'test', sessionId: 's2', sequence: 1, action: '下挥' })).data.status, 'accepted');
  assert.equal((await post('/api/action', { clientId: 'test', sessionId: 's1', sequence: 103, action: '下挥' })).data.status, 'stale');
  const state = await get('/api/state');
  assert.equal(state.stats.accepted, 101);
  assert.equal(state.stats.sequenceGaps, 1);
  assert.equal(state.stats.duplicate, 1);
  assert.equal(state.stats.stale, 2);
});
test('new run rejects tagged old events and pending old timing samples', async t => {
  const { post, get, run } = await fixture(t);
  const sync = await post('/api/sync', { clientId: 'test', c0: 5000 });
  const next = await post('/api/run', {});
  assert.notEqual(next.data.runId, run.runId);
  const late = await post('/api/action', { clientId: 'test', sessionId: 's1', runId: run.runId, sequence: 1, action: '上挥' });
  assert.equal(late.data.status, 'stale');
  const measurement = await post('/api/measurement', { clientId: 'test', sampleId: sync.data.sampleId, c3: 5020 });
  assert.equal(measurement.status, 409);
  assert.equal((await get('/api/state')).stats.accepted, 0);
});
test('four timestamp sync excludes server processing and labels one-way estimate', async t => {
  const { post, get, run } = await fixture(t);
  const c0 = 1000000;
  const response = await post('/api/sync', { clientId: 'timed', c0 });
  const { sampleId, s1, s2 } = response.data;
  const c3 = c0 + 20 + (s2 - s1);
  const report = await post('/api/measurement', { clientId: 'timed', sampleId, c3 });
  assert.equal(report.status, 200);
  assert.ok(Math.abs(report.data.rttMs - 20) < .00001);
  const offset = s1 - c0 - 10;
  assert.ok(Math.abs(report.data.offsetMs - offset) < .00001);
  const time = (await get('/api/state')).serverNowMs;
  await post('/api/action', { clientId: 'timed', sessionId: 's', sequence: 1, runId: run.runId, action: '上挥', sensorTimeMs: time - offset - 10 });
  const exported = await get('/api/export');
  assert.ok(exported.events[0].estimatedUplinkMs >= 10);
  assert.equal(exported.clients[0].syncReady, true);
  assert.ok(exported.definitions.estimatedUplinkMs.includes('symmetric'));
  assert.equal((await post('/api/measurement', { clientId: 'timed', sampleId, c3 })).status, 400);
});
test('invalid payloads and offset validation do not mutate accepted events', async t => {
  const { post, get } = await fixture(t);
  for (const value of [{}, [], { sessionId: 's', sequence: '1', action: '上挥' }]) assert.equal((await post('/api/action', value)).status, 400);
  assert.equal((await post('/api/settings', { offsetMs: 999 })).status, 400);
  assert.equal((await post('/api/settings', { offsetMs: 83 })).data.offsetMs, 85);
  const state = await get('/api/state');
  assert.equal(state.stats.received, 0);
  const csv = await fetch((await get('/api/config')).port ? `http://127.0.0.1:${state.port}/api/export.csv` : '');
  assert.ok((await csv.text()).includes('gameSessionVerified'));
});
test('distribution statistics handle even medians and nearest-rank P95', () => {
  assert.deepEqual(summarize([]).count, 0);
  assert.equal(summarize([1, 2, 3, 4]).median, 2.5);
  assert.equal(summarize(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
});
test('calibration records export and clear with each run; reconnect restores history', async t => {
  const { url, post, get, run } = await fixture(t);
  await post('/api/action', { sessionId: 'phone-a', sequence: 1, action: '上挥' });
  const trial = { runId: run.runId, errorMs: 27, offsetMs: 15, beatIndex: 3, eventId: 'trial', audioOutputTimestamp: true };
  assert.equal((await post('/api/calibration', trial)).status, 200);
  assert.equal((await post('/api/calibration', { ...trial, beatIndex: -1 })).status, 400);
  const exported = await get('/api/export');
  assert.equal(exported.calibration[0].errorMs, 27);
  assert.equal(exported.calibration[0].offsetMs, 15);
  const peer = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const [message] = await once(peer, 'message');
  assert.equal(JSON.parse(message).data.history.events.length, 1);
  peer.close();
  await post('/api/run', {});
  assert.deepEqual((await get('/api/export')).calibration, []);
  assert.equal((await post('/api/calibration', trial)).status, 400);
});
test('non-object payloads and reserved object property names cannot become game actions', async t => {
  const { post, get } = await fixture(t);
  for (const route of ['/api/settings', '/api/sync', '/api/calibration'])
    assert.equal((await post(route, null)).status, 400);
  for (const [sequence, action] of ['constructor', '__proto__', 'toString'].entries()) {
    const answer = await post('/api/action', { sessionId: 'reserved', sequence, action });
    assert.equal(answer.data.status, 'ignored');
    assert.equal(answer.data.action, null);
  }
  assert.equal((await get('/api/state')).stats.accepted, 0);
});
test('manual offset persists across server restarts without another browser overwriting it', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihayou-settings-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => { if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath); fs.rmdirSync(dir); });
  const first = await fixture(t, { settingsPath });
  await first.post('/api/settings', { offsetMs: 80 });
  const second = await fixture(t, { settingsPath });
  assert.equal((await second.get('/api/config')).offsetMs, 80);
  const peer = new WebSocket(second.url.replace('http:', 'ws:') + '/ws');
  const [hello] = await once(peer, 'message');
  assert.equal(JSON.parse(hello).data.offsetMs, 80);
  peer.close();
});

test('specified APK raw WebSocket actions relay, deduplicate, and remain connected without pong', { timeout: 16000 }, async t => {
  const { url, get } = await fixture(t);
  const observer = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const phone = new WebSocket(url.replace('http:', 'ws:') + '/sensor', { autoPong: false });
  t.after(() => { observer.terminate(); phone.terminate(); });
  const messages = [];
  observer.on('message', data => messages.push(JSON.parse(data)));
  await Promise.all([once(observer, 'open'), once(phone, 'open')]);
  await new Promise(resolve => setTimeout(resolve, 11200));
  assert.equal(phone.readyState, WebSocket.OPEN, 'send-only APK must not be killed by browser heartbeat');
  const raw = { type: 'action', sessionId: 'demo-001', sequence: 1, action: 'swing_up', sensorTimeMs: 123456.78 };
  phone.send(JSON.stringify(raw)); phone.send(JSON.stringify(raw));
  phone.send(JSON.stringify({ ...raw, sequence: 2, action: 'swing_down' }));
  const deadline = Date.now() + 2000;
  while (messages.filter(m => m.event === 'action').length < 2 && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  const actions = messages.filter(m => m.event === 'action');
  assert.deepEqual(actions.map(m => m.data.action), ['swing_up', 'swing_down']);
  assert.equal(actions[0].data.legacy, true);
  assert.equal(actions[0].data.transport, 'websocket');
  assert.equal(actions[0].data.estimatedUplinkMs, null);
  const state = await get('/api/state');
  assert.equal(state.stats.duplicate, 1);
  assert.equal(state.sensorConnections[0].actionCount, 3);
  assert.equal(state.latency.count, 0, 'no fabricated phone RTT');
  assert.equal(state.uplink.count, 0);
  phone.close(); await once(phone, 'close');
  assert.equal((await get('/api/state')).sensorConnections.length, 0);
});
