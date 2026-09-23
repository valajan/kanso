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
// map, returning { [metricKey]: 'pass' | 'warn' | 'fail' }. A metric with no
// value — INP where nothing was clicked — gets no status at all: a number
// nobody measured passes nothing and fails nothing.
export function evaluateStatuses(roundedScore, budget = {}) {
  const statuses = {};
  for (const metric of METRICS) {
    if (roundedScore[metric.key] == null) continue;
    statuses[metric.key] = buildStatus(roundedScore[metric.key], failThreshold(metric, budget), metric);
  }
  return statuses;
}

// Metric keys that reached the given level, in registry order.
export function metricsWithStatus(statuses, level) {
  return METRICS.map((m) => m.key).filter((key) => statuses[key] === level);
}
