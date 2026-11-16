(function (root) {
  'use strict';
  const SERVICE = 'f000aa00-0451-4000-b000-000000000000';
  const STREAM = 'f000aa01-0451-4000-b000-000000000000';
  const COOLDOWN_MS = 550, QUIET_MS = 120;
  class Detector {
    constructor(onAction, onState) {
      this.onAction = onAction; this.onState = onState; this.axis = null;
      this.threshold = 3.2; this.candidateAt = 0; this.candidate = [0, 0, 0];
      this.cooldownUntil = 0; this.quietAt = 0; this.armed = false; this.sequence = 0;
    }
    calibrate() { this.axis = null; this.candidateAt = 0; this.armed = false; this.onState('挥动一次作为上挥方向'); }
    sample(x, y, z, time) {
      const magnitude = Math.hypot(x, y, z);
      if (!Number.isFinite(magnitude)) return;
      if (!this.axis) {
        if (magnitude < 4) { this.candidateAt = 0; return; }
        if (!this.candidateAt) { this.candidateAt = time; this.candidate = [x, y, z]; return; }
        if (time - this.candidateAt < 30) return;
        const norm = Math.hypot(...this.candidate);
        this.axis = this.candidate.map(value => value / norm);
        this.cooldownUntil = time + COOLDOWN_MS; this.quietAt = 0; this.candidateAt = 0;
        this.onState('方向已记录 · 等待稳定'); return;
      }
      if (time < this.cooldownUntil) return;
      if (magnitude <= 1.8) {
        if (!this.quietAt) this.quietAt = time;
        if (time - this.quietAt >= QUIET_MS) { this.candidateAt = 0; this.armed = true; this.onState('已就绪'); }
        return;
      }
      this.quietAt = 0;
      if (!this.armed) return;
      const projected = x * this.axis[0] + y * this.axis[1] + z * this.axis[2];
      if (Math.abs(projected) < this.threshold || Math.abs(projected) < magnitude * 0.7) { this.candidateAt = 0; return; }
      if (!this.candidateAt) { this.candidateAt = time; this.candidate = [Math.sign(projected), 0, 0]; return; }
      if (Math.sign(projected) !== this.candidate[0]) { this.candidateAt = 0; return; }
      if (time - this.candidateAt < 30) return;
      this.onAction({ sessionId: 'ble-desktop', sequence: ++this.sequence, action: projected > 0 ? 'swing_up' : 'swing_down', source: 'phone', sensorTimeMs: this.candidateAt, receivedAtMs: performance.now() });
      this.cooldownUntil = time + COOLDOWN_MS; this.quietAt = 0; this.armed = false; this.candidateAt = 0;
      this.onState('动作已识别 · 短暂冷却');
    }
  }
  async function connect(onSample) {
    if (!navigator.bluetooth) throw Error('请用支持 Web Bluetooth 的 Chrome 或 Edge 打开电脑本机页面');
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] });
    const server = await device.gatt.connect(), service = await server.getPrimaryService(SERVICE);
    const characteristic = await service.getCharacteristic(STREAM);
    await characteristic.startNotifications();
    const handler = event => {
      const value = event.target.value, view = new DataView(value.buffer, value.byteOffset, value.byteLength);
      if (view.byteLength < 20) return;
      onSample(view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true), Number(view.getBigInt64(12, true)) / 1e6);
    };
    characteristic.addEventListener('characteristicvaluechanged', handler);
    return { device, close() { characteristic.removeEventListener('characteristicvaluechanged', handler); if (device.gatt.connected) device.gatt.disconnect(); } };
  }
  root.MihayouBleSensor = Object.freeze({ SERVICE, STREAM, Detector, connect });
})(window);
