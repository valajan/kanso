import { impactRank, parseFailOn, reaches } from './impact.js';

// What the modules that report findings share — accessibility, SEO and best
// practices. Each reads one Lighthouse category, and every rule of it the page
// breaks is a finding. They differ in the category they read and in where a
// rule's impact comes from; extracting, folding, comparing and judging are the
// same code, here.
//
// A finding is described in src/modules/index.js. An element — one entry of a
// finding's `nodes`, one place the rule failed — carries:
//
// - selector     where it is in the DOM — not unique: Lighthouse shortens it,
//                and ten spans in ten cards share one
// - snippet      its opening tag, whose classes and scoped-style attributes
//                are often what names the component it came from
// - label        its text, as Lighthouse abbreviates it
// - explanation  what is wrong with it, in Lighthouse's words: axe's own
//                account for an accessibility rule (for a contrast failure,
//                the ratio, both colours and the font size), the columns
//                Lighthouse shows for any other — an image's displayed and
//                actual sizes, a console error's message
// - url          present when the rule names a resource or a place in one:
//                the image, the link target, the script and line that logged
//                the error
//
// Not every failure has a DOM element — a console error has a script, a link
// with vague text has a target — so any of the first four can be empty. A tag
// the page lacks altogether has nothing but its explanation.
//
// While extracting, an element also carries `path`, its position in the DOM:
// the one thing that tells two elements apart. `aggregate` uses it, and drops it.

// How many failing elements are kept per rule. Not a reading budget: whoever
// fixes a rule needs every element it failed on, and an agent handed a sample
// goes and reloads the page to find the rest. It is a guard against a page
// that fails a rule on its whole DOM — a thousand-row table in the wrong grey —
// whose element list would bury everything else in the result. Twice the worst
// page seen in real use (51 contrast failures). The count is kept whole: it is
// what the verdict rests on.
export const MAX_NODES = 100;

// Reads one category of a Lighthouse report: one finding per rule the page
// failed, with the elements that failed it. `impactOf(audit)` places the rule
// on the impact scale (src/modules/impact.js).
//
// A score of null is a rule Lighthouse did not judge — not applicable, manual,
// or informative — and 1 is a rule the page passed. Neither is a finding.
//
// `detail` is what Lighthouse says of the failure as a whole, when it says
// more than the title: "Document must contain a doctype", or the status code
// of a page that answered with an error. A failure without elements often has
// nothing else to say where it is.
export function extractFindings(lhr, { category, impactOf }) {
  const findings = [];

  for (const { id } of lhr?.categories?.[category]?.auditRefs ?? []) {
    const audit = lhr.audits?.[id];
    if (!audit || audit.score == null || audit.score >= 1) continue;

    const items = audit.details?.items ?? [];
    const detail = audit.explanation || (items.length === 0 ? audit.displayValue : '');
    findings.push({
      rule: id,
      title: audit.title ?? id,
      impact: impactOf(audit),
      count: items.length,
      nodes: elements(audit, items),
      ...(detail ? { detail: plain(detail) } : {}),
    });
  }

  return findings;
}

// The audits Lighthouse reports without scoring them, from one group of a
// category — for best practices, the security headers the page was served
// with. Facts about the page that are no verdict on it: each item on one line,
// in Lighthouse's words. Only the audits that listed something.
export function extractInformative(lhr, { category, group }) {
  const notes = [];

  for (const ref of lhr?.categories?.[category]?.auditRefs ?? []) {
    if (ref.group !== group) continue;
    const audit = lhr.audits?.[ref.id];
    if (audit?.scoreDisplayMode !== 'informative') continue;

    const items = audit.details?.items ?? [];
    if (items.length === 0) continue;
    notes.push({ rule: ref.id, title: audit.title ?? ref.id, items: elements(audit, items).map(noteLine) });
  }

  return notes;
}

function noteLine(element) {
  return [elementWhere(element), explanationLine(element.explanation)].filter(Boolean).join(' — ');
}

