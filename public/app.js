(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const names = { swing_up: '上挥', swing_down: '下挥' };
  const statusNames = { accepted: '已转发', ignored: '非游戏动作', duplicate: '重复拦截', stale: '过期拦截' };
  let rows = [], samples = [], state = null, socket, retry, closing = false;
  let up = 0, down = 0, flashTimer, clockSamples = [];
  let audio = null, beatStart = 0, beatTimer = null, usedBeats = new Set(), errors = [], offsetRequest = 0;
  const icons = () => window.lucide?.createIcons();
  const ms = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} <em>ms</em>` : '—';
  function notice(text) { $('notice').textContent = text; }
  async function post(url, value) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!response.ok) throw new Error(`请求失败 ${response.status}`);
    return response.json();
  }
  function updateState(next) {
    state = next;
    $('run-id').textContent = `测试 ${next.runId.slice(0, 8)}`;
    $('rtt').innerHTML = ms(next.latency.median);
    $('p95').innerHTML = ms(next.latency.p95);
    $('uplink').innerHTML = ms(next.uplink.median);
    $('sample-count').textContent = `${next.latency.count} 个实测样本`;
    $('uplink-note').textContent = next.uplink.count ? `${next.uplink.count} 个样本 · 对称链路假设下的估算` : '增强版同步后可显示；原包 v0.4.9 无此数据';
    $('counts').textContent = `${next.stats.received} / ${next.stats.accepted}`;
    $('counts-note').textContent = `非游戏动作 ${next.stats.ignored} · 记录保留最近 5000 条`;
    $('gaps').textContent = `序号跳号 ${next.stats.sequenceGaps} · 重复 ${next.stats.duplicate} · 过期 ${next.stats.stale}`;
    const online = next.clients.filter(c => c.online);
    const sensors = next.sensorConnections || [];
    $('device-state').textContent = sensors.length ? `MihaSensor 已连接 ${sensors.length} 台 · 收到 ${sensors.reduce((n, c) => n + c.actionCount, 0)} 次消息` : online.length ? online.map(c => `${c.label} · ${c.syncReady ? '已同步' : '同步中'}`).join('；') :
      rows.some(r => r.legacy) ? '已收到旧版体感动作；旧版无心跳，空闲不代表断线' : '等待手机连接';
    if (!next.latency.count && sensors.length) $('sample-count').textContent = '等待增强版同步；原包 v0.4.9 不回传测速数据';
  }
  function setAddresses(config) {
    const current = $('address').value;
    $('address').replaceChildren();
    const addresses = config.addresses.length ? config.addresses : [{ name: '仅本机', address: '127.0.0.1' }];
    for (const item of addresses) {
      const option = document.createElement('option');
      option.value = `http://${item.address}:${config.port}`;
      option.textContent = `${item.name} · ${item.address}:${config.port}`;
      $('address').append(option);
    }
    if ([...$('address').options].some(o => o.value === current)) $('address').value = current;
    updateAddresses();
  }
  function updateAddresses() {
    $('probe-url').value = $('address').value;
    $('post-url').value = $('address').value.replace(/^http/, 'ws') + '/sensor';
  }
  function drawChart() {
    const canvas = $('chart'), rect = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const w = rect.width, h = rect.height, left = 38, right = w - 12, top = 12, bottom = h - 22;
    const values = samples.slice(-60).map(s => s.rttMs), ceiling = Math.max(20, Math.ceil(Math.max(0, ...values) / 20) * 20);
    ctx.font = '11px "Microsoft YaHei"'; ctx.fillStyle = '#748078'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = top + (bottom - top) * i / 4;
      ctx.strokeStyle = '#e1e7e3'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillText(String(Math.round(ceiling * (1 - i / 4))), 1, y + 4);
    }
    if (!values.length) {
      ctx.textAlign = 'center'; ctx.fillText('等待手机延迟样本', w / 2, h / 2); ctx.textAlign = 'left'; return;
    }
    const points = values.map((value, i) => [left + (right - left) * i / 59, bottom - value / ceiling * (bottom - top)]);
    ctx.beginPath(); ctx.moveTo(points[0][0], bottom);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.lineTo(points.at(-1)[0], bottom); ctx.closePath(); ctx.fillStyle = '#e2efe7'; ctx.fill();
    ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = '#15734b'; ctx.lineWidth = 2; ctx.stroke();
    for (const [x, y] of points) { ctx.beginPath(); ctx.arc(x, y, 2.1, 0, Math.PI * 2); ctx.fillStyle = '#15734b'; ctx.fill(); }
    ctx.fillStyle = '#748078'; ctx.fillText('最近 60 次', left, h - 3);
  }
  function renderRows() {
    const visible = rows.filter(r => !$('only-valid').checked || r.status === 'accepted').slice(-100).reverse();
    $('events').replaceChildren();
    for (const row of visible) {
      const tr = document.createElement('tr');
      const values = [new Date(row.receivedIso).toLocaleTimeString('zh-CN', { hour12: false }), row.sequence,
        names[row.action] || row.rawAction, row.legacy ? '旧版体感' : row.isTest ? '通信测试' : '体感动作',
        row.estimatedUplinkMs === null ? '未同步' : `${row.estimatedUplinkMs.toFixed(1)} ms`, statusNames[row.status]];
      for (const [i, value] of values.entries()) {
        const td = document.createElement('td'); td.textContent = value;
        if (i === 5) td.className = row.status === 'accepted' ? 'tag' : 'tag warn';
        tr.append(td);
      }
      $('events').append(tr);
    }
    if (!visible.length) {
      const tr = document.createElement('tr'), td = document.createElement('td');
      tr.className = 'empty'; td.colSpan = 6; td.textContent = '尚未收到动作'; tr.append(td); $('events').append(tr);
    }
  }
  function addRecord(row, live = true) {
    rows.push(row); if (rows.length > 5000) rows.shift();
    if (row.status === 'accepted') {
      if (row.action === 'swing_up') up++; else if (row.action === 'swing_down') down++;
      $('up-count').textContent = up; $('down-count').textContent = down;
      if (live) {
        showAction(row);
        const area = document.querySelector('.action-feedback');
        area.classList.add('flash'); clearTimeout(flashTimer); flashTimer = setTimeout(() => area.classList.remove('flash'), 180);
        if (audio && !row.isTest) recordTiming(row);
      }
    }
    renderRows();
  }
  function showAction(row) {
    $('last-action').textContent = names[row.action];
    $('action-source').textContent = row.legacy ? '旧版体感' : row.isTest ? '通信测试' : '体感动作';
    $('last-sequence').textContent = `#${row.sequence}`;
    const old = $('action-icon'), icon = document.createElement('i');
    icon.id = 'action-icon'; icon.dataset.lucide = row.action === 'swing_up' ? 'arrow-up' : 'arrow-down';
    old.replaceWith(icon); icons();
  }
  function restoreHistory(history) {
    rows = history.events || [];
    samples = history.measurements || [];
    const accepted = rows.filter(r => r.status === 'accepted');
    up = accepted.filter(r => r.action === 'swing_up').length;
    down = accepted.filter(r => r.action === 'swing_down').length;
    $('up-count').textContent = up; $('down-count').textContent = down;
    if (accepted.length) showAction(accepted.at(-1));
    renderRows(); drawChart();
  }
  function resetView(config) {
    rows = []; samples = []; up = 0; down = 0; errors = []; usedBeats.clear();
    $('up-count').textContent = '0'; $('down-count').textContent = '0'; $('last-action').textContent = '等待输入';
    $('last-sequence').textContent = '—'; $('run-id').textContent = `测试 ${config.runId.slice(0, 8)}`;
    $('timing-result').textContent = '等待动作';
    renderRows(); drawChart(); stopBeat();
  }
  function connect() {
    clearTimeout(retry);
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onopen = () => {
      $('connection').textContent = '电脑服务已连接'; $('connection').className = 'status online';
      clockSamples = [];
      for (let i = 0; i < 5; i++) setTimeout(clockPing, i * 120);
    };
    socket.onmessage = event => {
      const receivedAt = performance.now();
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.event === 'hello') {
        const changed = state && state.runId !== msg.data.runId;
        if (changed) resetView(msg.data);
        if (msg.data.history) restoreHistory(msg.data.history);
        $('offset').value = msg.data.offsetMs; showOffset();
        localStorage.setItem('mihayou.offsetMs', String(msg.data.offsetMs));
        updateState(msg.data); setAddresses(msg.data);
      }
      if (msg.event === 'state') updateState(msg.data);
      if (msg.event === 'record') addRecord({ ...msg.data, browserReceivedAtMs: receivedAt });
      if (msg.event === 'measurement') { samples.push(msg.data); if (samples.length > 60) samples.shift(); drawChart(); }
      if (msg.event === 'run') { resetView(msg.data); if (state) state.runId = msg.data.runId; }
      if (msg.event === 'settings') {
        $('offset').value = msg.data.offsetMs; showOffset();
        localStorage.setItem('mihayou.offsetMs', String(msg.data.offsetMs));
      }
      if (msg.event === 'clock') {
        const rtt = receivedAt - msg.c0 - (msg.s2 - msg.s1);
        clockSamples.push({ rtt, delta: ((msg.s1 - msg.c0) + (msg.s2 - receivedAt)) / 2, at: receivedAt });
        clockSamples = clockSamples.filter(c => receivedAt - c.at < 30000).sort((a, b) => a.rtt - b.rtt).slice(0, 20);
      }
    };
    socket.onclose = () => {
      $('connection').textContent = '电脑服务断开，重连中'; $('connection').className = 'status';
      clockSamples = []; stopBeat();
      if (!closing) retry = setTimeout(connect, 1500);
    };
    socket.onerror = () => {};
  }
  function clockPing() { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: 'clock', c0: performance.now() })); }
  function showOffset() { $('offset-label').textContent = `${Number($('offset').value) > 0 ? '+' : ''}${$('offset').value} ms`; }
  async function saveOffset(value) {
    const id = ++offsetRequest;
    const selected = Math.max(-200, Math.min(400, Math.round(value / 5) * 5));
    $('offset').value = selected; showOffset();
    localStorage.setItem('mihayou.offsetMs', String(selected));
    try { await post('/api/settings', { offsetMs: selected }); if (id === offsetRequest) notice('判定偏移已保存'); }
    catch (e) { notice('保存失败，电脑服务尚未应用偏移'); }
  }
  function stopBeat() {
    clearInterval(beatTimer); beatTimer = null;
    if (audio) audio.close().catch(() => {});
    audio = null;
    $('beat').innerHTML = '<i data-lucide="play"></i>节拍测试'; icons(); $('calibration-state').textContent = '未播放';
  }
  async function startBeat() {
    if (audio) { stopBeat(); return; }
    audio = new AudioContext();
    await audio.resume();
    beatStart = audio.currentTime + 1; usedBeats.clear(); errors = [];
    let scheduled = 0;
    function schedule() {
      if (!audio) return;
      while (beatStart + scheduled * .75 < audio.currentTime + .2) {
        const time = beatStart + scheduled * .75;
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        oscillator.frequency.value = scheduled % 4 === 0 ? 1046.5 : 784;
        gain.gain.setValueAtTime(.0001, time); gain.gain.exponentialRampToValueAtTime(.15, time + .004);
        gain.gain.exponentialRampToValueAtTime(.0001, time + .075);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(time); oscillator.stop(time + .09);
        scheduled++;
      }
      $('calibration-state').textContent = audio.currentTime < beatStart ? '准备' : `第 ${Math.floor((audio.currentTime - beatStart) / .75) + 1} 拍`;
    }
    schedule(); beatTimer = setInterval(schedule, 25);
    $('beat').innerHTML = '<i data-lucide="square"></i>停止节拍'; icons();
    $('timing-result').textContent = '等待动作';
  }
  function recordTiming(row) {
    if (row.action !== 'swing_up') return;
    // Browser arrival is used deliberately, matching the first-stage game contract.
    const timestamp = audio.getOutputTimestamp?.();
    const arrival = row.browserReceivedAtMs;
    const heardTime = timestamp && timestamp.performanceTime > 0 ?
      timestamp.contextTime + (arrival - timestamp.performanceTime) / 1000 :
      audio.currentTime - (performance.now() - arrival) / 1000;
    const effective = heardTime - Number($('offset').value) / 1000;
    const beatIndex = Math.round((effective - beatStart) / .75);
    const target = beatStart + beatIndex * .75;
    if (beatIndex < 0 || usedBeats.has(beatIndex) || Math.abs(effective - target) >= .36) {
      $('timing-result').textContent = '未匹配到节拍'; return;
    }
    usedBeats.add(beatIndex);
    const error = (effective - target) * 1000;
    errors.push(error);
    const sorted = [...errors].sort((a, b) => a - b), center = sorted[Math.floor(sorted.length / 2)];
    $('timing-result').textContent = `${error < 0 ? '偏早' : '偏晚'} ${Math.abs(error).toFixed(0)} ms · ${errors.length} 次，中位偏差 ${center.toFixed(0)} ms`;
    post('/api/calibration', { runId: state.runId, eventId: row.id, errorMs: error,
      offsetMs: Number($('offset').value), beatIndex, audioOutputTimestamp: !!timestamp?.performanceTime
    }).catch(() => notice('校准记录未保存，请检查连接'));
  }
  $('address').onchange = updateAddresses;
  for (const [button, input] of [['copy-post', 'post-url'], ['copy-probe', 'probe-url']]) $(button).onclick = async () => {
    try { await navigator.clipboard.writeText($(input).value); notice('地址已复制'); }
    catch { $(input).select(); notice('请复制已选中的地址'); }
  };
  $('new-run').onclick = async () => {
    try { await post('/api/run', {}); notice('已开始新测试；手机端等待下一次同步后再发送动作'); }
    catch { notice('开始新测试失败'); }
  };
  $('export').onclick = () => { window.location.href = '/api/export'; };
  $('only-valid').onchange = renderRows;
  $('offset').oninput = showOffset;
  $('offset').onchange = () => saveOffset(Number($('offset').value));
  $('minus').onclick = () => saveOffset(Number($('offset').value) - 5);
  $('plus').onclick = () => saveOffset(Number($('offset').value) + 5);
  $('reset-offset').onclick = () => saveOffset(0);
  $('beat').onclick = () => startBeat().catch(() => { stopBeat(); notice('音频播放失败，请重新点击'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopBeat(); });
  window.addEventListener('resize', drawChart);
  window.addEventListener('beforeunload', () => { closing = true; socket?.close(); });
  const saved = Number(localStorage.getItem('mihayou.offsetMs') ?? 0);
  $('offset').value = Number.isFinite(saved) ? Math.max(-200, Math.min(400, saved)) : 0;
  showOffset(); icons(); drawChart(); connect();
  setInterval(clockPing, 3000);
})();
