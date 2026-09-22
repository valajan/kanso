import axeCore from 'axe-core';

import { MAX_NODES } from '../findings.js';
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

// The rules Kanso holds a page to: WCAG A and AA, every version, plus what axe
// calls best practice — the structural rules no criterion demands and every
// screen reader user feels, a page without a main landmark, a heading level
// skipped. Written as tags rather than as a list of rules, so that an axe
// upgrade brings its new rules with it.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'];

// And one rule no tag of that set covers: AAA, but the only AAA rule axe can
// decide on its own, and Lighthouse runs it too.
const ALSO = ['identical-links-same-purpose'];

// `elementRef` is what makes the translation possible: axe hands back the
// element it failed on, not just a selector for it. `resultTypes` says which
// results are worth the expensive work of identifying elements — the ones
// Kanso reports.
const OPTIONS = {
  elementRef: true,
  resultTypes: ['violations'],
  runOnly: { type: 'tag', values: TAGS },
  rules: Object.fromEntries(ALSO.map((rule) => [rule, { enabled: true }])),
};

export const axeProbe = {
  id: 'axe',
  rules: ruleIds(),
  // Injected into the document and into every frame of it, before the page's
  // first script runs.
  beforeLoad: axeCore.source,

  async run(page) {
    return axeFindings(await inPage(page, runAxe, OPTIONS, MAX_NODES));
  },
};

// Every rule the probe covers, and so what nobody checked if it fails. Read
// from axe rather than written down: axe runs in Node as well as in a page.
export function ruleIds() {
  return [...new Set([...axeCore.getRules(TAGS).map((rule) => rule.ruleId), ...ALSO])].sort();
}

// The findings, from what axe reported of the page — `runAxe` below. One
// broken rule is one finding, with the elements it broke on; the shape is the
// one every other finding has (src/modules/findings.js), which is what lets
// the rest of Kanso stay unaware of where a finding came from.
export function axeFindings(violations) {
  return violations.map(({ id, help, impact, tags, count, nodes }) => {
    const detail = detailOf(tags ?? []);
    return {
      rule: id,
      title: help,
      impact: impact ?? null,
      count,
      nodes,
      ...(detail ? { detail } : {}),
    };
  });
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

  return results.violations.map((rule) => ({
    id: rule.id,
    help: rule.help,
    impact: rule.impact,
    tags: rule.tags,
    count: rule.nodes.length,
    nodes: rule.nodes.slice(0, maxNodes).map((node) => ({
      ...(node.element ? dom.describe(node.element) : inFrame(node)),
      explanation: node.failureSummary ?? '',
    })),
  }));

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
