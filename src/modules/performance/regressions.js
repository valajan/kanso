import { getMetric } from './metrics.js';
import { failThreshold } from './status.js';

const SIGNIFICANT_DEGRADATION_PCT = 10;

function normalize(metric, value) {
  if (value == null) return null;
  return metric === 'tbt' ? Math.round(value) : value;
}

function degradationPct(metric, current, reference) {
  if (reference == null) return null;
  if (reference === 0) return current > 0 ? Infinity : 0;
  return getMetric(metric).lowerIsBetter
    ? ((current - reference) / reference) * 100
    : ((reference - current) / reference) * 100;
}

// The failed metrics worth explaining, worst degradation first.
//
// Against a baseline, a metric must also be more than 10% worse than it: a
// page that was already over budget did not regress. Against the budgets
// alone, every failure counts.
export function detectSignificantRegressions({ statuses, current, reference, budget, formFactor, againstBudgets = false }) {
  const failed = Object.entries(statuses)
    .filter(([, s]) => s === 'fail')
    .map(([k]) => k);

  const out = [];
  for (const metric of failed) {
    const currentVal = normalize(metric, current[metric]);
    const referenceVal = reference == null ? null : normalize(metric, reference[metric]);
    const delta = degradationPct(metric, currentVal, referenceVal);
    if (!againstBudgets && (delta == null || delta <= SIGNIFICANT_DEGRADATION_PCT)) continue;
    // The threshold the metric failed, even one the repo left to Lighthouse.
    out.push({ metric, formFactor, current: currentVal, reference: referenceVal, delta, threshold: failThreshold(getMetric(metric), budget ?? {}) });
  }
  return out.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
}
