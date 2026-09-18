import { elementFromNode } from '../findings.js';
import { impactOf } from './rules.js';

// Two things the SEO category does not report, though Lighthouse holds both
// after the same load: that the page names no canonical URL, and whether it
// carries the tags a link preview is built from. Read from Lighthouse's own
// data, they cost no second load of the page.

// Lighthouse's `canonical` audit judges a canonical that is there — a link in
// the head, or a `Link` header — and declares itself not applicable when there
// is none. That is the finding, with Lighthouse's own idea of where one counts.
export function missingCanonical(lhr) {
  if (lhr?.audits?.canonical?.scoreDisplayMode !== 'notApplicable') return [];
  return [{
    rule: 'canonical-missing',
    title: 'Document does not name a canonical URL',
    impact: impactOf({ id: 'canonical-missing' }),
    count: 0,
    nodes: [],
    detail: 'No <link rel="canonical"> in the head, and no canonical Link header',
  }];
}

// What a link preview shows: a title, a line of text, an image. og:url and
// og:type are left out — a preview falls back to the link that was shared and
// loses nothing without them.
const PREVIEW_TAGS = ['og:title', 'og:description', 'og:image'];

// The Open Graph tags, from the meta elements Lighthouse gathered for the meta
// description. Read the way scrapers read them: by `property`, or by `name`,
// which most of them accept too. One item per problem — a tag that is missing,
// or an image a scraper cannot fetch — so a change that drops one more tag
// reads as worse.
//
// Without the artifact there is nothing to say: a page whose meta elements
// were never gathered is not a page without tags.
export function openGraph(artifacts) {
  const metas = artifacts?.MetaElements;
  if (!Array.isArray(metas)) return [];

  const problems = [];
  for (const tag of PREVIEW_TAGS) {
    const meta = metas.find((m) => (m.property?.toLowerCase() === tag || m.name === tag) && m.content?.trim());
    if (!meta) {
      problems.push(elementFromNode(null, `${tag} is missing`));
    } else if (tag === 'og:image' && !/^https?:\/\//i.test(meta.content.trim())) {
      // Facebook, LinkedIn and Slack fetch the image on their own, from the
      // tag alone: a relative URL resolves against nothing.
      problems.push(elementFromNode(meta.node, `og:image is not an absolute URL: ${meta.content.trim()}`));
    }
  }

  if (problems.length === 0) return [];
  return [{
    rule: 'open-graph',
    title: 'Open Graph tags are missing or unusable',
    impact: impactOf({ id: 'open-graph' }),
    count: problems.length,
    nodes: problems,
  }];
}
