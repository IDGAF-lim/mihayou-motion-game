'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function detectorFixture() {
  const window = {};
  const context = { window, navigator: {}, performance, DataView,
    setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/game/ble-sensor.js'), 'utf8'), context);
  const actions = [], states = [];
  const detector = new window.MihayouBleSensor.Detector(action => actions.push(action), state => states.push(state));
  return { detector, actions, states, api: window.MihayouBleSensor };
}
function quiet(detector, from, to) {
  for (let time = from; time <= to; time += 20) detector.sample(0, 0, 0, time);
}
function taught() {
  const f = detectorFixture();
  f.detector.calibrate();
  for (let time = 0; time <= 40; time += 20) f.detector.sample(0, 6, 0, time);
  quiet(f.detector, 60, 740);
  return f;
}
function frame(kind = 1, sequence = 0, timestamp = 0, vector = [0, 0, 9.80665]) {
  const v = new DataView(new ArrayBuffer(20));
  v.setUint8(0, 1); v.setUint8(1, kind); v.setUint16(2, sequence, true); v.setUint32(4, timestamp, true);
  vector.forEach((n, i) => v.setFloat32(8 + i * 4, n, true));
  return v;
}

test('desktop detector calibrates direction, emits one action, then waits for cooldown and stillness', () => {
  const { detector, actions } = taught();
  assert.equal(actions.length, 0);
  detector.sample(0, 6, 0, 760);
  detector.sample(0, 6, 0, 780);
  detector.sample(0, 6, 0, 800);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'swing_up');
  assert.equal(actions[0].sensorTimeMs, 760);
  for (let time = 820; time <= 1340; time += 20) detector.sample(0, -8, 0, time);
  assert.equal(actions.length, 1);
  quiet(detector, 1360, 1520);
  detector.sample(0, -6, 0, 1540);
  detector.sample(0, -6, 0, 1560);
  detector.sample(0, -6, 0, 1580);
  assert.equal(actions.length, 2);
  assert.equal(actions[1].action, 'swing_down');
});

test('desktop detector rejects perpendicular and subthreshold motion', () => {
  const { detector, actions } = taught();
  detector.sample(6, 0, 0, 760);
  detector.sample(6, 0, 0, 800);
  detector.sample(0, 2, 0, 820);
  detector.sample(0, 2, 0, 860);
  assert.equal(actions.length, 0);
});

test('quiet samples, sign changes and packet gaps cancel a partial gesture', () => {
  for (const interrupt of ['quiet', 'sign', 'gap']) {
    const { detector, actions } = taught();
    detector.sample(0, 6, 0, 760);
    if (interrupt === 'quiet') detector.sample(0, 0, 0, 780);
    if (interrupt === 'sign') detector.sample(0, -6, 0, 780);
    detector.sample(0, 6, 0, interrupt === 'gap' ? 1000 : 800);
    assert.equal(actions.length, 0, interrupt);
  }
});

test('recovery requires sustained quiet but no opposite return motion', () => {
  const { detector, actions } = taught();
  for (let t = 760; t <= 800; t += 20) detector.sample(0, 6, 0, t, t + 100);
  quiet(detector, 820, 1500);
  for (let t = 1520; t <= 1560; t += 20) detector.sample(0, 6, 0, t, t + 100);
  assert.equal(actions.length, 2);
  assert.ok(actions.every(a => a.action === 'swing_up'));
  assert.equal(actions[0].receivedAtMs, 860);
  assert.equal(actions[0].sensorTimeMs, 760);
});

test('uncalibrated motion never implicitly teaches direction; round reset clears candidates', () => {
  const f = detectorFixture();
  f.detector.sample(0, 6, 0, 0); f.detector.sample(0, 6, 0, 40);
  assert.equal(f.detector.axis, null);
  const { detector, actions } = taught();
  detector.sample(0, 6, 0, 760); detector.resetMotion(); detector.sample(0, 6, 0, 800);
  assert.equal(actions.length, 0);
  assert.ok(detector.axis);
});

test('protocol validates version, exact length, finite values and pose norm', () => {
  const { api } = detectorFixture();
  assert.equal(api.decodePacket(frame()).kind, 1);
  for (const v of [new DataView(new ArrayBuffer(19)), frame(3), frame(1, 0, 0, [NaN, 0, 0]),
    frame(2, 0, 0, [2, 0, 0]), frame(1, 0, 0, [201, 0, 0])])
    assert.equal(api.decodePacket(v), null);
  const version = frame(); version.setUint8(0, 2);
  assert.equal(api.decodePacket(version), null);
});

test('packet clock unwraps both counters, rejects replay and bounds relative backlog', () => {
  const { api } = detectorFixture(), clock = new api.PacketClock();
  const accept = (s, t, a) => clock.accept(api.decodePacket(frame(1, s, t)), a);
  assert.ok(accept(65535, 4294967290, 100));
  assert.equal(accept(0, 14, 120).time, 4294967310);
  assert.equal(accept(0, 14, 121), null);
  assert.equal(accept(65534, 13, 122), null);
  assert.equal(accept(2, 34, 500), null);
  assert.equal(clock.dropped, 1);
  assert.ok(accept(3, 414, 520));
});

