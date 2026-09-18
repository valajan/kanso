import { evaluateFindings, extractFindings, firstSample, withProbed } from '../findings.js';
import { keyboard } from './keyboard.js';
import { reflow } from './reflow.js';

// Accessibility: the axe rules Lighthouse runs on the page, judged by the
// impact of what they found and by whether the baseline already had it.
//
// This is the module that judges findings rather than measures — a rule is
// broken on a set of elements, or it is not. Nothing here is averaged, and one
// page load is as good as five. What it shares with the other modules
// reporting findings is in ../findings.js; what is its own is where an impact
// comes from: axe gives one to every rule it breaks.
//
// axe reads the page at one size and never touches it. What only shows at
// another size, or under a keyboard, Kanso's probes check — each in a page of
// its own, after Lighthouse — and report as findings of this module, on the
// same scale (rules.js): reflow.js lays the page out 320 CSS pixels wide,
// keyboard.js goes through it with the Tab key.
export default {
  id: 'accessibility',
  label: 'Accessibility',
  categories: ['accessibility'],
  probes: [reflow, keyboard],

  extract(lhr, { probed } = {}) {
    return withProbed({ findings: extractFindings(lhr, { category: 'accessibility', impactOf: axeImpact }) }, probed);
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
