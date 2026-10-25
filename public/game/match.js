(function(root) {
  'use strict';
  const levels = Object.freeze({
    easy: { label: '简单', windowMs: 220, speed: .20 },
    normal: { label: '普通', windowMs: 150, speed: .24 },
    hard: { label: '困难', windowMs: 100, speed: .30 }
  });
  function chartFor(base, difficulty) {
    const level = levels[difficulty];
    if (!level) throw Error('难度无效');
    const chart = JSON.parse(JSON.stringify(base));
    chart.difficulty = difficulty;
    chart.chartId = base.chartId.replace(/-normal-v1$/, '') + '-' + difficulty + '-v2';
    chart.judgementWindowMs = level.windowMs;
    if (difficulty === 'easy') {
      let last = -Infinity;
      chart.obstacles = chart.obstacles.filter(o => {
        if (o.hitTimeMs - last < 2300) return false;
        last = o.hitTimeMs;
        return true;
      });
    }
    return chart;
  }
  class Match {
    constructor({ mode = 'single', difficulty = 'normal', names = [] } = {}) {
      if (!['single', 'versus'].includes(mode) || !levels[difficulty]) throw Error('对局设置无效');
      this.mode = mode;
      this.difficulty = difficulty;
      this.names = Array.from({ length: mode === 'versus' ? 2 : 1 },
        (_, i) => String(names[i] || '').trim().slice(0, 16) || `玩家 ${i + 1}`);
      this.results = [];
      this.offsetMs = null;
    }
    get complete() { return this.results.length === this.names.length; }
    get currentName() { return this.names[Math.min(this.results.length, this.names.length - 1)]; }
    record(state) {
      if (this.complete || state.phase !== 'ended' || !state.ending?.validScore) return false;
      const failed = state.obstacles.find(o => o.status === 'missed');
      this.results.push({
        name: this.currentName, passed: state.passedCount, total: state.obstacles.length,
        survivedMs: Math.round(failed?.hitTimeMs ?? Math.min(state.musicTimeMs, state.durationMs)),
        clear: state.ending.kind === 'clear', offsetMs: state.offsetMs
      });
      return true;
    }
    verdict() {
      if (!this.complete) return '';
      if (this.mode === 'single') return this.results[0].clear ? '通关' : '本局结束';
      const [a, b] = this.results;
      if (a.clear && b.clear) return '平局 · 两人均通关';
      const difference = Number(a.clear) - Number(b.clear) || a.passed - b.passed || a.survivedMs - b.survivedMs;
      return difference === 0 ? '平局' : `${(difference > 0 ? a : b).name} 获胜`;
    }
  }
  const api = { levels, chartFor, Match };
  if (typeof module !== 'undefined') module.exports = api;
  else root.MihayouMatch = api;
})(typeof window === 'undefined' ? globalThis : window);
