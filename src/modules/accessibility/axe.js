import axeCore from 'axe-core';

import { MAX_NODES } from '../findings.js';
import { capImpact } from '../impact.js';
import { inPage } from '../../probes/dom.js';

// axe-core itself, run by Kanso on the page rather than by Lighthouse.
//
// Lighthouse embeds axe and is, for accessibility, nothing but a launcher for
// it: Kanso never reads its score, only the rules it says are broken. But the
// launcher is a narrow one — its rule list is written into the gatherer, where
// no config reaches it, and a third of what axe knows is switched off there.
// Running axe directly is the same measure through a wider window: the rules
// are Kanso's to choose, and the version is Kanso's to bump.
//
// The probe injects axe before the page's own scripts, so it lands in every
// frame and no Content-Security-Policy of the page can refuse it, and reads
// the document once it has loaded. What axe finds is translated where it is
// found: an element does not cross the browser boundary, so everything Kanso
// reports of one is read inside the page (src/probes/dom.js).
//
// It measures nothing and moves nothing: a rule is broken on a set of
// elements, or it is not.

// The rules Kanso holds a page to when .kanso.yml says nothing: WCAG A and AA,
// every version, plus what axe calls best practice — the structural rules no
// criterion demands and every screen reader user feels, a page without a main
// landmark, a heading level skipped. Written as tags rather than as a list of
// rules, so that an axe upgrade brings its new rules with it, and so that a
// project can widen or narrow the set in one line.
const DEFAULT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'];

// And one rule no tag of that set covers: AAA, but the only AAA rule axe can
// decide on its own, and Lighthouse runs it too.
const ALSO = ['identical-links-same-purpose'];

// What axe cannot decide on its own is worth no more than this. A page whose
// text sits on a photograph gets "I cannot read this contrast", not "this
// contrast is wrong", and a doubt must not fail an audit at the default
// threshold.
const REVIEW_CEILING = 'moderate';

// `elementRef` is what makes the translation possible: axe hands back the
// element it failed on, not just a selector for it. `resultTypes` says which
// results are worth the expensive work of identifying elements — the ones
// Kanso reports, which includes what axe could not settle.
function optionsFor(tags) {
  return {
    elementRef: true,
    resultTypes: ['violations', 'incomplete'],
    runOnly: { type: 'tag', values: tags },
    rules: Object.fromEntries(ALSO.map((rule) => [rule, { enabled: true }])),
  };
}

export const axeProbe = {
  id: 'axe',
  rules: (config) => ruleIds(tagsOf(config)),
  // Read again in every state the project declares: axe reads the document as
  // it stands, and a menu opened is a document of its own. It costs a reading,
  // not a load.
  states: true,
  // Injected into the document and into every frame of it, before the page's
  // first script runs.
  beforeLoad: axeCore.source,

  async run(page, { config } = {}) {
    return axeFindings(await inPage(page, runAxe, optionsFor(tagsOf(config)), MAX_NODES));
  },
};

// The tags a project holds its pages to — `accessibility: { tags: [...] }` —
// or the default set. A tag axe does not know is dropped rather than obeyed:
// it would silently narrow the audit, and a set narrowed to nothing would
// report a clean page while checking none of it. Same rule as `fail_on:`, for
// the same reason.
export function tagsOf(config = {}) {
  const asked = typeof config?.tags === 'string' ? [config.tags] : Array.isArray(config?.tags) ? config.tags : [];
  const known = asked.filter((tag) => KNOWN_TAGS.has(tag));
  return known.length > 0 ? known : DEFAULT_TAGS;
}

// Every rule the probe covers, and so what nobody checked if it fails. Read
// from axe rather than written down: axe runs in Node as well as in a page.
export function ruleIds(tags = DEFAULT_TAGS) {
  return [...new Set([...axeCore.getRules(tags).map((rule) => rule.ruleId), ...ALSO])].sort();
}

const KNOWN_TAGS = new Set(axeCore.getRules().flatMap((rule) => rule.tags));