function elements(audit, items) {
  // Lighthouse's table headings say which column of an item holds what, and
  // name it; an audit without them falls back to the item's own keys.
  const headings = audit.details?.headings?.length > 0
    ? audit.details.headings
    : Object.keys(items[0] ?? {}).map((key) => ({ key, label: '' }));
  return items.slice(0, MAX_NODES).map((item) => toElement(item, headings));
}

// One item of a Lighthouse table as an element. Each value is read by what it
// is rather than by the heading above it — a heading typed `code` can hold a
// DOM node — and every column that is neither a node nor a location is text
// for the explanation, under the label Lighthouse gives it.
function toElement(item, headings) {
  const element = { selector: '', snippet: '', label: '', explanation: '', path: '' };
  const lines = [];

  for (const heading of headings) {
    const value = item[heading.key];
    if (value == null || value === '') continue;

    if (value.type === 'node') {
      element.selector = value.selector ?? '';
      element.snippet = value.snippet ?? '';
      element.label = value.nodeLabel ?? '';
      element.path = value.path ?? '';
      if (value.explanation) lines.unshift(value.explanation);
    } else if (value.type === 'source-location') {
      element.url ??= location(value);
    } else if (heading.valueType === 'url' && typeof value === 'string') {
      element.url ??= value;
    } else {
      const text = plain(value);
      if (text) lines.push(heading.label ? `${heading.label}: ${text}` : text);
    }
  }

  // Sub-items are the reasons behind an item — an hreflang's invalid code, its
  // relative href. The DOM nodes some audits nest there are left out: related
  // elements, not the one that failed.
  for (const sub of item.subItems?.items ?? []) {
    for (const heading of headings) {
      const value = heading.subItemsHeading && sub[heading.subItemsHeading.key];
      if (value == null || value.type === 'node') continue;
      const text = plain(value);
      if (text) lines.push(text);
    }
  }

  element.explanation = lines.join('\n');
  return element;
}

// An element from a node Lighthouse gathered but did not report — one of its
// artifacts — for a rule Kanso checks itself. `node` may be null, for what the
// rule found missing: an element that is nowhere, which only its explanation
// can describe.
export function elementFromNode(node, explanation) {
  return {
    selector: node?.selector ?? '',
    snippet: node?.snippet ?? '',
    label: node?.nodeLabel ?? '',
    explanation,
    path: node?.devtoolsNodePath ?? '',
  };
}

// A place in a script or a file as Lighthouse writes it: lines one-based,
// columns as they are. A negative line is Lighthouse saying it has none.
function location({ url, line, column }) {
  return line >= 0 ? `${url}:${line + 1}:${column}` : url;
}

// A table cell as text, on one line: a string, a number, or one of the typed
// values Lighthouse wraps them in.
function plain(value) {
  let text = '';
  if (typeof value !== 'object') text = String(value);
  else if (value.type === 'link') text = value.text ?? '';
  else if ('value' in value) text = String(value.value ?? '');
  return text.replace(/\s+/g, ' ').trim();
}

// Deterministic checks have nothing to fold across repeated loads: the first
// sample that came back is the answer.
export function firstSample(samples) {
  return samples.find((sample) => sample != null) ?? null;
}

