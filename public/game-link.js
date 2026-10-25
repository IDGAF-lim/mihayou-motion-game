/* Load this adapter in the game's browser page, then call MihayouLink.connect(). */
(() => {
  'use strict';
  let socket = null, retry = null, reconnect = false, runId = null, generation = 0;
  let options = {}, recentClock = [], stopPing = null;
  function signal(name, detail) { window.dispatchEvent(new CustomEvent(`mihayou-link:${name}`, { detail })); }
  function connect(url, config = {}) {
    disconnect();
    if (!/^wss?:\/\//.test(url)) throw new Error('Expected ws:// or wss:// URL');
    options = config; reconnect = true;
    const currentGeneration = ++generation;
    function open() {
      if (currentGeneration !== generation) return;
      const current = new WebSocket(url); socket = current; recentClock = [];
      const ping = () => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ event: 'clock', c0: performance.now() })); };
      current.onopen = () => { signal('connection', { connected: true }); ping(); stopPing = setInterval(ping, 1000); };
      current.onmessage = e => {
        if (socket !== current) return;
        const receivedAtMs = performance.now();
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.event === 'clock') {
          recentClock.push({ at: receivedAtMs, rtt: receivedAtMs - msg.c0 - (msg.s2 - msg.s1), delta: ((msg.s1 - msg.c0) + (msg.s2 - receivedAtMs)) / 2 });
          recentClock = recentClock.filter(c => receivedAtMs - c.at < 30000).sort((a, b) => a.rtt - b.rtt).slice(0, 20);
        }
        if (msg.event === 'hello' || msg.event === 'run') {
          const previous = runId; runId = msg.data.runId;
          if (previous !== runId) signal('session', { runId });
          signal('offset', { offsetMs: msg.data.offsetMs });
          if (msg.data.clients) signal('phone-state', { clients: msg.data.clients, sensorConnections: msg.data.sensorConnections || [] });
        }
        if (msg.event === 'settings') signal('offset', msg.data);
        if (msg.event === 'state') signal('phone-state', { clients: msg.data.clients, sensorConnections: msg.data.sensorConnections || [] });
        if (msg.event !== 'action') return;
        const input = msg.data;
        if (input.isTest || input.sessionId !== runId) return;
        if (input.legacy && !options.allowLegacy) { signal('ignored', { reason: 'legacy-session-unverified', input }); return; }
        const best = recentClock[0];
        const estimatedServerAtMs = Number.isFinite(input.estimatedServerSourceMs) ?
          input.estimatedServerSourceMs :
          Number.isFinite(input.serverReceivedMs) ? input.serverReceivedMs : null;
        const estimatedBrowserAtMs = best && Number.isFinite(estimatedServerAtMs) ?
          estimatedServerAtMs - best.delta : null;
        const action = {
          sessionId: runId, phoneSessionId: input.phoneSessionId, sequence: input.sequence,
          action: input.action, type: input.action, strength: 1, source: 'phone',
          // Legacy APKs have no monotonic sensor timestamp. The game core
          // only uses receivedAtMs for timing, so use the browser receipt as
          // a validation placeholder and keep the estimate flag explicit.
          sensorTimeMs: Number.isFinite(input.sensorTimeMs) ? input.sensorTimeMs :
            input.legacy ? receivedAtMs : null, receivedAtMs,
          estimatedSourceAtMs: estimatedBrowserAtMs,
          arrivalAtMs: receivedAtMs,
          sourceTimingIsEstimate: true, gameSessionVerified: input.gameSessionVerified,
          payload: input
        };
        if (Number.isFinite(estimatedBrowserAtMs) && estimatedBrowserAtMs <= receivedAtMs) {
          action.receivedAtMs = estimatedBrowserAtMs;
        }
        const receiver = options.onAction || window.Mihayou?.receiveAction;
        if (receiver) receiver(action);
        signal('action', action);
      };
      current.onerror = () => {};
      current.onclose = () => {
        if (socket !== current) return;
        clearInterval(stopPing); signal('connection', { connected: false });
        if (reconnect && currentGeneration === generation) retry = setTimeout(open, 1500);
      };
    }
    open();
  }
  function disconnect() {
    reconnect = false; generation++; clearTimeout(retry); clearInterval(stopPing);
    const old = socket; socket = null; old?.close();
  }
  function toMusicTimeMs(action, audioContext, songStartContextTime, offsetMs = 0) {
    const output = audioContext.getOutputTimestamp?.();
    const contextTime = output && output.performanceTime > 0 ?
      output.contextTime + (action.receivedAtMs - output.performanceTime) / 1000 :
      audioContext.currentTime + (action.receivedAtMs - performance.now()) / 1000;
    return (contextTime - songStartContextTime) * 1000 - offsetMs;
  }
  window.MihayouLink = { connect, disconnect, toMusicTimeMs };
})();
