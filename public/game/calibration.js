(function (root) {
  'use strict';
  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function matchBeats(expected, actions) {
    const candidates = [];
    expected.forEach((time, beatIndex) => {
      actions.forEach((actionTime, actionIndex) => {
        const errorMs = actionTime - time;
        if (Number.isFinite(errorMs) && Math.abs(errorMs) <= 450) {
          candidates.push({ beatIndex, actionIndex, errorMs });
        }
      });
    });
    candidates.sort((a, b) => Math.abs(a.errorMs) - Math.abs(b.errorMs));
    const beats = new Set(), usedActions = new Set(), matches = [];
    for (const candidate of candidates) {
      if (beats.has(candidate.beatIndex) || usedActions.has(candidate.actionIndex)) continue;
      beats.add(candidate.beatIndex);
      usedActions.add(candidate.actionIndex);
      matches.push(candidate);
    }
    return matches.sort((a, b) => a.beatIndex - b.beatIndex);
  }

  function evaluate(expected, actions) {
    const matches = matchBeats(expected, actions);
    if (matches.length < 6) return { ok: false, reason: 'too_few', count: matches.length };
    const center = median(matches.map(match => match.errorMs));
    const mad = median(matches.map(match => Math.abs(match.errorMs - center)));
    const inliers = matches.filter(match => Math.abs(match.errorMs - center) <= Math.max(40, mad * 3));
    const spreadMs = inliers.length ? Math.max(...inliers.map(m => m.errorMs)) - Math.min(...inliers.map(m => m.errorMs)) : Infinity;
    if (inliers.length < 6 || spreadMs > 120) {
      return { ok: false, reason: 'unstable', count: inliers.length, spreadMs };
    }
    const rawOffsetMs = median(inliers.map(match => match.errorMs));
    if (rawOffsetMs < -200 || rawOffsetMs > 400) {
      return { ok: false, reason: 'out_of_range', count: inliers.length, rawOffsetMs };
    }
    return { ok: true, offsetMs: Math.round(rawOffsetMs / 5) * 5, count: inliers.length, spreadMs, matches: inliers };
  }

  const api = { matchBeats, evaluate };
  if (typeof module !== 'undefined') module.exports = api;
  else root.MihayouCalibration = api;
})(typeof window === 'undefined' ? globalThis : window);
