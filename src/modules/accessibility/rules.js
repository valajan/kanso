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
};

export function impactOf(rule) {
  return IMPACTS[rule];
}
