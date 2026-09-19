// Single source of truth for the five Lighthouse metrics Kanso tracks.
//
// Each descriptor carries everything the rest of the codebase needs to know
// about a metric, so thresholds, labels and formatting rules live in exactly
// one place:
// - lowerIsBetter: whether a smaller value is the better outcome
// - good: the Lighthouse good / needs-improvement boundary
// - poor: the Lighthouse poor boundary — used as the fail threshold when a repo
//   sets no explicit budget for the metric
// - unit / decimals: display formatting
// - round: normalizes a raw Lighthouse value to its displayed precision
export const METRICS = [
  { key: 'performance', label: 'Performance', unit: '', lowerIsBetter: false, good: 90, poor: 49, decimals: 0, round: (v) => v },
  { key: 'lcp', label: 'LCP', unit: 'ms', lowerIsBetter: true, good: 2500, poor: 4000, decimals: 0, round: (v) => Math.round(v) },
  { key: 'tbt', label: 'TBT', unit: 'ms', lowerIsBetter: true, good: 200, poor: 600, decimals: 0, round: (v) => Math.round(v) },
  { key: 'cls', label: 'CLS', unit: '', lowerIsBetter: true, good: 0.1, poor: 0.25, decimals: 2, round: (v) => parseFloat(v.toFixed(2)) },
  { key: 'fcp', label: 'FCP', unit: 'ms', lowerIsBetter: true, good: 1800, poor: 3000, decimals: 0, round: (v) => Math.round(v) },
];

const METRIC_KEYS = METRICS.map((m) => m.key);

const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

export function getMetric(key) {
  const metric = BY_KEY.get(key);
  if (!metric) throw new Error(`Unknown metric: ${key}`);
  return metric;
}

// Applies each metric's round() to a raw Lighthouse score object, yielding the
// values used for display and status evaluation. Returns null for a null score.
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
// a production reference audit is unnecessary for pass/fail evaluation.
export function allBudgetsDefined(budget = {}) {
  return METRIC_KEYS.every((key) => budget[key] != null);
}
