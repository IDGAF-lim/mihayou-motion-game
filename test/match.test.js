'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Match, chartFor } = require('../public/game/match');
const { Core } = require('../public/game/game');
const base = require('../public/game/funny-pigs-nomal.json');
function result(passed, survivedMs, kind = 'dead') {
  return { phase: 'ended', passedCount: passed, musicTimeMs: survivedMs,
    durationMs: 30004, obstacles: base.obstacles, offsetMs: 100,
    ending: { kind, validScore: kind !== 'interrupted' } };
}
test('difficulty keeps original beat positions and types; easy leaves room for return motions', () => {
  const original = JSON.stringify(base);
  const easy = chartFor(base, 'easy'), normal = chartFor(base, 'normal'), hard = chartFor(base, 'hard');
  assert.ok(easy.obstacles.length < normal.obstacles.length);
  assert.deepEqual(normal.obstacles, base.obstacles);
  assert.deepEqual(hard.obstacles, base.obstacles);
  for (const o of easy.obstacles) assert.deepEqual(o, base.obstacles.find(b => b.id === o.id));
  assert.ok(easy.obstacles.slice(1).every((o, i) => o.hitTimeMs - easy.obstacles[i].hitTimeMs >= 2300));
  assert.equal(JSON.stringify(base), original);
  for (const [difficulty, expected] of [['easy', true], ['normal', true], ['hard', false]]) {
    let now = 0;
    const core = new Core({ now: () => now });
    core.loadChart(chartFor(base, difficulty)); core.start('one');
    now = base.obstacles[0].hitTimeMs + 140;
    const action = core.receiveAction({ sessionId: 'one', sequence: 1, action: 'swing_down', receivedAtMs: now, source: 'keyboard' });
    assert.equal(!!action.matched, expected, difficulty);
  }
});
test('two-player match advances only for valid scores, compares passes then survival, and ties clears', () => {
  const match = new Match({ mode: 'versus', names: ['李明聿', '队友'] });
  assert.equal(match.record(result(3, 6000, 'interrupted')), false);
  assert.equal(match.currentName, '李明聿');
  match.record(result(3, 6000));
  assert.equal(match.currentName, '队友');
  assert.equal(match.complete, false);
  match.record(result(4, 7000));
  assert.equal(match.verdict(), '队友 获胜');
  assert.equal(match.record(result(17, 30004, 'clear')), false);
  const tie = new Match({ mode: 'versus' });
  tie.record(result(17, 30004, 'clear')); tie.record(result(17, 30005, 'clear'));
  assert.equal(tie.verdict(), '平局 · 两人均通关');
  const survival = new Match({ mode: 'versus' });
  survival.record(result(3, 6000)); survival.record(result(3, 6200));
  assert.equal(survival.verdict(), '玩家 2 获胜');
  const frameTie = new Match({ mode: 'versus' });
  for (const observed of [1300, 1316]) {
    const state = result(0, observed);
    state.obstacles = [{ id: 'one', hitTimeMs: 852, status: 'missed' }];
    frameTie.record(state);
  }
  assert.equal(frameTie.verdict(), '平局', 'frame scheduling and grace must not decide equal failures');
});
test('a new phone detection session can restart its sequence during the same round', () => {
  let now = 0;
  const core = new Core({ now: () => now });
  core.loadChart(base); core.start('run');
  const action = (phoneSessionId, sequence) => core.receiveAction({
    sessionId: 'run', phoneSessionId, sequence, action: 'swing_down', receivedAtMs: now, sensorTimeMs: now, source: 'phone'
  });
  now = 100; assert.equal(action('first', 50).accepted, true);
  now = 200; assert.equal(action('second', 1).accepted, true);
  assert.equal(action('second', 1).reason, 'duplicate_or_out_of_order');
});
