// axe-core's impact scale, weakest first. Lighthouse carries it through: every
// accessibility audit that failed reports the impact of its rule in
// `details.debugData.impact`.
//
// It is the only severity axis accessibility has. Performance compares a number
// to a budget; a violated rule has no number, so `serious` is what stands in
// for "over the line".
export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'];

// The impact from which a finding fails the audit, unless .kanso.yml says
// otherwise. `serious` is where axe puts what actually locks a user out — no
// alt text, unreachable controls, unreadable contrast — while `moderate` and
// below are mostly hygiene a page should fix without a build failing on it.
export const DEFAULT_FAIL_ON = 'serious';

// A rule Lighthouse reported without an impact is judged as `serious`: it is a
// real violation either way, and silently treating it as the mildest thing on
// the scale would hide it behind the default threshold.
const UNKNOWN = 'serious';

export function impactRank(impact) {
  const rank = IMPACTS.indexOf(impact);
  return rank === -1 ? IMPACTS.indexOf(UNKNOWN) : rank;
}

// True when `impact` is at or above the configured threshold.
export function reaches(impact, threshold) {
  return impactRank(impact) >= impactRank(threshold);
}

// A `fail_on:` value from a config file. An unknown one falls back to the
// default rather than sinking the audit — the resolved value is reported, so a
// typo shows up in the report instead of in a stack trace.
export function parseFailOn(value) {
  return IMPACTS.includes(value) ? value : DEFAULT_FAIL_ON;
}
