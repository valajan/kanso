// Single source of truth for the five Lighthouse metrics PerfGuard tracks.
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
  { key: 'performance', label: 'Performance', unit: '',   lowerIsBetter: false, good: 90,  poor: 49,   decimals: 0, round: (v) => v },
  { key: 'lcp',         label: 'LCP',         unit: 's',  lowerIsBetter: true,  good: 2.5, poor: 4.0,  decimals: 1, round: (v) => parseFloat(v.toFixed(1)) },
  { key: 'tbt',         label: 'TBT',         unit: 'ms', lowerIsBetter: true,  good: 200, poor: 600,  decimals: 0, round: (v) => Math.round(v) },
  { key: 'cls',         label: 'CLS',         unit: '',   lowerIsBetter: true,  good: 0.1, poor: 0.25, decimals: 2, round: (v) => parseFloat(v.toFixed(2)) },
  { key: 'fcp',         label: 'FCP',         unit: 's',  lowerIsBetter: true,  good: 1.8, poor: 3.0,  decimals: 1, round: (v) => parseFloat(v.toFixed(1)) },
];

export const METRIC_KEYS = METRICS.map((m) => m.key);

const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

export function getMetric(key) {
  const metric = BY_KEY.get(key);
  if (!metric) throw new Error(`Unknown metric: ${key}`);
  return metric;
}

// Applies each metric's round() to a raw Lighthouse score object, yielding the
// values used for display and status evaluation. Returns null for a null score.
export function roundScore(score) {
  if (score == null) return null;
  const out = {};
  for (const metric of METRICS) out[metric.key] = metric.round(score[metric.key]);
  return out;
}

// Joins metric keys into a human-readable label list (e.g. "LCP, TBT").
export function metricLabels(keys) {
  return keys.map((key) => BY_KEY.get(key)?.label ?? key).join(', ');
}
