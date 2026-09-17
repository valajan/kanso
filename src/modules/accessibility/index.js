import { aggregate, compare, extractFindings, sortFindings } from './findings.js';
import { parseFailOn, reaches } from './impact.js';

// Accessibility: the axe rules Lighthouse runs on the page, judged by the
// impact of what they found and by whether the baseline already had it.
//
// This is the module that judges findings rather than measures — a rule is
// broken on a set of elements, or it is not. Nothing here is averaged, and one
// page load is as good as five.
export default {
  id: 'accessibility',
  label: 'Accessibility',
  categories: ['accessibility'],

  extract(lhr) {
    return { findings: extractFindings(lhr) };
  },

  // Deterministic, so repeated loads have nothing to fold: the first sample
  // that came back is the answer.
  combine(samples) {
    return samples.find((sample) => sample != null) ?? null;
  },

  // The baseline is what separates "this change broke it" from "this page was
  // already like that". Nobody reads forty inherited violations; everybody
  // reads the two a change just added, which is the entire point of loading a
  // second page.
  needsBaseline() {
    return true;
  },

  // Returns, beyond `levels` (one entry per broken rule):
  // - findings:            every rule the page breaks, worst first, each with its
  //                        impact, element count, state and level — or null when
  //                        no load produced a result
  // - fixed:               rules the baseline breaks and this page no longer does
  // - comparedToBaseline:  whether a baseline was actually loaded and compared
  // - failOn:              the impact threshold used, after config resolution
  evaluate({ formFactors, baselineAudited }, config = {}) {
    const failOn = parseFailOn(config.fail_on);
    const sides = Object.entries(formFactors);

    if (sides.every(([, { current }]) => current == null)) {
      return { levels: {}, findings: null, fixed: [], comparedToBaseline: false, failOn };
    }

    const current = aggregate(Object.fromEntries(sides.map(([formFactor, { current }]) => [formFactor, current?.findings])));

    // `baselineAudited` says the baseline was scheduled, not that it loaded.
    // Comparing against a baseline that never answered would read every
    // inherited violation as new, and fail a change that touched none of them.
    const compared = baselineAudited && sides.some(([, { baseline }]) => baseline != null);
    const baseline = compared
      ? aggregate(Object.fromEntries(sides.map(([formFactor, { baseline }]) => [formFactor, baseline?.findings])))
      : null;

    const { findings, fixed } = compare(current, baseline);
    const judged = sortFindings(findings.map((finding) => ({ ...finding, level: levelFor(finding, failOn) })));

    return {
      levels: Object.fromEntries(judged.map((finding) => [finding.rule, finding.level])),
      findings: judged,
      fixed,
      comparedToBaseline: compared,
      failOn,
    };
  },
};

// A finding the page already carried is reported, not held against the change:
// with a baseline, Kanso judges what the change did; without one, it judges the
// page as it stands, and every finding counts.
function levelFor({ state, impact }, failOn) {
  if (state === 'inherited') return 'pass';
  return reaches(impact, failOn) ? 'fail' : 'warn';
}
