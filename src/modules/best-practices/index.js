import { evaluateFindings, extractFindings, extractInformative, firstSample } from '../findings.js';
import { impactOf } from './rules.js';

// The group Lighthouse files the security-header audits under. The category's
// other unscored audits — the web features a page uses, the libraries it
// bundles — were left out: on a real page, eleven lines of which nine said
// flexbox and grid are widely available.
const TRUST_AND_SAFETY = 'best-practices-trust-safety';

// Best practices: what Lighthouse checks of how the page is built and served —
// HTTPS, console errors, deprecated APIs, a doctype, images at the right size.
//
// Findings, like accessibility, and judged the same way (../findings.js); what
// is this module's own is where a rule's impact comes from, rules.js — and the
// security headers, which Lighthouse reports without scoring.
export default {
  id: 'best-practices',
  label: 'Best Practices',
  categories: ['best-practices'],

  extract(lhr) {
    return {
      findings: extractFindings(lhr, { category: 'best-practices', impactOf }),
      informative: extractInformative(lhr, { category: 'best-practices', group: TRUST_AND_SAFETY }),
    };
  },

  combine: firstSample,

  needsBaseline() {
    return true;
  },

  // Returns, beyond what evaluateFindings does:
  // - informative:  [{ rule, title, items }], what Lighthouse reports about the
  //                 security headers the page was served with (CSP, HSTS, COOP,
  //                 frame control, Trusted Types) without scoring it, one line
  //                 per item. Facts, never judged and never compared: they
  //                 describe the server as much as the page, and a build served
  //                 locally has none of the headers its host would add. The
  //                 module's own detail, passed through for whoever can read it
  //                 — an agent can tell a local server from a deployment.
  //                 Taken from the first form factor that loaded: headers do
  //                 not change with the viewport. null when none did.
  evaluate({ formFactors, baselineAudited }, config) {
    const loaded = Object.values(formFactors).find(({ current }) => current != null);
    return {
      ...evaluateFindings({ formFactors, baselineAudited }, config),
      informative: loaded?.current.informative ?? null,
    };
  },
};
