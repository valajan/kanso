import { evaluateFindings, firstSample, withProbed } from '../findings.js';
import { leaks } from './leaks.js';
import { residues } from './residues.js';

// Interactions: what the page does when it is used, rather than what it is —
// the states the project declares opened and closed, and what they leave
// behind. Nothing here is read from Lighthouse, and nothing runs without a
// declared state: both probes go into and out of each (src/probes/transition.js).
//
// residues.js closes each state once and compares the page with what it was:
// a page locked, an overlay or a hidden page left, a scroll position or an
// address lost, a trigger still saying it is expanded, an error as it closed.
// leaks.js opens and closes each again and again, and reads what memory
// keeps.
//
// Findings, judged as the other findings modules judge theirs (../findings.js),
// on the same scale — rules.js places each rule on it.
export default {
  id: 'interactions',
  label: 'Interactions',
  categories: [],
  probes: [residues, leaks],

  extract(lhr, { probed } = {}) {
    return withProbed({ findings: [] }, probed);
  },

  combine: firstSample,

  needsBaseline() {
    return true;
  },

  evaluate: evaluateFindings,
};
