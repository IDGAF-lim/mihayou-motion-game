'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createApp } = require('../server');

async function fixture(t, viewport = { width: 1280, height: 1000 }) {
  const app = createApp();
  const address = await app.listen();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
  });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${address.port}`;
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.__qaBeepTimes = [];
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.__qaAudio = this; }
      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = time => { window.__qaBeepTimes.push(time); return start(time); };
        return oscillator;
      }
    };
  });
  await page.goto(base + '/game');
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  await page.evaluate(async () => {
    const post = async (route, data) => {
      const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      if (!response.ok) throw Error(await response.text());
      return response.json();
    };
    const clientId = 'browser-fixture', sessionId = crypto.randomUUID();
    const probe = await post('/api/sync', { clientId, c0: performance.now() });
    await post('/api/measurement', { clientId, sampleId: probe.sampleId, c3: performance.now() });
    let sequence = 0;
    window.__qaPhone = (action, sensorTimeMs = performance.now()) => post('/api/action', {
      clientId, sessionId, runId: probe.runId, sequence: ++sequence, action, sensorTimeMs
    });
    window.__qaPerformanceAt = time => {
      const context = window.__qaAudio, stamp = context.getOutputTimestamp?.();
      return stamp?.performanceTime > 0 ?
        stamp.performanceTime + (time - stamp.contextTime) * 1000 :
        performance.now() + (time - context.currentTime) * 1000;
    };
  });
  return { app, browser, page, errors, base };
}

async function screenshot(page, name) {
  const directory = process.env.TEST_ARTIFACTS_DIR || path.resolve(__dirname, '../test-artifacts');
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), fullPage: true });
}

test('real HTTP and WebSocket path reaches first obstacle; offset syncs and freezes per round', { timeout: 20000 }, async t => {
  const { page, browser, base, errors } = await fixture(t);
  const other = await browser.newPage();
  await other.goto(base + '/game/');
  await other.waitForFunction(() => !document.getElementById('start').disabled);
  await page.locator('#offset-slider').evaluate(element => { element.value = '100'; element.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.getElementById('offset-status').textContent.includes('已保存'));
  await other.waitForFunction(() => document.getElementById('offset').value === '100');
  await page.locator('#start').click();
  await page.waitForFunction(() => {
    const state = window.Mihayou.getState();
    return state.musicTimeMs >= 920 && state.musicTimeMs <= 1000;
  }, null, { polling: 5 });
  await page.evaluate(() => window.__qaPhone('swing_down'));
  await page.waitForFunction(() => window.Mihayou.getState().passedCount === 1);
  assert.equal(await page.locator('#offset-slider').isDisabled(), true);
  await other.locator('#offset').fill('200');
  await other.locator('#offset').dispatchEvent('change');
  await page.waitForFunction(() => document.getElementById('offset').value === '200');
  assert.equal(await page.evaluate(() => window.Mihayou.getState().offsetMs), 100);
  await page.locator('#stop').click();
  assert.equal(await page.evaluate(() => window.Mihayou.getState().ending.validScore), false);
  await page.locator('#ready').click();
  assert.equal(await page.evaluate(() => window.Mihayou.getState().offsetMs), 200);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('offset').value === '200');
  await screenshot(page, 'game-desktop.png');
  assert.deepEqual(errors, []);
});

test('specified APK raw WebSocket JSON passes all seventeen obstacles and reaches clear', { timeout: 45000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.locator('#start').click();
  await page.waitForFunction(() => window.Mihayou.getState().phase === 'playing');
  await page.evaluate(async () => {
    const session = crypto.randomUUID();
    const phone = new WebSocket(`ws://${location.host}/sensor`);
    await new Promise((resolve, reject) => { phone.onopen = resolve; phone.onerror = reject; });
    window.__rawSocket = phone;
    const obstacles = window.Mihayou.getState().obstacles;
    let sequence = 0;
    for (const obstacle of obstacles) {
      while (window.Mihayou.getState().musicTimeMs < obstacle.hitTimeMs) {
        if (window.Mihayou.getState().phase !== 'playing') throw Error('round ended before ' + obstacle.id);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      phone.send(JSON.stringify({ type: 'action', sessionId: session, sequence: ++sequence,
        sensorTimeMs: performance.now(), action: obstacle.type === 'ground' ? 'swing_up' : 'swing_down' }));
    }
  });
  await page.waitForFunction(() => window.Mihayou.getState().ending?.kind === 'clear', null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.Mihayou.getState().passedCount), 17);
  assert.equal(await page.evaluate(() => window.Mihayou.getState().ending.validScore), true);
  await screenshot(page, 'game-clear-simulated-sensor.png');
  assert.deepEqual(errors, []);
});

