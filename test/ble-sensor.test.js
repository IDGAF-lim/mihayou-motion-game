'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function detectorFixture() {
  const window = {};
  const context = { window, navigator: {}, performance: { now: () => 1000 } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/game/ble-sensor.js'), 'utf8'), context);
  const actions = [], states = [];
  const detector = new window.MihayouBleSensor.Detector(action => actions.push(action), state => states.push(state));
  return { detector, actions, states };
}

test('desktop detector calibrates direction, emits one action, then waits for cooldown and stillness', () => {
  const { detector, actions } = detectorFixture();
  detector.calibrate();
  detector.sample(0, 6, 0, 10);
  detector.sample(0, 6, 0, 30);
  detector.sample(0, 6, 0, 50);
  assert.equal(actions.length, 0);
  for (let time = 600; time <= 740; time += 20) detector.sample(0, 0, 0, time);
  detector.sample(0, 6, 0, 760);
  detector.sample(0, 6, 0, 780);
  detector.sample(0, 6, 0, 800);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'swing_up');
  assert.equal(actions[0].sensorTimeMs, 760);
  detector.sample(0, -8, 0, 900);
  assert.equal(actions.length, 1);
  for (let time = 1380; time <= 1520; time += 20) detector.sample(0, 0, 0, time);
  detector.sample(0, -6, 0, 1540);
  detector.sample(0, -6, 0, 1560);
  detector.sample(0, -6, 0, 1580);
  assert.equal(actions.length, 2);
  assert.equal(actions[1].action, 'swing_down');
});

test('desktop detector rejects perpendicular and subthreshold motion', () => {
  const { detector, actions } = detectorFixture();
  detector.calibrate();
  detector.sample(0, 6, 0, 10);
  detector.sample(0, 6, 0, 30);
  detector.sample(0, 6, 0, 50);
  for (let time = 600; time <= 740; time += 20) detector.sample(0, 0, 0, time);
  detector.sample(6, 0, 0, 760);
  detector.sample(6, 0, 0, 800);
  detector.sample(0, 2, 0, 820);
  detector.sample(0, 2, 0, 860);
  assert.equal(actions.length, 0);
});
