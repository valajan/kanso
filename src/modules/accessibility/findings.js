import { impactRank } from './impact.js';

// How many failing elements are kept per rule. Not a reading budget: whoever
// fixes a rule needs every element it failed on, and an agent handed a sample
// goes and reloads the page to find the rest. It is a guard against a page
// that fails a rule on its whole DOM — a thousand-row table in the wrong grey —
// whose element list would bury everything else in the result. Twice the worst
// page seen in real use (51 contrast failures). The count is kept whole: it is
// what the verdict rests on.
export const MAX_NODES = 100;

// Reads the accessibility category of a Lighthouse report: one finding per axe
// rule the page failed, with the elements that failed it.
//
// A score of null is a rule Lighthouse did not judge — not applicable, manual,
// or informative — and 1 is a rule the page passed. Neither is a finding.
//
// Each element carries:
// - selector     where it is — not unique: Lighthouse shortens it, and ten
//                spans in ten cards share one
// - snippet      its opening tag, whose classes and scoped-style attributes
//                are often what names the component it came from
// - label        its text, as Lighthouse abbreviates it
// - explanation  axe's own account of what is wrong with this element: for a
//                contrast failure, the ratio, both colours and the font size
// - path         its position in the DOM, the one thing that tells two
//                elements apart; `aggregate` uses it, and drops it
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
      nodes: items.slice(0, MAX_NODES).map(({ node }) => ({
        selector: node?.selector ?? '',
        snippet: node?.snippet ?? '',
        label: node?.nodeLabel ?? '',
        explanation: node?.explanation ?? '',
        path: node?.path ?? '',
      })),
    });
  }

  return findings;
}

// Folds the findings of every form factor into one list: the same rule broken
// on mobile and desktop is one finding, seen twice, and `formFactors` says
// where. The element count is the worst of the two rather than their sum —
// they are the same page, measured twice.
//
// The elements are the union of both lists. An element is the same one on both
// form factors when its DOM path is; its selector is no identity at all, and
// keying on it once kept 19 of a page's 51 contrast failures. Within one form
// factor nothing is folded: every item Lighthouse listed is its own element.
export function aggregate(byFormFactor) {
  const byRule = new Map();

  for (const [formFactor, findings] of Object.entries(byFormFactor)) {
    for (const finding of findings ?? []) {
      let entry = byRule.get(finding.rule);
      if (!entry) {
        entry = { rule: finding.rule, title: finding.title, impact: finding.impact, count: 0, formFactors: [], nodes: [], seen: new Set() };
        byRule.set(finding.rule, entry);
      }
      entry.impact ??= finding.impact;
      entry.count = Math.max(entry.count, finding.count);
      entry.formFactors.push(formFactor);

      const seenBefore = new Set(entry.seen);
      for (const { path, ...node } of finding.nodes) {
        const key = path || node.selector;
        entry.seen.add(key);
        if (!seenBefore.has(key)) entry.nodes.push(node);
      }
    }
  }

  return [...byRule.values()].map(({ seen, ...finding }) => finding);
}

// The element's text on one line — what tells apart the ten elements sharing a
// selector — or nothing when Lighthouse had no text to give and fell back to
// the selector. This and the next two are for the surfaces that print
// findings; the audit itself returns the raw text.
export function elementText({ label, selector }) {
  const text = (label ?? '').replace(/\s+/g, ' ').trim();
  return text === selector ? '' : text;
}

// axe's explanation on one line: "Fix any of the following:" and its siblings
// dropped, the checks that failed joined.
export function explanationLine(explanation) {
  return (explanation ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Fix (any|all) of the following:$/.test(line))
    .join('; ');
}

// The one explanation every element listed shares, on one line, or '' when
// they differ. A missing alt is a missing alt, and is said once; contrast
// ratios differ from one element to the next, and each gets its own.
export function sharedExplanation(nodes) {
  const lines = new Set(nodes.map((node) => explanationLine(node.explanation)));
  return lines.size === 1 ? [...lines][0] : '';
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
