'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../public/game/calibration');
const beats = Array.from({ length: 8 }, (_, i) => 1000 + i * 1000);

test('calibration uses median, handles missing beats, duplicates and one outlier', () => {
  const actions = beats.map((t, i) => t + [95, 100, 105, 90, 110, 100, 100, 430][i]);
  const complete = evaluate(beats, actions);
  assert.equal(complete.ok, true);
  assert.equal(complete.offsetMs, 100);
  assert.equal(complete.count, 7);
  const missing = evaluate(beats, actions.filter((_, i) => i !== 2).concat(actions[0] + 15));
  assert.equal(missing.ok, true);
  assert.equal(missing.offsetMs, 100);
  assert.equal(missing.count, 6);
});

test('calibration supports both signed limits, including offsets past half the old 750ms beat', () => {
  for (const value of [-200, -75, 0, 100, 400]) {
    const result = evaluate(beats, beats.map(t => t + value));
    assert.equal(result.ok, true);
    assert.equal(result.offsetMs, value);
  }
});

test('calibration refuses sparse, unstable and out of range samples', () => {
  assert.equal(evaluate(beats, beats.slice(0, 5)).reason, 'too_few');
  assert.equal(evaluate(beats, beats.map((t, i) => t + (i % 2 ? 250 : -100))).reason, 'unstable');
  assert.equal(evaluate(beats, beats.map(t => t + 440)).reason, 'out_of_range');
  assert.equal(evaluate(beats, [NaN, Infinity]).reason, 'too_few');
});
