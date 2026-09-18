// Where each rule of Lighthouse's SEO category sits on the impact scale
// (src/modules/impact.js). Lighthouse weighs these rules for a score and ranks
// none of them, so the ranking is Kanso's own, by what a failure costs the page
// in search:
//
//   critical  search engines leave the page out
//   serious   the page may be indexed as another one, or ranked for it
//   moderate  indexed, but read or shown worse than it could be
//   minor     hygiene
//
// With the default `fail_on: serious`, the first two fail an audit and the rest
// warn — the same line accessibility draws.
const IMPACTS = {
  // A `noindex` — in a meta tag, an X-Robots-Tag header — or a robots.txt that
  // disallows the page. Preview hosts add the header to every preview
  // deployment, which is what `ignore:` is for.
  'is-crawlable': 'critical',
  // A page that answers with an error status is not indexed. Lighthouse usually
  // refuses to audit one at all, and Kanso reports that as a failed load.
  'http-status-code': 'critical',
  // Conflicting, relative or invalid, or pointing at the homepage: a canonical
  // tells a search engine which URL to rank, and a wrong one hands the page's
  // ranking to another.
  'canonical': 'serious',
  // A robots.txt with lines a crawler cannot parse — they are skipped, so what
  // they meant to allow or forbid is lost — or one that failed to download.
  'robots-txt': 'moderate',
  // Links a crawler cannot follow hide the pages behind them.
  'crawlable-anchors': 'moderate',
  // An invalid alternate-language link: the wrong language may be shown.
  'hreflang': 'moderate',
  // Without one, the search engine writes the snippet under the title itself.
  'meta-description': 'moderate',
  // "click here" says nothing of where a link goes, to a crawler or a person.
  'link-text': 'minor',

  // Kanso's own two, which Lighthouse holds but does not report (head.js).
  //
  // No canonical at all: the search engine picks which of the URLs the page
  // answers at to rank — usually the right one, which is why it only warns.
  'canonical-missing': 'moderate',
  // No title, text or image for a link preview, or an image a scraper cannot
  // fetch: the page is shared worse, not ranked worse.
  'open-graph': 'minor',
};

// A rule Lighthouse adds after this table was written is reported, and warns
// rather than fails: upgrading Lighthouse should not turn a build red by
// itself.
const UNRANKED = 'moderate';

export function impactOf(audit) {
  return IMPACTS[audit.id] ?? UNRANKED;
}

// Two rules of the SEO category are axe rules, which Lighthouse also runs under
// accessibility: a missing <title> and an image without alt text. Accessibility
// judges them, with the impact axe itself gives them; reporting them twice
// would list one problem in two sections, possibly at two different levels.
export const LEFT_TO_ACCESSIBILITY = new Set(['document-title', 'image-alt']);
