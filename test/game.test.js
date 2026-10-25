'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('../public/game/game');

function fixture({ offset = 0, grace = 250 } = {}) {
  let now = 0;
  const core = new Core({ now: () => now, lateArrivalGraceMs: grace });
  core.loadChart({ chartId: 'test', audio: 'test.mp3', durationMs: 3000, difficulty: 'normal',
    obstacles: [{ id: 'one', hitTimeMs: 1000, type: 'ground' }] });
  core.setCalibration(offset);
  core.start('run');
  return {
    core, at(time) { now = time; },
    action(time, sequence = 1) {
      return core.receiveAction({ sessionId: 'run', sequence, action: 'swing_up',
        source: 'phone', sensorTimeMs: time, receivedAtMs: time });
    }
  };
}

test('timestamped action arriving after normal deadline still matches within bounded grace', () => {
  const f = fixture();
  f.at(1200);
  f.core.tick();
  assert.equal(f.core.phase, 'playing');
  assert.equal(f.action(1000).matched, 'one');
  assert.equal(f.core.passed, 1);
  assert.equal(f.action(1000).reason, 'duplicate_or_out_of_order');
});

test('grace does not widen player timing or resurrect an expired obstacle', () => {
  const f = fixture();
  f.at(1300);
  assert.equal(f.action(1200).matched, null);
  f.at(1401);
  const result = f.action(1000, 2);
  assert.equal(result.accepted, false);
  assert.equal(f.core.phase, 'ended');
  assert.equal(f.core.passed, 0);
});

test('fixed offset is applied once and round cannot change its offset', () => {
  for (const offset of [-100, 100, 400]) {
    const f = fixture({ offset });
    f.at(1000 + offset + 180);
    const result = f.action(1000 + offset);
    assert.equal(result.matched, 'one');
    assert.equal(result.errorMs, 0);
    assert.throws(() => f.core.setCalibration(0));
  }
});

test('miss remains fatal, while paused and interrupted rounds reject input', () => {
  const f = fixture();
  f.at(100);
  f.core.pause();
  assert.equal(f.action(100).reason, 'not_playing');
  f.core.resume();
  f.at(1500);
  f.core.tick();
  assert.equal(f.core.ending.kind, 'dead');
  f.core.start('run');
  f.core.interrupt('lost');
  assert.equal(f.core.ending.validScore, false);
});
