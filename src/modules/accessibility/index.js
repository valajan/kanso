import { evaluateFindings, firstSample, withProbed } from '../findings.js';
import { axeProbe } from './axe.js';
import { focus } from './focus.js';
import { keyboard } from './keyboard.js';
import { motion } from './motion.js';
import { reflow } from './reflow.js';

// Accessibility: the axe rules Kanso runs on the page, judged by the impact of
// what they found and by whether the baseline already had it.
//
// This is the module that judges findings rather than measures — a rule is
// broken on a set of elements, or it is not. Nothing here is averaged, and one
// page load is as good as five. What it shares with the other modules
// reporting findings is in ../findings.js; what is its own is that its impacts
// come from axe, which ranks its own rules.
//
// It is also the first module that owes Lighthouse nothing. It used to read
// Lighthouse's accessibility category, which is axe-core run through a window
// its gatherer holds shut: sixty-seven rules of a hundred, no configuration,
// and every result axe could not settle thrown away. axe.js now runs axe on
// the page itself, and the category is gone from what Lighthouse is asked for.
//
// axe reads the page at one size and never touches it. What only shows at
// another size, or under a keyboard, Kanso's own probes check — each in a page
// of its own, after Lighthouse — and report as findings of this module, on the
// same scale (rules.js): reflow.js lays the page out 320 CSS pixels wide,
// keyboard.js goes through it with the Tab key, motion.js watches it under
// `prefers-reduced-motion: reduce`, and focus.js goes into and out of each
// declared state from the keyboard.
export default {
  id: 'accessibility',
  label: 'Accessibility',
  // Nothing of this module is read from a Lighthouse report any more. The
  // other three still ask for theirs, and one load serves them all.
  categories: [],
  probes: [axeProbe, reflow, keyboard, motion, focus],

  extract(lhr, { probed } = {}) {
    return withProbed({ findings: [] }, probed);
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
