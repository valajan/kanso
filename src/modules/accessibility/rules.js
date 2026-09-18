// Where each of Kanso's own accessibility rules sits on the impact scale
// (src/modules/impact.js) — the ones its probes check, which axe does not. axe
// ranks its own rules; these follow the line it draws: `serious` and up is
// what shuts someone out and fails an audit by default, `moderate` warns.
//
// A rule fails by default only when the probe behind it cannot be fooled by a
// page doing something on purpose; one that rests on a heuristic warns until
// real pages have shown it right.
const IMPACTS = {
  // WCAG 1.4.10, Reflow (AA). At 320 CSS pixels wide — a 1280 px window zoomed
  // to 400% — the page scrolls sideways: whoever needs the zoom reads every
  // line by scrolling back and forth.
  'reflow-scroll': 'serious',
  // The same criterion, the other way round: the page does not scroll, but
  // text runs past an edge that cuts it, and is lost. A carousel peeking at its
  // next slide or a ticker looks the same to the probe, hence a warning.
  'reflow-clip': 'moderate',

  // WCAG 2.1.2, No Keyboard Trap (A). Tab goes round part of the page, or
  // stays put, and whoever has no mouse cannot get past it. An open modal
  // dialog, which holds focus on purpose, is not reported.
  'focus-trap': 'critical',
  // WCAG 2.4.7, Focus Visible (AA). A keyboard user cannot tell where they
  // are: nothing changes on the element that has focus, or it is off the
  // screen or invisible when it gets it.
  'focus-visible': 'serious',
  // WCAG 2.4.11, Focus Not Obscured (AA). The focused element is entirely
  // behind something else — a cookie banner, a sticky bar. Warns: the probe
  // sees the page as a first visit does, with every banner still open.
  'focus-obscured': 'moderate',

  // prefers-reduced-motion, and WCAG 2.3.3 Animation from Interactions (AAA).
  // The reader asked their system for less motion, and the page moves anyway:
  // for some, nausea or a migraine. Warns: AAA, and a spinner that keeps
  // turning may be the one thing saying the page is busy.
  'reduced-motion': 'moderate',
};

export function impactOf(rule) {
  return IMPACTS[rule];
}
