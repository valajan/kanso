import { evaluateFindings, extractFindings, firstSample } from '../findings.js';

// Accessibility: the axe rules Lighthouse runs on the page, judged by the
// impact of what they found and by whether the baseline already had it.
//
// This is the module that judges findings rather than measures — a rule is
// broken on a set of elements, or it is not. Nothing here is averaged, and one
// page load is as good as five. What it shares with the other modules
// reporting findings is in ../findings.js; what is its own is where an impact
// comes from: axe gives one to every rule it breaks.
export default {
  id: 'accessibility',
  label: 'Accessibility',
  categories: ['accessibility'],

  extract(lhr) {
    return { findings: extractFindings(lhr, { category: 'accessibility', impactOf: axeImpact }) };
  },

  combine: firstSample,

  // The baseline is what separates "this change broke it" from "this page was
  // already like that". Nobody reads forty inherited violations; everybody
  // reads the two a change just added, which is the entire point of loading a
  // second page.
  needsBaseline() {
    return true;
  },

  // See evaluateFindings for what it returns beyond `levels`.
  evaluate: evaluateFindings,
};

// Lighthouse carries the impact axe gave the rule in its debug data.
function axeImpact(audit) {
  return audit.details?.debugData?.impact ?? null;
}
