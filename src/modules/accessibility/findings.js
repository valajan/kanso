import { impactRank } from './impact.js';

// How many failing elements are kept per rule. A page can fail `color-contrast`
// on two hundred nodes; nobody reads two hundred selectors, and the sample
// crosses a thread boundary. The count is kept whole — it is what the verdict
// rests on — and only the list of elements is cut.
export const MAX_NODES = 50;

// Reads the accessibility category of a Lighthouse report: one finding per axe
// rule the page failed, with the elements that failed it.
//
// A score of null is a rule Lighthouse did not judge — not applicable, manual,
// or informative — and 1 is a rule the page passed. Neither is a finding.
export function extractFindings(lhr) {
  const refs = lhr?.categories?.accessibility?.auditRefs ?? [];
  const findings = [];

  for (const { id } of refs) {
    const audit = lhr.audits?.[id];
    if (!audit || audit.score == null || audit.score >= 1) continue;

    const items = audit.details?.items ?? [];
    findings.push({
      rule: id,
      title: audit.title ?? id,
      impact: audit.details?.debugData?.impact ?? null,
      count: items.length,
      nodes: items.slice(0, MAX_NODES).map((item) => ({
        selector: item.node?.selector ?? '',
        snippet: item.node?.snippet ?? '',
      })),
    });
  }

  return findings;
}

// Folds the findings of every form factor into one list: the same rule broken
// on mobile and desktop is one finding, seen twice, and `formFactors` says
// where. The element count is the worst of the two rather than their sum —
// they are the same page, measured twice.
export function aggregate(byFormFactor) {
  const byRule = new Map();

  for (const [formFactor, findings] of Object.entries(byFormFactor)) {
    for (const finding of findings ?? []) {
      let entry = byRule.get(finding.rule);
      if (!entry) {
        entry = { rule: finding.rule, title: finding.title, impact: finding.impact, count: 0, formFactors: [], nodes: [] };
        byRule.set(finding.rule, entry);
      }
      entry.impact ??= finding.impact;
      entry.count = Math.max(entry.count, finding.count);
      entry.formFactors.push(formFactor);
      for (const node of finding.nodes) {
        if (!entry.nodes.some((seen) => seen.selector === node.selector)) entry.nodes.push(node);
      }
    }
  }

  return [...byRule.values()];
}

// What the baseline makes of each finding:
//
//   new        the baseline does not break this rule at all — the page under
//              audit introduced it
//   worse      the baseline breaks it too, on fewer elements
//   inherited  the baseline breaks it on as many elements
//
// The state rests on the rule and its element count, not on which elements:
// a selector like `div.card > p:nth-child(3)` changes when a paragraph moves,
// with nothing having regressed, so reading "new" off a selector would cry wolf
// on every reshuffled page. Counts do not drift. The selectors are kept for the
// reader, to say which elements to go and look at.
//
// Returns the current findings, each with its state, plus the rules the
// baseline breaks and the audited page no longer does.
export function compare(current, baseline) {
  if (baseline == null) {
    return { findings: current.map((finding) => ({ ...finding, state: null, baselineCount: null })), fixed: [] };
  }

  const byRule = new Map(baseline.map((finding) => [finding.rule, finding]));

  const findings = current.map((finding) => {
    const before = byRule.get(finding.rule);
    const state = before == null ? 'new' : finding.count > before.count ? 'worse' : 'inherited';
    return { ...finding, state, baselineCount: before?.count ?? 0 };
  });

  const seen = new Set(current.map((finding) => finding.rule));
  const fixed = baseline
    .filter((finding) => !seen.has(finding.rule))
    .map(({ rule, title, impact, count }) => ({ rule, title, impact, count }));

  return { findings, fixed };
}

const LEVEL_ORDER = { fail: 0, warn: 1, pass: 2 };

// Worst first: what fails, then what warns, then what the page already carried,
// each group from the heaviest impact down. A report is read from the top.
export function sortFindings(findings) {
  return [...findings].sort((a, b) =>
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
    impactRank(b.impact) - impactRank(a.impact) ||
    a.rule.localeCompare(b.rule));
}
