import { METRICS } from './registry.js';

// Classifies a single metric value against its budget and Lighthouse thresholds:
// - 'fail' = exceeds the budget (if set) or the Lighthouse "poor" threshold → block merge
// - 'warn' = in the Lighthouse "needs improvement" zone (between good and the fail threshold)
// - 'pass' = in the Lighthouse "good" zone
export function buildStatus(value, budget, { lowerIsBetter, good, poor }) {
  const failThreshold = budget ?? poor;
  if (lowerIsBetter ? value > failThreshold : value < failThreshold) return 'fail';
  if (lowerIsBetter ? value > good : value < good) return 'warn';
  return 'pass';
}

// Evaluates every metric of a rounded score object against a per-metric budget
// map, returning { [metricKey]: 'pass' | 'warn' | 'fail' }.
export function evaluateStatuses(roundedScore, budget = {}) {
  const statuses = {};
  for (const metric of METRICS) {
    statuses[metric.key] = buildStatus(roundedScore[metric.key], budget[metric.key] ?? null, metric);
  }
  return statuses;
}

// True if any metric in the status map reached the given level.
export function hasStatus(statuses, level) {
  return Object.values(statuses).includes(level);
}

// Metric keys that reached the given level, in registry order.
export function metricsWithStatus(statuses, level) {
  return METRICS.map((m) => m.key).filter((key) => statuses[key] === level);
}
