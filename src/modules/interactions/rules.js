// Where each rule of the interactions module sits on the impact scale
// (src/modules/impact.js), by what it costs a visitor:
//
//   serious   the page is broken for them: it does not scroll, takes no
//             click, or is silent to a screen reader
//   moderate  the page works, worse: they lose their place, a trigger lies
//             about its state, an error is raised, memory grows
//   minor     hygiene
//
// With the default `fail_on: serious`, the first fail an audit and the rest
// warn — the line the other findings modules draw.
const IMPACTS = {
  // What a state left once closed (residues.js). Read from the page, not
  // guessed: the styles on <html> and <body>, what takes a click, what is
  // hidden from assistive technology.
  'page-locked': 'serious',
  'overlay-left': 'serious',
  'page-hidden-left': 'serious',
  'scroll-position-lost': 'moderate',
  'expanded-left': 'moderate',
  'close-error': 'moderate',
  // An address a state changed and did not give back: harmless as often as
  // not — a route that is the state — hence minor.
  'url-left': 'minor',
  // The page behind a modal dialog scrolling under the wheel: a nuisance.
  'scroll-not-locked': 'minor',

  // What opening and closing a state again and again leaves in memory
  // (leaks.js). A growth measured, then judged against a line: warns until
  // real pages have shown where the line belongs.
  'dom-leak': 'moderate',
  'listener-leak': 'moderate',
};

export function impactOf(rule) {
  return IMPACTS[rule];
}