// Judges one module's findings — the `evaluate` of every module that reports
// them. Returns, beyond `levels` (one entry per broken rule):
// - findings:            every rule the page breaks, worst first, each with its
//                        impact, element count, state and level — or null when
//                        no load produced a result
// - fixed:               rules the baseline breaks and this page no longer does
// - comparedToBaseline:  whether a baseline was actually loaded and compared
// - failOn:              the impact threshold used, after config resolution
// - ignore:              the rules left unjudged, after config resolution
//
// `ignore` is for a rule the project has decided not to be held to — the
// `noindex` every preview host adds to its deployments, say. An ignored rule is
// neither reported nor judged, on either page, and the resolved list is
// returned so a report can say what it did not look at.
export function evaluateFindings({ formFactors, baselineAudited }, config = {}) {
  const failOn = parseFailOn(config.fail_on);
  const ignore = parseIgnore(config.ignore);
  const sides = Object.entries(formFactors);

  if (sides.every(([, { current }]) => current == null)) {
    return { levels: {}, findings: null, fixed: [], comparedToBaseline: false, failOn, ignore };
  }

  const fold = (side) => aggregate(Object.fromEntries(sides.map(([formFactor, loads]) => [
    formFactor,
    loads[side]?.findings?.filter((finding) => !ignore.includes(finding.rule)),
  ])));

  // `baselineAudited` says the baseline was scheduled, not that it loaded.
  // Comparing against a baseline that never answered would read every
  // inherited violation as new, and fail a change that touched none of them.
  const compared = baselineAudited && sides.some(([, { baseline }]) => baseline != null);
  const { findings, fixed } = compare(fold('current'), compared ? fold('baseline') : null);
  const judged = sortFindings(findings.map((finding) => ({ ...finding, level: levelFor(finding, failOn) })));

  return {
    levels: Object.fromEntries(judged.map((finding) => [finding.rule, finding.level])),
    findings: judged,
    fixed,
    comparedToBaseline: compared,
    failOn,
    ignore,
  };
}

// An `ignore:` value from a config file: a list of rule ids, or a single one.
// Anything else ignores nothing — and the resolved list is reported.
function parseIgnore(value) {
  const rules = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return rules.filter((rule) => typeof rule === 'string' && rule !== '');
}

// A finding the page already carried is reported, not held against the change:
// with a baseline, Kanso judges what the change did; without one, it judges the
// page as it stands, and every finding counts.
function levelFor({ state, impact }, failOn) {
  if (state === 'inherited') return 'pass';
  return reaches(impact, failOn) ? 'fail' : 'warn';
}

// Folds the findings of every form factor into one list: the same rule broken
// on mobile and desktop is one finding, seen twice, and `formFactors` says
// where. The element count is the worst of the two rather than their sum —
// they are the same page, measured twice.
//
// The elements are the union of both lists. An element is the same one on both
// form factors when its DOM path is; its selector is no identity at all, and
// keying on it once kept 19 of a page's 51 contrast failures. Something that is
// not a DOM element — a console error — is the same one when everything said
// of it is. Within one form factor nothing is folded: every item Lighthouse
// listed is its own element.
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
      if (finding.detail) entry.detail ??= finding.detail;
      entry.count = Math.max(entry.count, finding.count);
      entry.formFactors.push(formFactor);

      const seenBefore = new Set(entry.seen);
      for (const { path, ...node } of finding.nodes) {
        const key = path || [node.selector, node.snippet, node.label, node.url, node.explanation].join('\n');
        entry.seen.add(key);
        if (!seenBefore.has(key)) entry.nodes.push(node);
      }
    }
  }

  return [...byRule.values()].map(({ seen, ...finding }) => finding);
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

// --- for the surfaces that print elements ------------------------------------
//
// The audit itself returns the raw fields; these say how to read them.

// Where to go and look: the element's selector, else its tag, else the resource
// or the place in a script the rule named.
export function elementWhere({ selector, snippet, url }) {
  return selector || snippet || url || '';
}

// What tells an element apart from the others sharing its selector: its text,
// on one line — or, when it has none, as an image has none, its opening tag, as
// long as the tag says more than its name. Lighthouse falls back to the
// selector when there is no text, which is no text at all. Returns
// { text } or { tag }, or null when there is nothing to add.
export function elementHint({ label, selector, snippet }) {
  const text = (label ?? '').replace(/\s+/g, ' ').trim();
  if (text && text !== selector) return { text };
  if (snippet && selector && !/^<[\w-]+>$/.test(snippet)) return { tag: snippet };
  return null;
}

// An explanation on one line: axe's "Fix any of the following:" and its
// siblings dropped, the checks that failed joined.
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

// How a finding's elements are counted in a report: "51 elements" when every
// listed one is in the DOM, "2 items" when some are not — a console error is
// no element. Empty for a rule that failed as a whole, with nothing listed: a
// missing doctype is not "0 elements".
export function countLabel({ count, nodes }) {
  if (count === 0) return '';
  const noun = nodes.every((node) => node.selector) ? 'element' : 'item';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
