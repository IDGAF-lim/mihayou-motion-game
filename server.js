'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { WebSocketServer, WebSocket } = require('./vendor/ws');

const names = { '上挥': 'swing_up', '下挥': 'swing_down', swing_up: 'swing_up', swing_down: 'swing_down' };
const mono = () => performance.now();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value : null;
const maxRows = 5000;
function summarize(values) {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (!xs.length) return { count: 0, median: null, p95: null, min: null, max: null, spread: null };
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  const p95 = xs[Math.max(0, Math.ceil(xs.length * .95) - 1)];
  return { count: xs.length, median, p95, min: xs[0], max: xs.at(-1), spread: p95 - xs[0] };
}
function createApp(options = {}) {
  let runId = randomUUID(), offsetMs = 0;
  if (options.settingsPath && fs.existsSync(options.settingsPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(options.settingsPath, 'utf8')).offsetMs;
      if (finite(saved) && saved >= -200 && saved <= 400) offsetMs = Math.round(saved / 5) * 5;
    } catch {}
  }
  let events = [], measurements = [], calibration = [], clients = new Map(), sources = new Map(), activeSessions = new Map();
  const sensorPeers = new Map();
  let stats = freshStats();
  function freshStats() { return { received: 0, accepted: 0, ignored: 0, duplicate: 0, stale: 0, sequenceGaps: 0 }; }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  function broadcast(message) {
    const body = JSON.stringify(message);
    for (const peer of wss.clients) if (peer.readyState === WebSocket.OPEN && !sensorPeers.has(peer)) peer.send(body);
  }
  function ips() {
    return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
      addresses.filter(a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
        .map(a => ({ name, address: a.address })));
  }
  function config() {
    return { runId, offsetMs, port: server.address()?.port, addresses: ips(), version: '1.0.0' };
  }
  function state() {
    const now = mono();
    return {
      ...config(), serverNowMs: now, stats, retainedEvents: events.length,
      latency: summarize(measurements.map(m => m.rttMs)),
      uplink: summarize(events.map(e => e.estimatedUplinkMs)),
      sensorConnections: [...sensorPeers.values()].map(c => ({
        connectionId: c.id, connected: true, actionCount: c.actionCount,
        lastActionAgeMs: c.lastActionAt === null ? null : now - c.lastActionAt
      })),
      clients: [...clients.values()].map(c => ({
        clientId: c.clientId, label: c.label, ageMs: now - c.lastSeen,
        online: now - c.lastSeen < 5500,
        syncReady: !!c.best && now - c.best.acceptedAt < 30000,
        bestRttMs: c.best?.rttMs ?? null, syncAgeMs: c.best ? now - c.best.acceptedAt : null
      }))
    };
  }
  function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 65536) throw Object.assign(new Error('Body exceeds 64KB'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  function client(id, label) {
    if (typeof id !== 'string' || !id || id.length > 120) throw Object.assign(new Error('Invalid clientId'), { status: 400 });
    if (!clients.has(id)) {
      if (clients.size >= 100) throw Object.assign(new Error('Too many devices; restart server'), { status: 429 });
      clients.set(id, { clientId: id, label: String(label || 'Android').slice(0, 80), samples: [], pending: new Map() });
    }
    const c = clients.get(id);
    c.lastSeen = mono();
    return c;
  }
  function addAction(input, received, transport = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Expected event object'), { status: 400 });
    const sourceSessionId = input.sessionId ?? input.session_id;
    const sequence = input.sequence;
    const rawAction = input.action;
    if (typeof sourceSessionId !== 'string' || !sourceSessionId || sourceSessionId.length > 120 ||
        !Number.isSafeInteger(sequence) || sequence < 0 || typeof rawAction !== 'string' || rawAction.length > 120) {
      throw Object.assign(new Error('Need session_id/sessionId, nonnegative integer sequence, and action'), { status: 400 });
    }
    const sourceId = String(input.clientId || transport.sourceId || 'legacy-phone').slice(0, 120);
    stats.received++;
    const mapped = Object.hasOwn(names, rawAction) ? names[rawAction] : null;
    let status = mapped ? 'accepted' : 'ignored';
    const key = `${sourceId}:${sourceSessionId}`;
    if (!sources.has(key) && sources.size >= 1000) throw Object.assign(new Error('Too many sessions; restart server'), { status: 429 });
    const previous = sources.get(key) || { high: -1, seen: new Set() };
    const active = activeSessions.get(sourceId) || { current: sourceSessionId, retired: new Set() };
    if (input.runId && input.runId !== runId) status = 'stale';
    else if (active.retired.has(sourceSessionId)) status = 'stale';
    else if (previous.seen.has(sequence)) status = 'duplicate';
    else if (sequence < previous.high) status = 'stale';
    else {
      if (previous.high >= 0 && sequence > previous.high + 1) stats.sequenceGaps += sequence - previous.high - 1;
      previous.high = sequence;
      previous.seen.add(sequence);
      if (previous.seen.size > 2000) previous.seen.delete(previous.seen.values().next().value);
      sources.set(key, previous);
      if (active.current !== sourceSessionId) { active.retired.add(active.current); active.current = sourceSessionId; }
      activeSessions.set(sourceId, active);
    }
    const c = clients.get(input.clientId);
    const sourceTimeMs = number(input.sensorTimeMs ?? input.elapsed_realtime_ms);
    const best = c?.best && received - c.best.acceptedAt < 30000 ? c.best : null;
    const estimatedServerSourceMs = best && sourceTimeMs !== null ? sourceTimeMs + best.offsetMs : null;
    const estimatedUplinkMs = estimatedServerSourceMs !== null ? received - estimatedServerSourceMs : null;
    const row = {
      id: randomUUID(), runId, sourceSessionId, sequence, action: mapped, rawAction, status,
      clientId: sourceId, isTest: input.isTest === true,
      batchId: typeof input.batchId === 'string' ? input.batchId.slice(0, 80) : null,
      sensorTimeMs: sourceTimeMs, serverReceivedMs: received, receivedIso: new Date().toISOString(),
      estimatedUplinkMs, syncBestRttMs: best?.rttMs ?? null,
      syncAgeMs: best ? received - best.acceptedAt : null,
      syncOffsetMs: best?.offsetMs ?? null,
      legacy: !input.clientId, gameSessionVerified: input.runId === runId,
      estimatedServerSourceMs, transport: transport.websocket ? 'websocket' : 'http'
    };
    stats[status]++;
    events.push(row);
    if (events.length > maxRows) events.shift();
    broadcast({ event: 'record', data: row });
    if (status === 'accepted') {
      broadcast({
        event: 'action',
        data: { ...row, type: mapped, strength: 1, timestamp: Date.now(), source: 'phone',
          sessionId: runId, phoneSessionId: sourceSessionId }
      });
    }
    return { ok: true, status, runId, sequence, action: mapped };
  }
  const server = http.createServer(async (req, res) => {
    const received = mono();
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, config());
      if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, state());
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const data = { exportedAt: new Date().toISOString(), ...state(), events, measurements, calibration,
          definitions: {
            rttMs: 'Phone request round trip minus server processing, measured on one phone monotonic clock.',
            estimatedUplinkMs: 'Server arrival minus phone source time mapped by recent minimum-RTT four-timestamp sync; assumes roughly symmetric network.',
            sequenceGaps: 'Observed skipped source sequence numbers, not proven network packet loss.',
            legacy: 'Supplied sensor APK sends raw WebSocket actions without clock-sync replies; phone RTT and one-way latency are unavailable and game session cannot be verified.',
            offsetMs: 'Manual judgement offset; not measured network delay.'
          } };
        res.setHeader('Content-Disposition', 'attachment; filename="mihayou-test.json"');
        return sendJson(res, 200, data);
      }
      if (req.method === 'GET' && url.pathname === '/api/export.csv') {
        const fields = ['receivedIso', 'runId', 'clientId', 'sourceSessionId', 'sequence', 'rawAction', 'action', 'status',
          'isTest', 'batchId', 'sensorTimeMs', 'serverReceivedMs', 'estimatedUplinkMs', 'syncBestRttMs', 'syncAgeMs', 'gameSessionVerified'];
        const quote = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mihayou-events.csv"' });
        return res.end('\ufeff' + [fields, ...events.map(e => fields.map(f => e[f]))].map(r => r.map(quote).join(',')).join('\r\n'));
      }
      if (req.method === 'POST') {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input))
          return sendJson(res, 400, { error: 'Expected JSON object' });
        if (url.pathname === '/api/run') {
          runId = randomUUID(); events = []; measurements = []; calibration = []; stats = freshStats();
          broadcast({ event: 'run', data: config() });
          return sendJson(res, 200, config());
        }
        if (url.pathname === '/api/settings') {
          if (!finite(input.offsetMs) || input.offsetMs < -200 || input.offsetMs > 400) return sendJson(res, 400, { error: 'offsetMs must be -200..400' });
          const selected = Math.round(input.offsetMs / 5) * 5;
          if (options.settingsPath) fs.writeFileSync(options.settingsPath, JSON.stringify({ offsetMs: selected }));
          offsetMs = selected;
          broadcast({ event: 'settings', data: { offsetMs } });
          return sendJson(res, 200, { offsetMs });
        }
        if (url.pathname === '/api/calibration') {
          if (input.runId !== runId || !finite(input.errorMs) || !finite(input.offsetMs) ||
              input.offsetMs < -200 || input.offsetMs > 400 ||
              !Number.isSafeInteger(input.beatIndex) || input.beatIndex < 0 || Math.abs(input.errorMs) > 1000)
            return sendJson(res, 400, { error: 'Invalid calibration sample' });
          calibration.push({ runId, errorMs: input.errorMs, offsetMs: input.offsetMs,
            beatIndex: input.beatIndex, receivedIso: new Date().toISOString(), eventId: String(input.eventId || '').slice(0, 80),
            audioOutputTimestamp: input.audioOutputTimestamp === true });
          if (calibration.length > maxRows) calibration.shift();
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/sync') {
          const c = client(input.clientId, input.label);
          if (!finite(input.c0)) return sendJson(res, 400, { error: 'Need monotonic c0' });
          const sampleId = randomUUID(), s2 = mono();
          for (const [id, old] of c.pending) if (s2 - old.s2 > 10000) c.pending.delete(id);
          if (c.pending.size >= 30) return sendJson(res, 429, { error: 'Too many pending probes' });
          c.pending.set(sampleId, { sampleId, c0: input.c0, s1: received, s2, runId });
          return sendJson(res, 200, { sampleId, c0: input.c0, s1: received, s2, runId });
        }
        if (url.pathname === '/api/measurement') {
          const c = client(input.clientId, input.label), pending = c.pending.get(input.sampleId);
          if (!pending || !finite(input.c3)) return sendJson(res, 400, { error: 'Unknown sample or invalid c3' });
          c.pending.delete(input.sampleId);
          if (pending.runId !== runId) return sendJson(res, 409, { error: 'Test session changed; measure again' });
          const { c0, s1, s2 } = pending, c3 = input.c3;
          const rttMs = (c3 - c0) - (s2 - s1);
          if (rttMs < 0 || rttMs > 10000 || mono() - s2 > 15000) return sendJson(res, 400, { error: 'Invalid or expired timing sample' });
          const sample = { ...pending, c3, rttMs, offsetMs: ((s1 - c0) + (s2 - c3)) / 2, acceptedAt: mono(), clientId: c.clientId, runId };
          c.samples = c.samples.filter(m => sample.acceptedAt - m.acceptedAt < 30000);
          c.samples.push(sample);
          c.best = c.samples.reduce((best, m) => m.rttMs < best.rttMs ? m : best);
          measurements.push(sample);
          if (measurements.length > maxRows) measurements.shift();
          broadcast({ event: 'measurement', data: sample });
          return sendJson(res, 200, { ok: true, rttMs, offsetMs: c.best.offsetMs, runId });
        }
        if (['/api/action', '/action', '/events', '/'].includes(url.pathname)) return sendJson(res, 200, addAction(input, received));
        return sendJson(res, 404, { error: 'Unknown endpoint' });
      }
      const files = {
        '/': ['public/index.html', 'text/html; charset=utf-8'],
        '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
        '/lucide.js': ['public/lucide.js', 'text/javascript; charset=utf-8'],
        '/game-link.js': ['public/game-link.js', 'text/javascript; charset=utf-8'],
        '/apps/link-test.apk': ['apps/MihayouLinkTest.apk', 'application/vnd.android.package-archive'],
        '/apps/motion-controller.apk': ['apps/MihayouMotionController.apk', 'application/vnd.android.package-archive'],
        '/apps/sensor.apk': ['apps/MihaSensor-debug-0.4.9.apk', 'application/vnd.android.package-archive'],
        '/apps/sensor-integrated.apk': ['apps/MihaSensor-integrated.apk', 'application/vnd.android.package-archive']
      };
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/game') { res.writeHead(302, { Location: '/game/' }); return res.end(); }
      if (req.method === 'GET' && (url.pathname === '/game' || url.pathname.startsWith('/game/'))) {
        const requested = (url.pathname === '/game' || url.pathname === '/game/') ?
          'index.html' : decodeURIComponent(url.pathname.slice('/game/'.length));
        if (!requested || requested.includes('\0') || requested.split('/').includes('..')) {
          return sendJson(res, 400, { error: 'Invalid game asset path' });
        }
        const target = path.join(__dirname, 'public', 'game', requested);
        const root = path.resolve(path.join(__dirname, 'public', 'game'));
        if (!path.resolve(target).startsWith(root + path.sep) && path.resolve(target) !== root) {
          return sendJson(res, 400, { error: 'Invalid game asset path' });
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return sendJson(res, 404, { error: 'Game asset not found' });
        const mime = {
          '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
          '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
        }[path.extname(target).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        return fs.createReadStream(target).pipe(res);
      }
      const file = files[url.pathname];
      if (req.method !== 'GET' || !file) return sendJson(res, 404, { error: 'Not found' });
      const target = path.join(__dirname, file[0]);
      if (!fs.existsSync(target)) return sendJson(res, 404, { error: 'File not built yet' });
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
      fs.createReadStream(target).pipe(res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Server error' });
      else res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (!['/ws', '/sensor', '/'].includes(pathname)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, peer => wss.emit('connection', peer, req));
  });
  wss.on('connection', (peer, req) => {
    peer.alive = true;
    function registerSensor() {
      if (!sensorPeers.has(peer)) sensorPeers.set(peer, { id: randomUUID(), actionCount: 0, lastActionAt: null });
      return sensorPeers.get(peer);
    }
    if (new URL(req.url, 'http://local').pathname === '/sensor') registerSensor();
    peer.on('close', () => { sensorPeers.delete(peer); });
    peer.on('pong', () => { peer.alive = true; });
    peer.on('error', () => {});
    if (!sensorPeers.has(peer)) peer.send(JSON.stringify({ event: 'hello', data: {
      ...state(), history: { events, measurements: measurements.slice(-60) }
    } }));
    peer.on('message', data => {
      const s1 = mono();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'clock' && finite(msg.c0)) peer.send(JSON.stringify({ event: 'clock', c0: msg.c0, s1, s2: mono() }));
        else if (msg.type === 'action') {
          const sensor = registerSensor();
          addAction(msg, s1, { sourceId: 'sensor-' + sensor.id, websocket: true });
          sensor.actionCount++;
          sensor.lastActionAt = s1;
          // Do not fill the receive buffer of the send-only phone.
        }
      } catch (error) { peer.send(JSON.stringify({ event: 'error', message: error.status ? error.message : 'Invalid action or JSON' })); }
    });
  });
  const ticker = setInterval(() => broadcast({ event: 'state', data: state() }), 1000);
  const heartbeat = setInterval(() => {
    for (const peer of wss.clients) {
      // The supplied APK has a send-only socket and never reads ping frames.
      if (sensorPeers.has(peer)) continue;
      if (!peer.alive) peer.terminate();
      else { peer.alive = false; peer.ping(); }
    }
  }, 5000);
  ticker.unref(); heartbeat.unref();
  function close() {
    clearInterval(ticker); clearInterval(heartbeat);
    for (const peer of wss.clients) peer.terminate();
    wss.close();
    return new Promise(resolve => server.close(resolve));
  }
  return { server, close, state, listen: (port = 0, host = '127.0.0.1') => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))) };
}
if (require.main === module) {
  fs.mkdirSync(path.join(__dirname, 'runtime'), { recursive: true });
  const requested = Number(process.env.PORT || 8765);
  const app = createApp({ settingsPath: path.join(__dirname, 'runtime', 'settings.json') });
  let candidate = requested;
  app.server.on('error', error => {
    if (error.code === 'EADDRINUSE' && candidate < requested + 20) app.server.listen(++candidate, '0.0.0.0');
    else { console.error(error.message); process.exit(1); }
  });
  app.server.on('listening', () => {
    const port = app.server.address().port;
    const info = { pid: process.pid, port, url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, 'runtime', 'server-info.json'), JSON.stringify(info));
    console.log(`Mihayou: ${info.url}`);
  });
  app.server.listen(requested, '0.0.0.0');
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}
module.exports = { createApp, summarize };
