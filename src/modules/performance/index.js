import { combineLevels } from '../../core/levels.js';
import { extractDiagnostics, pickDiagnostics } from './diagnostics.js';
import { inpDiagnostics, inpProbe, slowestInteraction } from './inp.js';
import { allBudgetsDefined, METRICS, roundScore } from './metrics.js';
import { medianScores } from './median.js';
import { effectiveBudgets, evaluateStatuses } from './status.js';

// Performance: the five Lighthouse metrics (score, LCP, TBT, CLS, FCP), and
// INP, which Kanso times itself on the clicks a project declares (inp.js) —
// judged against per-repo budgets and compared to a baseline.
export default {
  id: 'performance',
  label: 'Performance',
  categories: ['performance'],
  checkLabels: Object.fromEntries(METRICS.map((m) => [m.key, m.label])),
  probes: [inpProbe],

  // `inp` is null when nothing was timed: no state declared, or none reached.
  extract(lhr, { probed } = {}) {
    return {
      performance: Math.round((lhr.categories.performance.score ?? 0) * 100),
      lcp: lhr.audits['largest-contentful-paint'].numericValue ?? 0,
      tbt: lhr.audits['total-blocking-time'].numericValue ?? 0,
      cls: lhr.audits['cumulative-layout-shift'].numericValue ?? 0,
      fcp: lhr.audits['first-contentful-paint'].numericValue ?? 0,
      inp: slowestInteraction(probed?.measures)?.latency ?? null,
      diagnostics: { ...extractDiagnostics(lhr), inp: inpDiagnostics(probed) },
    };
  },

  // The measures are noisy, so repeated loads are folded into their median;
  // the diagnostics come from the loads that produced those medians.
  combine(samples) {
    const usable = samples.filter((sample) => sample != null);
    const medians = medianScores(usable);
    if (medians == null) return null;
    return { ...medians, diagnostics: pickDiagnostics(usable, medians) };
  },

  // With every budget set, a baseline cannot change the verdict.
  needsBaseline(config) {
    return !allBudgetsDefined(config.budgets);
  },

  // Returns, beyond `levels`:
  // - budgets:       { [metric]: threshold }, what every level was read
  //                  against — the repo's budget, or Lighthouse's "poor"
  //                  boundary where it sets none. The same on both form
  //                  factors, and there whether or not a baseline was loaded:
  //                  a baseline gives Δ its meaning, never the verdict.
  // - scores:        { [formFactor]: { current, reference } }
  // - referenceKind: 'baseline', or 'budgets' when no baseline was loaded and
  //                  the budgets stand in as the comparison column
  // - diagnostics:   { [formFactor]: { current, baseline } }, what Lighthouse
  //                  says about why the numbers are what they are — see
  //                  diagnostics.js. The module's own detail: surfaces that
  //                  know it render it, the others pass it through.
  evaluate({ formFactors, baselineAudited }, config) {
    const budget = config.budgets ?? {};
    const scores = {};
    const diagnostics = {};
    const statusesByForm = [];

    for (const [formFactor, sides] of Object.entries(formFactors)) {
      const { measures: current, diagnostics: currentDiagnostics } = split(sides.current);
      const { measures: baseline, diagnostics: baselineDiagnostics } = split(sides.baseline);
      const reference = baselineAudited ? baseline : budget;
      scores[formFactor] = { current, reference };
      diagnostics[formFactor] = { current: currentDiagnostics, baseline: baselineAudited ? baselineDiagnostics : null };
      if (!current) continue;

      statusesByForm.push(evaluateStatuses(roundScore(current), budget));
    }

    return {
      levels: combineLevels(statusesByForm),
      budgets: effectiveBudgets(budget),
      scores,
      referenceKind: baselineAudited ? 'baseline' : 'budgets',
      diagnostics,
    };
  },
};

// A load's measures, which are compared and judged, apart from its
// diagnostics, which are only reported.
function split(data) {
  if (data == null) return { measures: null, diagnostics: null };
  const { diagnostics = null, ...measures } = data;
  return { measures, diagnostics };
}
