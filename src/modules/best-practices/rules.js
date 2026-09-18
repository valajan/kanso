// Where each rule of Lighthouse's Best Practices category sits on the impact
// scale (src/modules/impact.js). Lighthouse weighs these rules for a score and
// ranks none of them, so the ranking is Kanso's own, by what a failure does to
// the people using the page:
//
//   critical  unused: no rule here breaks the page for everyone on its own
//   serious   exposes them, or locks some of them out
//   moderate  something went wrong, or will when browsers change
//   minor     cosmetic
//
// With the default `fail_on: serious`, only the first group fails an audit.
const IMPACTS = {
  // Plain HTTP, or insecure requests made from an HTTPS page — which browsers
  // block, taking whatever they carried with them. localhost counts as secure.
  'is-on-https': 'serious',
  // A field that refuses a paste locks out whoever types nothing by hand:
  // password managers, and the people who rely on them.
  'paste-preventing-inputs': 'serious',
  'redirects-http': 'moderate',
  // A permission prompt nobody asked for, on arrival: it is denied, and the
  // denial sticks.
  'geolocation-on-start': 'moderate',
  'notification-on-start': 'moderate',
  // Works today, stops working when browsers remove it.
  'deprecations': 'moderate',
  'third-party-cookies': 'moderate',
  // Something failed — a script threw, a request 404'd. Each item says what.
  'errors-in-console': 'moderate',
  // The DevTools Issues panel: mixed content, cookie and CSP problems.
  'inspector-issues': 'moderate',
  // Without a doctype, the page renders in quirks mode, with its own box model.
  'doctype': 'moderate',
  // Without an early charset declaration, text can be decoded as mojibake.
  'charset': 'moderate',
  'image-aspect-ratio': 'minor',
  'image-size-responsive': 'minor',
  // Large first-party scripts without source maps: debugging hygiene, which
  // Lighthouse itself leaves out of its score.
  'valid-source-maps': 'minor',
};

// A rule Lighthouse adds after this table was written is reported, and warns
// rather than fails: upgrading Lighthouse should not turn a build red by
// itself.
const UNRANKED = 'moderate';

export function impactOf(audit) {
  return IMPACTS[audit.id] ?? UNRANKED;
}
