// The severity scale of every module that reports findings, weakest first.
//
// It is axe-core's: Lighthouse carries it through for accessibility, where every
// audit that failed reports the impact of its rule in `details.debugData.impact`.
// SEO and best practices have no scale of their own — Lighthouse weighs their
// rules for a score and ranks none of them — so each of those modules places its
// rules on this one (their `rules.js`). One scale is what lets `fail_on` mean the
// same thing in every section of .kanso.yml.
//
// It is the only severity axis findings have. Performance compares a number to
// a budget; a broken rule has no number, so `serious` is what stands in for
// "over the line".
export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'];

// The impact from which a finding fails the audit, unless .kanso.yml says
// otherwise. `serious` is where axe puts what actually locks a user out — no
// alt text, unreachable controls, unreadable contrast — while `moderate` and
// below are mostly hygiene a page should fix without a build failing on it.
const DEFAULT_FAIL_ON = 'serious';

// A rule reported without an impact is judged as `serious`: it is a real
// violation either way, and silently treating it as the mildest thing on the
// scale would hide it behind the default threshold.
const UNKNOWN = 'serious';

export function impactRank(impact) {
  const rank = IMPACTS.indexOf(impact);
  return rank === -1 ? IMPACTS.indexOf(UNKNOWN) : rank;
}

// True when `impact` is at or above the configured threshold.
export function reaches(impact, threshold) {
  return impactRank(impact) >= impactRank(threshold);
}

// The impact a finding may not exceed. What axe cannot decide on its own is
// capped this way: it is reported, but it cannot be what fails an audit at the
// default threshold. A finding axe gave no impact is capped too — `serious` is
// what an unranked one stands for, and that is precisely what must not stand
// for a doubt.
export function capImpact(impact, ceiling) {
  return impactRank(impact) > impactRank(ceiling) ? ceiling : impact;
}

// The heavier of two impacts, either of which may be unknown. Folding one
// rule's findings across form factors, an impact nobody gave must not win over
// one somebody did.
export function worstImpact(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return impactRank(a) >= impactRank(b) ? a : b;
}

// A `fail_on:` value from a config file. An unknown one falls back to the
// default rather than sinking the audit — the resolved value is reported, so a
// typo shows up in the report instead of in a stack trace.
export function parseFailOn(value) {
  return IMPACTS.includes(value) ? value : DEFAULT_FAIL_ON;
}