test('auto calibration schedules eight real beeps and accepts timestamped phone actions with one missed beat', { timeout: 25000 }, async t => {
  const { page, base, errors } = await fixture(t);
  await page.locator('#offset').fill('200');
  await page.locator('#offset').dispatchEvent('change');
  await page.waitForFunction(() => document.getElementById('offset-status').textContent.includes('已保存'));
  await page.locator('#auto-calibrate').click();
  assert.equal(await page.locator('#start').isDisabled(), true);
  await page.waitForFunction(() => window.__qaBeepTimes.length === 8);
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) {
      if (i === 2) continue;
      const target = window.__qaPerformanceAt(window.__qaBeepTimes[i]) + 100;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, target - performance.now())));
      // Timestamp is synthesized, but it traverses the actual HTTP, clock mapping and WebSocket path.
      if (i === 4) await window.__qaPhone('swing_down', target);
      await window.__qaPhone('swing_up', target);
    }
  });
  await page.waitForFunction(() => document.getElementById('calibration-status').textContent.startsWith('校准完成'));
  await page.waitForFunction(() => document.getElementById('offset-status').textContent.includes('已保存'));
  const offset = Number(await page.locator('#offset').inputValue());
  assert.ok(offset >= 85 && offset <= 115, `unexpected offset: ${offset}`);
  assert.equal(await page.locator('#start').isDisabled(), false);
  await page.waitForFunction(async () => (await (await fetch('/api/export')).json()).calibration.length === 7);
  const data = await (await fetch(base + '/api/export')).json();
  assert.equal(data.calibration.length, 7);
  assert.ok(Math.abs(data.offsetMs - 100) <= 15);
  await screenshot(page, 'game-auto-calibrated.png');
  assert.deepEqual(errors, []);
});

test('sparse calibration retains previous value; manual practice, cancel and mobile layout work', { timeout: 25000 }, async t => {
  const { page, errors } = await fixture(t, { width: 390, height: 844 });
  await page.locator('#offset-slider').evaluate(element => { element.value = '-75'; element.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.getElementById('offset-status').textContent.includes('已保存'));
  await page.locator('#auto-calibrate').click();
  await page.waitForFunction(() => document.getElementById('calibration-status').textContent.includes('校准未采用'), null, { timeout: 15000 });
  assert.equal(await page.locator('#offset').inputValue(), '-75');
  await page.locator('#practice').click();
  assert.equal(await page.locator('#offset-slider').isDisabled(), false);
  await page.waitForFunction(() => window.__qaBeepTimes.length > 8);
  await page.evaluate(async () => {
    const target = window.__qaPerformanceAt(window.__qaBeepTimes.at(-1));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, target - performance.now())));
    await window.__qaPhone('swing_up', target);
  });
  await page.waitForFunction(() => document.getElementById('calibration-status').textContent.includes('调整后'));
  await screenshot(page, 'game-mobile-practice.png');
  await page.locator('#offset-slider').evaluate(element => { element.value = '0'; element.dispatchEvent(new Event('input')); });
  const corrected = await page.locator('#calibration-status').textContent();
  assert.ok(Number(corrected.match(/(\d+) ms/)[1]) <= 15, corrected);
  await page.locator('#offset-slider').evaluate(element => { element.value = '-75'; element.dispatchEvent(new Event('input')); });
  await page.locator('#cancel-calibration').click();
  assert.equal(await page.locator('#start').isDisabled(), false);
  const layout = await page.evaluate(() => ({
    viewport: innerWidth, content: document.documentElement.scrollWidth,
    ink: document.getElementById('stage').getContext('2d').getImageData(175, 220, 1, 1).data[3]
  }));
  assert.ok(layout.content <= layout.viewport, JSON.stringify(layout));
  assert.ok(layout.ink > 0);
  await page.locator('#auto-calibrate').click();
  await page.locator('#ready').click();
  assert.equal(await page.locator('#auto-calibrate').isDisabled(), false);
  assert.equal(await page.locator('#offset').inputValue(), '-75');
  await page.locator('#auto-calibrate').click();
  await page.evaluate(() => fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  await page.waitForFunction(() => document.getElementById('calibration-status').textContent.includes('通信测试局已切换'));
  assert.equal(await page.locator('#cancel-calibration').isHidden(), true);
  assert.deepEqual(errors, []);
});

