import { combineLevels } from '../../core/levels.js';
import { inpDiagnostics, inpProbe, slowestInteraction } from './inp.js';
import { allBudgetsDefined, METRICS, roundScore } from './metrics.js';
import { medianScores } from './median.js';
import { effectiveBudgets, evaluateStatuses } from './status.js';

// Performance: what the page costs a visitor who uses it — INP, which Kanso
// times itself on the clicks a project declares (inp.js) — judged against
// per-repo budgets and compared to a baseline. Nothing here is read from a
// page load nobody touches: that is what Lighthouse measures, and Kanso leaves
// it to Lighthouse.
export default {
  id: 'performance',
  label: 'Performance',
  checkLabels: Object.fromEntries(METRICS.map((m) => [m.key, m.label])),
  probes: [inpProbe],

  // `inp` is null when nothing was timed: no state declared, or none reached.
  extract({ probed } = {}) {
    return {
      inp: slowestInteraction(probed?.measures)?.latency ?? null,
      diagnostics: { inp: inpDiagnostics(probed) },
    };
  },

  // The measures are noisy, so repeated loads are folded into their median;
  // the diagnostics come from the load that produced it.
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
  //                  against — the repo's budget, or the "poor" boundary
  //                  where it sets none. The same on both form factors, and
  //                  there whether or not a baseline was loaded: a baseline
  //                  gives Δ its meaning, never the verdict.
  // - scores:        { [formFactor]: { current, reference } }
  // - referenceKind: 'baseline', or 'budgets' when no baseline was loaded and
  //                  the budgets stand in as the comparison column
  // - diagnostics:   { [formFactor]: { current, baseline } }, why the numbers
  //                  are what they are: the slowest interaction and its parts
  //                  (inp.js). The module's own detail: surfaces that know it
  //                  render it, the others pass it through.
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

// Which load's diagnostics to report when the page was loaded several times:
// the one whose INP is nearest the median, so that the interaction named is
// the one behind the number. An even count has no middle load: its median
// sits halfway between two, and the first of them to have run is taken. With
// no INP to be nearest to, what the first load says of why there is none:
// nothing declared, or a state it could not reach.
export function pickDiagnostics(samples, medians) {
  let best = null;
  for (const sample of samples) {
    if (typeof sample?.inp !== 'number') continue;
    if (best == null || Math.abs(sample.inp - medians.inp) < Math.abs(best.inp - medians.inp)) best = sample;
  }
  return { inp: (best ?? samples[0])?.diagnostics?.inp ?? null };
}
