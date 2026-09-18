import { METRICS } from './metrics.js';

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

// The value past which a metric fails: the repo's budget, or Lighthouse's
// "poor" boundary when it sets none. What a report shows as the budget, since
// it is what the verdict was read against.
export function failThreshold(metric, budget = {}) {
  return budget[metric.key] ?? metric.poor;
}

// Every metric's fail threshold, { [metricKey]: value }: the budgets as the
// verdict read them, including the ones the repo left to Lighthouse.
export function effectiveBudgets(budget = {}) {
  return Object.fromEntries(METRICS.map((metric) => [metric.key, failThreshold(metric, budget)]));
}

// Evaluates every metric of a rounded score object against a per-metric budget
// map, returning { [metricKey]: 'pass' | 'warn' | 'fail' }.
export function evaluateStatuses(roundedScore, budget = {}) {
  const statuses = {};
  for (const metric of METRICS) {
    statuses[metric.key] = buildStatus(roundedScore[metric.key], failThreshold(metric, budget), metric);
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
