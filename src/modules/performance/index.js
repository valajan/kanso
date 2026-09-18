import { combineLevels } from '../../core/levels.js';
import { allBudgetsDefined, METRICS, roundScore } from './metrics.js';
import { medianScores } from './median.js';
import { detectSignificantRegressions } from './regressions.js';
import { evaluateStatuses } from './status.js';

// Performance: the five Lighthouse metrics (score, LCP, TBT, CLS, FCP), judged
// against per-repo budgets and compared to a baseline.
export default {
  id: 'performance',
  label: 'Performance',
  categories: ['performance'],
  checkLabels: Object.fromEntries(METRICS.map((m) => [m.key, m.label])),

  extract(lhr) {
    return {
      performance: Math.round((lhr.categories.performance.score ?? 0) * 100),
      lcp: lhr.audits['largest-contentful-paint'].numericValue ?? 0,
      tbt: lhr.audits['total-blocking-time'].numericValue ?? 0,
      cls: lhr.audits['cumulative-layout-shift'].numericValue ?? 0,
      fcp: lhr.audits['first-contentful-paint'].numericValue ?? 0,
    };
  },

  // The measures are noisy, so repeated loads are folded into their median.
  combine: medianScores,

  // With every budget set, a baseline cannot change the verdict.
  needsBaseline(config) {
    return !allBudgetsDefined(config.budgets);
  },

  // Returns, beyond `levels`:
  // - scores:        { [formFactor]: { current, reference } }
  // - referenceKind: 'baseline', or 'budgets' when no baseline was loaded and
  //                  the budgets stand in as the comparison column
  // - regressions:   the failures worth explaining, for the AI analysis
  evaluate({ formFactors, baselineAudited }, config) {
    const budget = config.budgets ?? {};
    const scores = {};
    const statusesByForm = [];
    const regressions = [];

    for (const [formFactor, { current, baseline }] of Object.entries(formFactors)) {
      const reference = baselineAudited ? baseline : budget;
      scores[formFactor] = { current, reference };
      if (!current) continue;

      const statuses = evaluateStatuses(roundScore(current), budget);
      statusesByForm.push(statuses);
      regressions.push(...detectSignificantRegressions({
        statuses, current, reference, budget, formFactor, againstBudgets: !baselineAudited,
      }));
    }

    return {
      levels: combineLevels(statusesByForm),
      scores,
      referenceKind: baselineAudited ? 'baseline' : 'budgets',
      regressions,
    };
  },
};