// The findings, from what axe reported of the page — `runAxe` below. One
// broken rule is one finding, with the elements it broke on; the shape is the
// one every other finding has (src/modules/findings.js), which is what lets
// the rest of Kanso stay unaware of where a finding came from.
//
// axe answers in two registers, and Lighthouse reports only the first: the
// rules it saw broken, and the rules it could not settle — text on a gradient
// or a photograph, an element it could not compute. Those come back as
// findings too, marked `needsReview` and capped, because a page nobody checked
// must not read as a page that passed. That is the single largest thing
// Lighthouse's window leaves out.
//
// A rule that is both broken and unsettled is reported broken, once: whoever
// goes and fixes it will look at every element it names anyway, and two
// findings of one rule would be compared against the baseline as one.
export function axeFindings({ violations = [], incomplete = [] } = {}) {
  const broken = violations.map((rule) => finding(rule));
  const settled = new Set(broken.map((found) => found.rule));

  return [
    ...broken,
    ...incomplete
      .filter((rule) => !settled.has(rule.id))
      .map((rule) => ({ ...finding(rule), impact: capImpact(rule.impact ?? null, REVIEW_CEILING), needsReview: true })),
  ];
}

function finding({ id, help, impact, tags, count, nodes }) {
  const detail = detailOf(tags ?? []);
  return {
    rule: id,
    title: help,
    impact: impact ?? null,
    count,
    nodes,
    ...(detail ? { detail } : {}),
  };
}

// What a rule answers to, from the tags axe gives it: `wcag143` and `wcag2aa`
// together read "WCAG 1.4.3 (AA)". A rule that answers to no criterion is one
// of axe's own and says so — it is no less worth fixing, but nobody should
// read a law into it.
function detailOf(tags) {
  const criteria = tags.filter((tag) => /^wcag\d{3,}$/.test(tag)).map(criterion).sort(byNumber);
  if (criteria.length === 0) return tags.includes('best-practice') ? 'Best practice' : '';
  const level = levelOf(tags);
  return `WCAG ${criteria.join(', ')}${level ? ` (${level})` : ''}`;
}

// 1.4.10 comes after 1.4.3, which is not what sorting them as text says.
function byNumber(a, b) {
  const parts = (value) => value.split('.').map(Number);
  return parts(a).reduce((order, part, i) => order || part - parts(b)[i], 0);
}

// `wcag1410` is criterion 1.4.10: principle, guideline, then the rest.
function criterion(tag) {
  const digits = tag.slice('wcag'.length);
  return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
}

// `wcag2a`, `wcag21aa`, `wcag2aaa` — the conformance level, the most demanding
// one when a rule carries several.
function levelOf(tags) {
  const levels = tags.map((tag) => /^wcag\d+(a{1,3})$/.exec(tag)?.[1]).filter(Boolean);
  return levels.sort((a, b) => a.length - b.length)[0]?.toUpperCase() ?? '';
}

// --- in the page ----------------------------------------------------------------

// axe on the document as it stands, translated on the spot. Only what survives
// JSON comes back, so the elements are described here, and the list is cut to
// what Kanso keeps before it is sent — the count stays whole.
async function runAxe(dom, options, maxNodes) {
  const results = await window.axe.run(document, options);

  return { violations: results.violations.map(rule), incomplete: results.incomplete.map(rule) };

  function rule(result) {
    return {
      id: result.id,
      help: result.help,
      impact: result.impact,
      tags: result.tags,
      count: result.nodes.length,
      nodes: result.nodes.slice(0, maxNodes).map((node) => ({
        ...(node.element ? dom.describe(node.element) : inFrame(node)),
        // What axe could not settle has no failure summary, but says what it
        // could not do: "Element's background color could not be determined".
        explanation: node.failureSummary || (node.any ?? []).map((check) => check.message).filter(Boolean).join('\n'),
      })),
    };
  }

  // A node axe found inside a frame: the element belongs to another document
  // and `elementRef` leaves it there. What crosses is the chain of selectors
  // axe walked — the frame, then the element in it — and the opening tag it
  // kept. No DOM path, which is what `aggregate` prefers as an identity; the
  // selector chain and the tag are what tell two of them apart.
  function inFrame({ target, html }) {
    const chain = [target ?? []].flat(2).join(' > ');
    const open = (html ?? '').slice(0, (html ?? '').indexOf('>') + 1 || undefined);
    return { selector: chain, snippet: open.length > 500 ? open.slice(0, 499) + '…' : open, label: '', path: '' };
  }
}
