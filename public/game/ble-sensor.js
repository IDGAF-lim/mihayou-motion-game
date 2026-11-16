(function (root) {
  'use strict';
  const SERVICE = 'f000aa00-0451-4000-b000-000000000000';
  const STREAM = 'f000aa01-0451-4000-b000-000000000000';
  const SETTINGS = Object.freeze({ threshold: 3.2, release: 1.8, confirmMs: 30,
    cooldownMs: 550, quietMs: 120, maxGapMs: 120, stallMs: 1000,
    gripMs: 1000, maxLagMs: 150 });
  function decodePacket(value) {
    if (!value || value.byteLength !== 20) return null;
    const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const kind = v.getUint8(1), vector = [8, 12, 16].map(i => v.getFloat32(i, true));
    if (v.getUint8(0) !== 1 || ![1, 2].includes(kind) || !vector.every(Number.isFinite)) return null;
    if (Math.hypot(...vector) > (kind === 1 ? 200 : 1.001)) return null;
    return { kind, sequence: v.getUint16(2, true), timestamp: v.getUint32(4, true), vector };
  }
  class PacketClock {
    constructor() { this.last = null; this.dropped = 0; this.offset = Infinity; }
    accept(packet, arrival) {
      if (!packet || !Number.isFinite(arrival)) return null;
      let delta = 0;
      if (this.last) {
        const step = (packet.sequence - this.last.sequence + 65536) % 65536;
        delta = (packet.timestamp - this.last.timestamp + 4294967296) % 4294967296;
        if (!step || step >= 32768 || delta >= 2147483648) return null;
        this.dropped += step - 1;
      }
      const time = this.last ? this.last.time + delta : packet.timestamp;
      this.last = { sequence: packet.sequence, timestamp: packet.timestamp, time };
      // Relative backlog only: the clocks do not provide absolute radio latency.
      this.offset = Math.min(this.offset, arrival - time);
      if (arrival - time - this.offset > SETTINGS.maxLagMs) return null;
      return { ...packet, time, arrival };
    }
  }
  class Detector {
    constructor(onAction, onState = () => {}) {
      this.onAction = onAction; this.onState = onState; this.sequence = 0; this.reset();
    }
    state(text) { if (this.status !== text) { this.status = text; this.onState(text); } }
    reset() { this.axis = null; this.teaching = false; this.lastTime = null; this.resetMotion(); }
    resetMotion() { this.candidate = null; this.quietAt = null; this.cooldownUntil = 0; this.armed = false; }
    calibrate() { this.reset(); this.teaching = true; this.state('请上挥一次'); }
    sample(x, y, z, time, arrival = time) {
      const vector = [x, y, z], magnitude = Math.hypot(...vector);
      if (!Number.isFinite(magnitude) || !Number.isFinite(time) || !Number.isFinite(arrival)) return;
      if (this.lastTime !== null) {
        if (time <= this.lastTime) return;
        if (time - this.lastTime > SETTINGS.maxGapMs) this.resetMotion();
      }
      this.lastTime = time;
      if (!this.axis) {
        if (!this.teaching) return;
        if (magnitude < 4) { this.candidate = null; return; }
        if (this.candidate && vector.reduce((sum, v, i) => sum + v * this.candidate.vector[i], 0) < magnitude * this.candidate.magnitude * .7)
          this.candidate = null;
        if (!this.candidate) { this.candidate = { time, vector, magnitude, arrival }; return; }
        if (time - this.candidate.time < SETTINGS.confirmMs) return;
        this.axis = this.candidate.vector.map(v => v / this.candidate.magnitude);
        this.candidate = null; this.teaching = false; this.cooldownUntil = time + SETTINGS.cooldownMs;
        this.state('方向已记录 · 等待稳定'); return;
      }
      if (time < this.cooldownUntil) return;
      if (magnitude <= SETTINGS.release) {
        this.candidate = null;
        if (this.quietAt === null) this.quietAt = time;
        if (time - this.quietAt >= SETTINGS.quietMs) { this.armed = true; this.state('已就绪'); }
        return;
      }
      this.quietAt = null;
      if (!this.armed) return;
      const projected = vector.reduce((sum, v, i) => sum + v * this.axis[i], 0), sign = Math.sign(projected);
      if (Math.abs(projected) < SETTINGS.threshold || Math.abs(projected) < magnitude * .7) { this.candidate = null; return; }
      if (this.candidate?.sign !== sign) this.candidate = { time, arrival, sign };
      if (time - this.candidate.time < SETTINGS.confirmMs) return;
      const action = { sequence: ++this.sequence, action: sign > 0 ? 'swing_up' : 'swing_down',
        source: 'phone', sensorTimeMs: this.candidate.time, receivedAtMs: this.candidate.arrival };
      this.resetMotion(); this.cooldownUntil = time + SETTINGS.cooldownMs;
      this.state('动作已识别 · 恢复中'); this.onAction(action);
    }
  }
  function rotation(vector) {
    const [x, y, z] = vector, w = Math.sqrt(Math.max(0, 1 - x*x - y*y - z*z));
    return [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w),
      2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w),
      2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)];
  }
  const transform = (matrix, vector) => [0, 3, 6].map(i => matrix[i]*vector[0]+matrix[i+1]*vector[1]+matrix[i+2]*vector[2]);
  const transpose = matrix => [0, 3, 6, 1, 4, 7, 2, 5, 8].map(i => matrix[i]);
  class MotionInput {
    constructor(onAction, onState = () => {}) {
      this.onState = onState; this.detector = new Detector(onAction, text => this.onState(text)); this.reset();
    }
    reset() {
      this.detector.reset(); this.phase = 'idle'; this.pose = null; this.last = null;
      this.stableAt = null; this.previous = null; this.reference = null; this.gravity = null;
    }
    calibrate() { this.reset(); this.phase = 'grip'; this.onState('保持握姿静止约 1 秒'); }
    resetMotion() { this.detector.resetMotion(); }
    get ready() { return this.phase === 'motion' && this.detector.armed; }
    sample(packet) {
      const { kind, vector, time, arrival } = packet;
      if (kind === 2) { this.pose = { matrix: rotation(vector), time }; return; }
      const dt = this.last === null ? 20 : time - this.last;
      if (dt <= 0) return;
      this.last = time;
      const freshPose = this.pose && time >= this.pose.time && time - this.pose.time <= SETTINGS.maxGapMs;
      if (this.phase === 'idle') return;
      if (this.phase === 'grip') {
        const stable = Math.abs(Math.hypot(...vector) - 9.80665) < .9 && dt <= SETTINGS.maxGapMs &&
          this.previous && Math.hypot(...vector.map((v, i) => v - this.previous[i])) < .5 &&
          (!freshPose || !this.stablePose || Math.hypot(...this.pose.matrix.map((v, i) => v - this.stablePose[i])) < .15);
        this.previous = vector;
        if (!stable) { this.stableAt = null; this.stablePose = freshPose ? this.pose.matrix : null; return; }
        if (this.stableAt === null) { this.stableAt = time; this.stablePose = freshPose ? this.pose.matrix : null; }
        if (time - this.stableAt < SETTINGS.gripMs) return;
        this.reference = freshPose ? this.pose.matrix : null;
        this.gravity = this.reference ? transform(this.reference, vector) : vector.slice();
        this.phase = 'motion'; this.detector.calibrate(); return;
      }
      if (dt > SETTINGS.maxGapMs) this.detector.resetMotion();
      let linear;
      if (this.reference) {
        if (!freshPose) { this.detector.resetMotion(); this.onState('等待新姿态数据'); return; }
        const world = transform(this.pose.matrix, vector).map((v, i) => v - this.gravity[i]);
        linear = transform(transpose(this.reference), world);
      } else {
        const alpha = Math.exp(-Math.min(dt, SETTINGS.maxGapMs) / 323);
        this.gravity = vector.map((v, i) => alpha*this.gravity[i]+(1-alpha)*v);
        linear = vector.map((v, i) => v - this.gravity[i]);
      }
      this.detector.sample(...linear, time, arrival);
    }
  }
  class Connection {
    constructor(onPacket, onClose = () => {}, options = {}) {
      this.onPacket = onPacket; this.onClose = onClose;
      this.bluetooth = options.bluetooth || navigator.bluetooth;
      this.now = options.now || (() => performance.now());
      this.stallMs = options.stallMs || SETTINGS.stallMs;
      this.setupMs = options.setupMs || 10000; this.clock = new PacketClock(); this.closed = false;
      this.onDisconnect = () => this.close('蓝牙已断开');
      this.onValue = event => {
        const packet = this.clock.accept(decodePacket(event.target.value), this.now());
        if (this.closed || !packet) return;
        if (packet.kind === 1) this.lastAcceleration = this.now();
        this.onPacket(packet);
      };
    }
    async connect() {
      if (!this.bluetooth) throw Error('请用 Chrome 或 Edge 打开电脑本机页面，启用蓝牙');
      const device = await this.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] });
      this.device = device;
      if (this.closed) throw Error('连接已取消');
      device.addEventListener('gattserverdisconnected', this.onDisconnect);
      const setup = async () => {
        const ensure = () => { if (this.closed) { if (device.gatt.connected) device.gatt.disconnect(); throw Error('连接已取消'); } };
        const server = await device.gatt.connect(); ensure();
        const service = await server.getPrimaryService(SERVICE); ensure();
        const characteristic = await service.getCharacteristic(STREAM); ensure();
        this.characteristic = characteristic;
        characteristic.addEventListener('characteristicvaluechanged', this.onValue);
        await characteristic.startNotifications(); ensure();
        this.lastAcceleration ??= this.now();
        this.watchdog = setInterval(() => {
          if (this.now() - this.lastAcceleration >= this.stallMs) this.close('传感器数据中断，请重连并校准');
        }, Math.min(200, this.stallMs));
        return this;
      };
      try {
        return await Promise.race([setup(), new Promise((resolve, reject) => {
          this.rejectSetup = reject;
          this.setupTimer = setTimeout(() => reject(Error('蓝牙连接超时，请重试')), this.setupMs);
        })]);
      } catch (error) { this.close(error.message); throw error; }
      finally { clearTimeout(this.setupTimer); this.rejectSetup = null; }
    }
    close(reason = '蓝牙已断开') {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.setupTimer); clearInterval(this.watchdog);
      this.rejectSetup?.(Error(reason));
      this.characteristic?.removeEventListener('characteristicvaluechanged', this.onValue);
      this.device?.removeEventListener('gattserverdisconnected', this.onDisconnect);
      if (this.device?.gatt.connected) this.device.gatt.disconnect();
      this.onClose(reason);
    }
  }
  root.MihayouBleSensor = Object.freeze({ SERVICE, STREAM, SETTINGS, decodePacket, PacketClock, Detector, MotionInput, Connection });
})(window);
