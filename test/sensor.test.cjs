'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readdirSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

function execute(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 25000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(Error(`${path.basename(file)} exited ${code}\n${output}`));
    });
  });
}
function javaFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? javaFiles(path.join(folder, entry.name)) :
      entry.name.endsWith('.java') ? [path.join(folder, entry.name)] : []);
}
test('enhanced phone transport synchronizes, sends and drops expired actions using the real server', { timeout: 60000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const javaHome = process.env.JAVA_HOME, jsonJar = process.env.JSON_JAR;
  assert.ok(javaHome && jsonJar && existsSync(jsonJar), 'Set JAVA_HOME and JSON_JAR (org.json JVM jar) to run native tests.');
  const javac = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const classes = mkdtempSync(path.join(tmpdir(), 'mihayou-native-'));
  t.after(() => rmSync(classes, { recursive: true, force: true }));
  const sources = javaFiles(path.join(root, 'android-sensor/src')).filter(file => !file.endsWith('MainActivity.java'));
  sources.push(...javaFiles(path.join(root, 'android-sensor/test')),
    path.join(root, 'android/src/com/mihayou/linktest/SwingDetector.java'),
    ...javaFiles(path.join(root, 'android/test')));
  await execute(javac, ['-encoding', 'UTF-8', '-cp', jsonJar, '-d', classes, ...sources]);
  const classpath = [classes, jsonJar].join(path.delimiter);
  const detector = await execute(java, ['-cp', classpath, 'com.mihayou.linktest.SwingDetectorTest']);
  assert.match(detector, /23 checks passed/);
  const app = createApp();
  const address = await app.listen();
  t.after(() => app.close());
  const output = await execute(java, ['-cp', classpath, 'com.mihayou.sensor.SensorLinkTest', `ws://127.0.0.1:${address.port}/sensor`]);
  assert.match(output, /2 sends, expired\/offline drops/);
  const data = await (await fetch(`http://127.0.0.1:${address.port}/api/export`)).json();
  assert.equal(data.stats.accepted, 2);
  assert.ok(data.latency.count > 0 && Number.isFinite(data.latency.median));
  assert.deepEqual(data.events.map(event => event.sequence), [1, 3]);
  assert.ok(data.events.every(event => event.gameSessionVerified && !event.legacy && event.transport === 'websocket'));
  assert.ok(data.events.every(event => Number.isFinite(event.estimatedUplinkMs)));
  console.log(detector.trim());
  console.log(output.trim());
});