test('MihaSensor raw socket plays both rounds with fixed difficulty and offset, then exports scores', { timeout: 20000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => {
    const phone = new WebSocket(`ws://${location.host}/sensor`);
    await new Promise((resolve, reject) => { phone.onopen = resolve; phone.onerror = reject; });
    let sequence = 0;
    window.__rawPhone = action => phone.send(JSON.stringify({
      type: 'action', sessionId: 'demo-001', sequence: ++sequence, action, sensorTimeMs: performance.now()
    }));
    window.__rawSocket = phone;
  });
  await page.waitForFunction(() => document.getElementById('phone-status').textContent.includes('已连接'));
  await page.locator('input[value="versus"]').check();
  await page.locator('#name-1').fill('李明聿');
  await page.locator('#name-2').fill('队友');
  await page.locator('#difficulty').selectOption('hard');
  await page.locator('#offset-slider').evaluate(element => { element.value = '100'; element.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.getElementById('offset-status').textContent.includes('已保存'));
  await page.locator('#start').click();
  await page.waitForFunction(() => window.Mihayou.getState().phase === 'ended');
  assert.equal(await page.locator('#result-rows tr').count(), 1);
  assert.equal(await page.locator('#difficulty').isDisabled(), true);
  assert.equal(await page.locator('#result-rows tr').innerText().then(s => s.includes('李明聿')), true);
  await page.locator('#next-player').click();
  assert.equal(await page.locator('#auto-calibrate').isDisabled(), true);
  // Another page may save a new preference; both players keep the match's original value.
  await page.evaluate(() => fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"offsetMs":200}' }));
  await page.waitForFunction(() => document.getElementById('offset-status').textContent.includes('下一组'));
  assert.equal(await page.locator('#offset').inputValue(), '100');
  await page.locator('#start').click();
  assert.equal(await page.evaluate(() => window.Mihayou.getState().offsetMs), 100);
  await page.waitForFunction(() => window.Mihayou.getState().musicTimeMs >= 930, null, { polling: 5 });
  await page.evaluate(() => window.__rawPhone('swing_down'));
  await page.waitForFunction(() => window.Mihayou.getState().passedCount === 1);
  await page.waitForFunction(() => window.Mihayou.getState().phase === 'ended');
  assert.equal(await page.locator('#result-rows tr').count(), 2);
  assert.equal(await page.locator('#verdict').textContent(), '队友 获胜');
  const download = page.waitForEvent('download');
  await page.locator('#export-score').click();
  assert.equal((await download).suggestedFilename(), 'mihayou-scores.json');
  await screenshot(page, 'sensor-versus-results.png');
  await page.locator('#ready').click();
  await page.locator('#difficulty').selectOption('easy');
  assert.equal(await page.evaluate(() => window.Mihayou.getState().judgementWindowMs), 220);
  await page.setViewportSize({ width: 320, height: 740 });
  await screenshot(page, 'sensor-game-mobile-320.png');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
});

test('a disconnected sensor invalidates the round and offers retry to the same player', { timeout: 12000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => {
    const phone = new WebSocket(`ws://${location.host}/sensor`);
    await new Promise(resolve => { phone.onopen = resolve; });
    window.__rawSocket = phone;
  });
  await page.waitForFunction(() => document.getElementById('phone-status').textContent.includes('已连接'));
  await page.locator('input[value="versus"]').check();
  await page.locator('#start').click();
  await page.evaluate(() => window.__rawSocket.close());
  await page.waitForFunction(() => window.Mihayou.getState().ending?.kind === 'interrupted');
  assert.equal(await page.locator('#result-rows tr').count(), 0);
  assert.equal(await page.locator('#next-player').isHidden(), true);
  assert.ok((await page.locator('#start').textContent()).includes('重试'));
  assert.deepEqual(errors, []);
});

test('eight-beat calibration works with the specified send-only WebSocket protocol', { timeout: 16000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => {
    const phone = new WebSocket(`ws://${location.host}/sensor`);
    await new Promise(resolve => { phone.onopen = resolve; });
    window.__rawSocket = phone;
    let sequence = 0;
    window.__sensorSend = () => phone.send(JSON.stringify({
      type: 'action', sessionId: 'calibration-session', sequence: ++sequence, action: 'swing_up', sensorTimeMs: performance.now()
    }));
  });
  await page.locator('#auto-calibrate').click();
  await page.waitForFunction(() => window.__qaBeepTimes.length === 8);
  await page.evaluate(async () => {
    for (const beep of window.__qaBeepTimes) {
      const target = window.__qaPerformanceAt(beep) + 100;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, target - performance.now())));
      window.__sensorSend();
    }
  });
  await page.waitForFunction(() => document.getElementById('calibration-status').textContent.startsWith('校准完成'));
  const offset = Number(await page.locator('#offset').inputValue());
  assert.ok(offset >= 80 && offset <= 120, `raw socket calibration: ${offset}`);
  assert.deepEqual(errors, []);
});
