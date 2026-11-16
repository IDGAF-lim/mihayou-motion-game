'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createApp } = require('../server');

async function fixture(t) {
  const app = createApp(), address = await app.listen();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    // Simulated browser Bluetooth API; no physical radio or Android is exercised.
    const mock = window.__bleMock = { y: 0, auto: false, paused: false, count: 0, requests: 0 };
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
      async requestDevice() {
        mock.requests++;
        const device = new EventTarget(), characteristic = new EventTarget();
        let timer, sequence = 0;
        function send(kind, vector) {
          const v = new DataView(new ArrayBuffer(20));
          v.setUint8(0, 1); v.setUint8(1, kind); v.setUint16(2, sequence++, true);
          v.setUint32(4, Math.floor(performance.now() + 123000), true);
          vector.forEach((n, i) => v.setFloat32(8 + i*4, n, true));
          characteristic.value = v;
          characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
          mock.count++;
        }
        characteristic.startNotifications = async () => {
          timer = setInterval(() => {
            if (mock.paused) return;
            let y = mock.y;
            if (mock.auto && window.Mihayou) {
              const state = window.Mihayou.getState();
              for (const o of state.obstacles) {
                const age = state.musicTimeMs - o.hitTimeMs;
                const sign = o.type === 'ground' ? 1 : -1;
                if (age >= 0 && age < 80) y = sign * 6;
                else if (age >= 180 && age < 400) y = -sign * 6;
              }
            }
            send(2, [0, 0, 0]); send(1, [0, y, 9.80665]);
          }, 20);
          return characteristic;
        };
        device.gatt = {
          connected: false,
          async connect() { this.connected = true; return this; },
          async getPrimaryService() { return { getCharacteristic: async () => characteristic }; },
          disconnect() {
            clearInterval(timer); this.connected = false;
            device.dispatchEvent(new Event('gattserverdisconnected'));
          }
        };
        mock.device = device;
        return device;
      }
    } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/game/`);
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  return { page, errors };
}
async function connectAndCalibrate(page) {
  await page.locator('#ble-connect').click();
  await page.waitForFunction(() => !document.getElementById('ble-calibrate').disabled);
  assert.equal(await page.locator('#start').isDisabled(), true);
  await page.locator('#ble-calibrate').click();
  await page.waitForFunction(() => document.getElementById('ble-status').textContent === '请上挥一次');
  await page.evaluate(async () => {
    window.__bleMock.y = 6;
    await new Promise(resolve => setTimeout(resolve, 90));
    window.__bleMock.y = 0;
  });
  await page.waitForFunction(() => document.getElementById('ble-status').textContent === '已就绪');
  assert.equal(await page.locator('#start').isDisabled(), false);
}
async function screenshot(page, name) {
  const directory = process.env.TEST_ARTIFACTS_DIR || path.resolve(__dirname, '../test-artifacts');
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), fullPage: true });
}

test('simulated BLE raw frames calibrate on desktop and pass all 17 notes including natural return', { timeout: 45000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.locator('input[value="versus"]').check();
  await connectAndCalibrate(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('mihayou-link:phone-state', { detail: { sensorConnections: [] } }));
    window.__bleMock.auto = true;
  });
  assert.match(await page.locator('#phone-status').textContent(), /原始数据/);
  await page.locator('#start').click();
  await page.waitForFunction(() => window.Mihayou.getState().phase === 'playing');
  assert.equal(await page.locator('#ble-calibrate').isDisabled(), true);
  await page.waitForFunction(() => window.Mihayou.getState().ending?.kind === 'clear', null, { timeout: 35000 });
  const state = await page.evaluate(() => window.Mihayou.getState());
  assert.equal(state.passedCount, 17);
  assert.equal(state.ending.validScore, true);
  const accepted = (await page.locator('#log').textContent()).match(/"accepted":true/g) || [];
  assert.equal(accepted.length, 17);
  assert.ok(await page.evaluate(() => window.__bleMock.count > 2500));
  const pixels = await page.locator('#stage').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4*37) colors.add(Array.from(data.slice(i, i+4)).join(','));
    return colors.size;
  });
  assert.ok(pixels > 3, 'game canvas contains visible content');
  await screenshot(page, 'ble-simulated-clear-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, 'ble-simulated-mobile.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const overlaps = await page.locator('.ble-panel button').evaluateAll(buttons => {
    const rects = buttons.filter(b => !b.hidden).map(b => b.getBoundingClientRect());
    return rects.some((a, i) => rects.slice(i+1).some(b => Math.min(a.right,b.right)>Math.max(a.left,b.left) && Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)));
  });
  assert.equal(overlaps, false);
  await page.evaluate(() => { window.__bleMock.auto = false; });
  await page.locator('#next-player').click();
  assert.equal(await page.locator('#start').isDisabled(), true);
  assert.equal(await page.locator('#ble-calibrate').isDisabled(), false);
  await page.locator('#ble-calibrate').click();
  await page.waitForFunction(() => document.getElementById('ble-status').textContent === '请上挥一次');
  await page.evaluate(async () => {
    window.__bleMock.y = 6; await new Promise(resolve => setTimeout(resolve, 90)); window.__bleMock.y = 0;
  });
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  assert.deepEqual(errors, []);
});

test('BLE disconnect and stall invalidate rounds; reconnect requires fresh calibration; keyboard stays usable', { timeout: 20000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.locator('input[value="versus"]').check();
  await connectAndCalibrate(page);
  await page.locator('#start').click();
  await page.locator('#pause').click();
  await page.evaluate(() => window.__bleMock.device.gatt.disconnect());
  await page.waitForFunction(() => window.Mihayou.getState().ending?.kind === 'interrupted');
  assert.equal(await page.evaluate(() => window.Mihayou.getState().ending.validScore), false);
  assert.equal(await page.locator('#start').isDisabled(), true);
  await connectAndCalibrate(page);
  assert.equal(await page.locator('#difficulty').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__bleMock.requests), 2);
  await page.locator('#start').click();
  await page.locator('#pause').click();
  await page.evaluate(() => { window.__bleMock.paused = true; });
  await page.waitForFunction(() => document.getElementById('ble-status').textContent.includes('数据中断'));
  assert.equal(await page.evaluate(() => window.Mihayou.getState().ending.kind), 'interrupted');
  await page.locator('#ble-keyboard').click();
  await page.locator('#ready').click();
  assert.equal(await page.locator('#start').isDisabled(), false);
  await page.locator('#start').click();
  await page.waitForFunction(() => window.Mihayou.getState().phase === 'playing');
  await screenshot(page, 'ble-interruption-keyboard-recovery.png');
  assert.deepEqual(errors, []);
});