test('desktop grip calibration removes gravity, compensates pose and suppresses stale pose', () => {
  const { api } = detectorFixture(), actions = [];
  const motion = new api.MotionInput(a => actions.push(a));
  const sample = (time, y = 0, pose = [0, 0, 0]) => {
    if (pose) motion.sample({ kind: 2, time, arrival: time, vector: pose });
    motion.sample({ kind: 1, time, arrival: time, vector: [0, y, 9.80665] });
  };
  motion.calibrate();
  for (let t = 0; t <= 1100; t += 20) sample(t);
  assert.equal(motion.phase, 'motion');
  assert.equal(motion.detector.axis, null);
  for (let t = 1120; t <= 1160; t += 20) sample(t, 6);
  for (let t = 1180; t <= 1900; t += 20) sample(t);
  assert.equal(motion.ready, true);
  // A 90-degree rotation about Z maps the phone X axis into the taught world Y axis.
  const pose = [0, 0, Math.SQRT1_2];
  for (let t = 1920; t <= 1960; t += 20) {
    motion.sample({ kind: 2, time: t, vector: pose });
    motion.sample({ kind: 1, time: t, arrival: t + 5, vector: [6, 0, 9.80665] });
  }
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'swing_up');
  for (let t = 1980; t <= 2900; t += 20) sample(t, 0, null);
  assert.equal(motion.ready, false);
  motion.reset();
  assert.equal(motion.phase, 'idle');
  assert.equal(motion.detector.axis, null);
});

test('accelerometer-only fallback calibrates and recognizes without phone preprocessing', () => {
  const { api } = detectorFixture(), actions = [], motion = new api.MotionInput(a => actions.push(a));
  motion.calibrate();
  const send = (t, y) => motion.sample({ kind: 1, time: t, arrival: t, vector: [0, y, 9.80665] });
  for (let t = 0; t <= 1100; t += 20) send(t, 0);
  for (let t = 1120; t <= 1160; t += 20) send(t, 6);
  for (let t = 1180; t <= 2100; t += 20) send(t, 0);
  for (let t = 2120; t <= 2160; t += 20) send(t, 6);
  assert.equal(actions.length, 1);
});

function radio(options = {}) {
  const characteristic = new EventTarget(), device = new EventTarget();
  let subscriptions = 0;
  const notify = value => {
    characteristic.value = value;
    characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  characteristic.startNotifications = async () => {
    subscriptions++;
    if (options.fail) throw Error('subscription failed');
    if (options.initial) notify(frame());
    return characteristic;
  };
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    async getPrimaryService() { return { getCharacteristic: async () => characteristic }; },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); }
  };
  return { device, characteristic, notify, bluetooth: { requestDevice: async () => device },
    get subscriptions() { return subscriptions; } };
}
test('BLE installs listener before subscription and disconnects with one cleanup callback', async () => {
  const { api } = detectorFixture(), mock = radio({ initial: true }), packets = [], closed = [];
  const connection = new api.Connection(p => packets.push(p), reason => closed.push(reason), { bluetooth: mock.bluetooth });
  await connection.connect();
  assert.equal(packets.length, 1);
  mock.device.gatt.disconnect(); connection.close();
  mock.notify(frame(1, 1, 20));
  assert.equal(packets.length, 1);
  assert.equal(closed.length, 1);
  assert.equal(mock.device.gatt.connected, false);
});
test('failed subscription and late setup completion both release the GATT connection', async () => {
  const { api } = detectorFixture(), mock = radio({ fail: true });
  const connection = new api.Connection(() => {}, () => {}, { bluetooth: mock.bluetooth });
  await assert.rejects(connection.connect(), /subscription failed/);
  assert.equal(mock.device.gatt.connected, false);
  const late = radio(); let finish;
  late.device.gatt.connect = () => new Promise(resolve => { finish = () => {
    late.device.gatt.connected = true; resolve(late.device.gatt);
  }; });
  const timed = new api.Connection(() => {}, () => {}, { bluetooth: late.bluetooth, setupMs: 15 });
  await assert.rejects(timed.connect(), /超时/);
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(late.device.gatt.connected, false);
  assert.equal(late.subscriptions, 0);
});
test('pose packets alone cannot keep a stalled acceleration stream connected', async t => {
  const { api } = detectorFixture(), mock = radio(), closed = [];
  const connection = new api.Connection(() => {}, reason => closed.push(reason),
    { bluetooth: mock.bluetooth, stallMs: 30 });
  t.after(() => connection.close());
  await connection.connect();
  for (let i = 0; i < 6; i++) {
    mock.notify(frame(2, i, i * 10, [0, 0, 0]));
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  assert.equal(connection.closed, true);
  assert.match(closed[0], /数据中断/);
});
