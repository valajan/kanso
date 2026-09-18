import { evaluateFindings, extractFindings, firstSample } from '../findings.js';
import { missingCanonical, openGraph } from './head.js';
import { impactOf, LEFT_TO_ACCESSIBILITY } from './rules.js';

// SEO: what Lighthouse checks of how a search engine reads the page — whether it
// may index it at all, which URL it should rank, what it would show of it.
//
// Findings, like accessibility, and judged the same way (../findings.js); what
// is this module's own is where a rule's impact comes from, rules.js.
//
// Lighthouse only judges what the page declares: it checks a canonical that is
// there, and says nothing of one that is missing, nor of Open Graph tags — a
// page with neither scores 100. It holds both facts all the same, and head.js
// reports them: `canonical-missing` and `open-graph`.
export default {
  id: 'seo',
  label: 'SEO',
  categories: ['seo'],

  extract(lhr, { artifacts } = {}) {
    const findings = extractFindings(lhr, { category: 'seo', impactOf })
      .filter((finding) => !LEFT_TO_ACCESSIBILITY.has(finding.rule));
    return { findings: [...findings, ...missingCanonical(lhr), ...openGraph(artifacts)] };
  },

  combine: firstSample,

  // As for accessibility: the baseline is what tells a change that added a
  // `noindex` from a page that always had one.
  needsBaseline() {
    return true;
  },

  evaluate: evaluateFindings,
};
