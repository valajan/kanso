// Single source of truth for the metrics Kanso measures. One today: INP,
// timed by Kanso's own probe on the interactions a project declares (inp.js).
//
// Each descriptor carries everything the rest of the codebase needs to know
// about a metric, so thresholds, labels and formatting rules live in exactly
// one place:
// - lowerIsBetter: whether a smaller value is the better outcome
// - good: the good / needs-improvement boundary, as the Core Web Vitals set it
// - poor: the poor boundary — used as the fail threshold when a repo sets no
//   explicit budget for the metric
// - unit / decimals: display formatting
// - round: normalizes a raw value to its displayed precision
export const METRICS = [
  { key: 'inp', label: 'INP', unit: 'ms', lowerIsBetter: true, good: 200, poor: 500, decimals: 0, round: (v) => Math.round(v) },
];

const METRIC_KEYS = METRICS.map((m) => m.key);

const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

export function getMetric(key) {
  const metric = BY_KEY.get(key);
  if (!metric) throw new Error(`Unknown metric: ${key}`);
  return metric;
}

// Applies each metric's round() to a raw score object, yielding the values
// used for display and status evaluation. Returns null for a null score.
//
// A metric absent from the input rounds to null rather than throwing: the
// reference "score" is sometimes the budget map, which a repo may define for
// only some metrics.
export function roundScore(score) {
  if (score == null) return null;
  const out = {};
  for (const metric of METRICS) {
    const value = score[metric.key];
    out[metric.key] = Number.isFinite(value) ? metric.round(value) : null;
  }
  return out;
}

// Returns true when every tracked metric has an explicit budget value, meaning
// a reference audit is unnecessary for pass/fail evaluation.
export function allBudgetsDefined(budget = {}) {
  return METRIC_KEYS.every((key) => budget[key] != null);
}
