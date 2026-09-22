import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, compare, countLabel, elementHint, elementWhere, evaluateFindings, explanationLine, extractFindings,
  extractInformative, MAX_NODES, sortFindings,
} from '../findings.js';

const CONTRAST = 'Fix any of the following:\n  Element has insufficient color contrast of 4.27 (foreground color: #7a8088, background color: #1c1c1e, font size: 7.5pt (10px), font weight: normal). Expected contrast ratio of 4.5:1';

// The shape Lighthouse returns for an axe rule: a score of 0 with the failing
// elements in details.items, and the rule's impact in details.debugData.
function lhr(rules) {
  return {
    categories: { accessibility: { auditRefs: Object.keys(rules).map((id) => ({ id })) } },
    audits: Object.fromEntries(Object.entries(rules).map(([id, rule]) => [id, {
      score: 'score' in rule ? rule.score : 0,
      title: rule.title ?? `${id} is broken`,
      details: {
        items: (rule.selectors ?? []).map((selector, i) => ({ node: {
          type: 'node',
          selector,
          snippet: `<p class="${selector}">`,
          nodeLabel: `text ${i}`,
          explanation: CONTRAST,
          path: `1,HTML,1,BODY,${i},P`,
        } })),
        ...(rule.impact ? { debugData: { type: 'debugdata', impact: rule.impact } } : {}),
      },
    }])),
  };
}

// Accessibility's reading of a finding: the impact axe gave its rule.
function axe(report) {
  return extractFindings(report, { category: 'accessibility', impactOf: (audit) => audit.details?.debugData?.impact ?? null });
}

test('extract keeps the rules the page failed, with their impact and elements', () => {
  const findings = axe(lhr({
    'color-contrast': { impact: 'serious', selectors: ['p.intro', 'a.cta'] },
    'image-alt': { impact: 'critical', selectors: ['img.logo'] },
    'html-has-lang': { score: 1, selectors: [] },
    'video-caption': { score: null, selectors: [] },
  }));

  assert.deepEqual(findings.map((f) => f.rule), ['color-contrast', 'image-alt']);
  assert.equal(findings[0].impact, 'serious');
  assert.equal(findings[0].count, 2);
  assert.deepEqual(findings[0].nodes.map((n) => n.selector), ['p.intro', 'a.cta']);
});

// What an agent needs to fix a contrast failure without reloading the page: the
// ratio and both colours, and the text to find the element by.
test('extract keeps what axe says is wrong with each element, and its text', () => {
  const [finding] = axe(lhr({ 'color-contrast': { impact: 'serious', selectors: ['span.label'] } }));

  assert.deepEqual(finding.nodes[0], {
    selector: 'span.label',
    snippet: '<p class="span.label">',
    label: 'text 0',
    explanation: CONTRAST,
    path: '1,HTML,1,BODY,0,P',
  });
});

// A rule with no impact reported is still a violation; it is judged as
// `serious` rather than slipping under the default threshold (impact.js).
test('extract survives a rule Lighthouse reported without an impact', () => {
  const [finding] = axe(lhr({ 'aria-valid-attr': { selectors: ['div#app'] } }));
  assert.equal(finding.impact, null);
});

test('extract keeps the whole element count but not every element', () => {
  const selectors = Array.from({ length: MAX_NODES + 20 }, (_, i) => `p:nth-child(${i})`);
  const [finding] = axe(lhr({ 'color-contrast': { impact: 'serious', selectors } }));

  assert.equal(finding.count, MAX_NODES + 20);
  assert.equal(finding.nodes.length, MAX_NODES);
});

// Lighthouse shortens selectors, so ten spans in ten cards share one. Keyed on
// the selector, a page's 51 contrast failures once came out as 19.
test('aggregate keeps every element, however many share a selector', () => {
  const findings = axe(lhr({ 'color-contrast': { impact: 'serious', selectors: ['span.label', 'span.label', 'span.label'] } }));

  const [finding] = aggregate({ mobile: findings, desktop: null });

  assert.deepEqual(finding.nodes.map((n) => n.label), ['text 0', 'text 1', 'text 2']);
});

// The same element on both form factors is listed once, and the DOM path that
// said so is not reported: it names nothing a reader can search for.
test('aggregate lists an element failing on both form factors once', () => {
  const mobile = axe(lhr({ 'color-contrast': { impact: 'serious', selectors: ['span.label', 'span.label'] } }));
  const desktop = axe(lhr({ 'color-contrast': { impact: 'serious', selectors: ['span.label', 'span.label', 'span.label'] } }));

  const [finding] = aggregate({ mobile, desktop });

  assert.deepEqual(finding.nodes.map((n) => n.label), ['text 0', 'text 1', 'text 2']);
  assert.ok(finding.nodes.every((n) => !('path' in n)));
});

test('aggregate folds the same rule seen on both form factors into one finding', () => {
  const findings = aggregate({
    mobile: [{ rule: 'color-contrast', title: 't', impact: 'serious', count: 3, nodes: [{ selector: 'p.a' }, { selector: 'p.b' }] }],
    desktop: [{ rule: 'color-contrast', title: 't', impact: 'serious', count: 2, nodes: [{ selector: 'p.a' }, { selector: 'p.c' }] }],
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].formFactors, ['mobile', 'desktop']);
  assert.equal(findings[0].count, 3, 'the same page measured twice, not twice the problem');
  assert.deepEqual(findings[0].nodes.map((n) => n.selector), ['p.a', 'p.b', 'p.c']);
});

test('aggregate keeps a rule that only broke on one form factor', () => {
  const findings = aggregate({
    mobile: [{ rule: 'target-size', title: 't', impact: 'serious', count: 1, nodes: [] }],
    desktop: [],
  });

  assert.deepEqual(findings[0].formFactors, ['mobile']);
});

test('aggregate ignores a form factor whose load produced nothing', () => {
  const findings = aggregate({ mobile: [{ rule: 'image-alt', title: 't', impact: 'critical', count: 1, nodes: [] }], desktop: null });
  assert.equal(findings.length, 1);
});

// --- what axe could not settle ------------------------------------------------

// A rule is broken or it is not — except when axe says it cannot tell. Then
// what it reports is a doubt, and everything downstream has to keep knowing
// that, or a page nobody could check reads as a page that passed.
test('a rule that needs review on both form factors still needs review', () => {
  const doubt = (formFactor) => [{ rule: 'color-contrast', title: 't', impact: 'moderate', count: 1, nodes: [{ selector: `p.${formFactor}` }], needsReview: true }];
  const [finding] = aggregate({ mobile: doubt('mobile'), desktop: doubt('desktop') });

  assert.equal(finding.needsReview, true);
  assert.equal(finding.impact, 'moderate');
});

// The screen that could decide settles it: a contrast axe could not compute on
// a phone, and found wrong on a desktop, is wrong.
test('a rule broken on one form factor and merely doubted on the other is broken', () => {
  const [finding] = aggregate({
    mobile: [{ rule: 'color-contrast', title: 'could not be determined', impact: 'moderate', count: 1, nodes: [], needsReview: true }],
    desktop: [{ rule: 'color-contrast', title: 'contrast is too low', impact: 'serious', count: 2, nodes: [] }],
  });

  assert.equal(finding.needsReview, undefined);
  assert.equal(finding.impact, 'serious', 'an impact nobody gave must not win over one somebody did');
  assert.equal(finding.title, 'contrast is too low');
});

// A count of elements that fail and a count of elements nobody could decide on
// are not two measures of one thing, and subtracting them would say nothing.
test('compare judges a doubt as it stands rather than against a certainty', () => {
  const current = [{ rule: 'color-contrast', title: 't', impact: 'moderate', count: 1, nodes: [], needsReview: true }];
  const baseline = [{ rule: 'color-contrast', title: 't', impact: 'serious', count: 4, nodes: [] }];

  const { findings } = compare(current, baseline);
  assert.equal(findings[0].state, null);
  assert.equal(findings[0].baselineCount, null);

  // And the same the other way round.
  const back = compare(baseline, current).findings;
  assert.equal(back[0].state, null);
});

test('compare still weighs a doubt against the same doubt', () => {
  const doubt = (count) => [{ rule: 'color-contrast', title: 't', impact: 'moderate', count, nodes: [], needsReview: true }];

  assert.equal(compare(doubt(2), doubt(2)).findings[0].state, 'inherited');
  assert.equal(compare(doubt(3), doubt(2)).findings[0].state, 'worse');
});

test('compare tells a new rule from one that grew from one already there', () => {
  const current = [
    { rule: 'image-alt', count: 1, nodes: [] },
    { rule: 'color-contrast', count: 5, nodes: [] },
    { rule: 'label', count: 2, nodes: [] },
  ];
  const baseline = [
    { rule: 'color-contrast', count: 3, nodes: [] },
    { rule: 'label', count: 2, nodes: [] },
    { rule: 'link-name', count: 4, nodes: [] },
  ];

  const { findings, fixed } = compare(current, baseline);

  assert.deepEqual(findings.map((f) => [f.rule, f.state]), [
    ['image-alt', 'new'],
    ['color-contrast', 'worse'],
    ['label', 'inherited'],
  ]);
  assert.deepEqual(fixed.map((f) => f.rule), ['link-name']);
});

// Selectors move when the page does; counts do not. A finding whose elements
// were renamed but not multiplied is the same finding.
test('compare does not call a finding new because its selectors moved', () => {
  const current = [{ rule: 'color-contrast', count: 2, nodes: [{ selector: 'div:nth-child(4) > p' }] }];
  const baseline = [{ rule: 'color-contrast', count: 2, nodes: [{ selector: 'div:nth-child(3) > p' }] }];

  const { findings } = compare(current, baseline);
  assert.equal(findings[0].state, 'inherited');
});

test('compare without a baseline leaves every state unset', () => {
  const { findings, fixed } = compare([{ rule: 'image-alt', count: 1, nodes: [] }], null);
  assert.equal(findings[0].state, null);
  assert.deepEqual(fixed, []);
});

test('an explanation reads on one line, without axe\'s preamble', () => {
  assert.equal(
    explanationLine(CONTRAST),
    'Element has insufficient color contrast of 4.27 (foreground color: #7a8088, background color: #1c1c1e, font size: 7.5pt (10px), font weight: normal). Expected contrast ratio of 4.5:1',
  );
  assert.equal(
    explanationLine('Fix all of the following:\n  Element is focusable\n\nFix any of the following:\n  Element has no alt\n  Element has no title'),
    'Element is focusable; Element has no alt; Element has no title',
  );
  assert.equal(explanationLine(''), '');
  assert.equal(explanationLine(undefined), '');
});

// Ten elements can share a selector; their text tells them apart, and an image,
// which has none, is told apart by its tag.
test('an element is told apart by its text, or by its tag when it has no text', () => {
  assert.deepEqual(elementHint({ selector: 'td', label: 'Metric\tmain\nLCP\t1.2s', snippet: '<td>' }), { text: 'Metric main LCP 1.2s' });
  assert.deepEqual(elementHint({ selector: 'body > img', label: 'body > img', snippet: '<img src="/hero.png">' }), { tag: '<img src="/hero.png">' });
  assert.equal(elementHint({ selector: 'html', label: 'html', snippet: '<html>' }), null, 'a bare tag says nothing the selector did not');
  assert.equal(elementHint({ selector: '', snippet: '<img src="/a.png">' }), null, 'a tag already standing in for the selector');
});

test('sortFindings puts what fails first, heaviest impact down', () => {
  const sorted = sortFindings([
    { rule: 'label', impact: 'critical', level: 'pass' },
    { rule: 'image-alt', impact: 'moderate', level: 'warn' },
    { rule: 'color-contrast', impact: 'serious', level: 'fail' },
    { rule: 'aria-roles', impact: 'critical', level: 'fail' },
  ]);

  assert.deepEqual(sorted.map((f) => f.rule), ['aria-roles', 'color-contrast', 'image-alt', 'label']);
});

// --- beyond axe: SEO and best practices ------------------------------------
//
// Their failures come as Lighthouse tables, not axe nodes: a node under any
// heading, a URL, a place in a script, text columns. The shapes below are the
// ones Lighthouse 13 produced on a real page.

// A report whose `category` holds the given audits, each { score, headings, items, ... }.
function report(category, audits) {
  return {
    categories: { [category]: { auditRefs: Object.keys(audits).map((id) => ({ id })) } },
    audits: Object.fromEntries(Object.entries(audits).map(([id, { headings = [], items, ...audit }]) => [id, {
      id, score: 0, scoreDisplayMode: 'binary', title: `${id} failed`, ...audit,
      ...(items ? { details: { type: 'table', headings, items } } : {}),
    }])),
  };
}

// Every rule ranked `moderate`, whatever the category the report holds.
const moderate = (lhr) => extractFindings(lhr, { category: Object.keys(lhr.categories)[0], impactOf: () => 'moderate' });

const IMG = { type: 'node', selector: 'body > img', snippet: '<img src="/wide.png" width="100" height="100">', nodeLabel: 'body > img', path: '0,HTML,1,BODY,4,IMG' };

test('a table item becomes an element: its node, its URL, and the columns Lighthouse shows, in its words', () => {
  const [finding] = moderate(report('best-practices', {
    'image-aspect-ratio': {
      headings: [
        { key: 'node', valueType: 'node', label: '' },
        { key: 'url', valueType: 'url', label: 'URL' },
        { key: 'displayedAspectRatio', valueType: 'text', label: 'Aspect Ratio (Displayed)' },
        { key: 'actualAspectRatio', valueType: 'text', label: 'Aspect Ratio (Actual)' },
      ],
      items: [{
        url: 'http://localhost:4173/wide.png', node: IMG,
        displayedAspectRatio: '100 x 100\n        (1.00)', actualAspectRatio: '400 x 100\n        (4.00)', doRatiosMatch: false,
      }],
    },
  }));

  assert.equal(finding.impact, 'moderate');
  assert.deepEqual(finding.nodes[0], {
    selector: 'body > img',
    snippet: '<img src="/wide.png" width="100" height="100">',
    label: 'body > img',
    explanation: 'Aspect Ratio (Displayed): 100 x 100 (1.00)\nAspect Ratio (Actual): 400 x 100 (4.00)',
    path: '0,HTML,1,BODY,4,IMG',
    url: 'http://localhost:4173/wide.png',
  });
});

// What an agent needs to find a console error without reloading the page: the
// message, and the script and line that logged it.
test('a failure with no DOM element keeps the place it names', () => {
  const [finding] = moderate(report('best-practices', {
    'errors-in-console': {
      headings: [
        { key: 'sourceLocation', valueType: 'source-location', label: 'Source' },
        { key: 'description', valueType: 'code', label: 'Description' },
      ],
      items: [
        { source: 'console.error', description: 'boom', sourceLocation: { type: 'source-location', url: 'http://localhost:4173/', urlProvider: 'network', line: 13, column: 16 } },
        { source: 'network', description: 'Failed to load resource: the server responded with a status of 404 (Not Found)', sourceLocation: { type: 'source-location', url: 'http://localhost:4173/favicon.ico', urlProvider: 'network', line: 0, column: 0 } },
      ],
    },
  }));

  assert.equal(finding.count, 2);
  assert.deepEqual(finding.nodes.map(({ url, explanation, selector }) => ({ url, explanation, selector })), [
    { url: 'http://localhost:4173/:14:16', explanation: 'Description: boom', selector: '' },
    { url: 'http://localhost:4173/favicon.ico:1:0', explanation: 'Description: Failed to load resource: the server responded with a status of 404 (Not Found)', selector: '' },
  ]);
});

test('a node is read wherever it sits, and sub-items are the reasons behind it', () => {
  const [hreflang, crawlable] = moderate(report('seo', {
    hreflang: {
      headings: [{ key: 'source', valueType: 'code', subItemsHeading: { key: 'reason', valueType: 'text' }, label: '' }],
      items: [{
        source: { type: 'node', selector: 'head > link', snippet: '<link rel="alternate" hreflang="xx-nope" href="/fr" />', nodeLabel: 'head > link', path: '0,HTML,0,HEAD,2,LINK' },
        subItems: { type: 'subitems', items: [{ reason: 'Unexpected language code' }, { reason: 'Relative href value' }] },
      }],
    },
    // A noindex sent as a header is no element, and is said as Lighthouse says it.
    'is-crawlable': {
      headings: [{ key: 'source', valueType: 'code', label: 'Blocking Directive Source' }],
      items: [{ source: 'X-Robots-Tag: noindex' }],
    },
  }));

  assert.equal(hreflang.nodes[0].snippet, '<link rel="alternate" hreflang="xx-nope" href="/fr" />');
  assert.equal(hreflang.nodes[0].explanation, 'Unexpected language code\nRelative href value');
  assert.equal(crawlable.count, 1);
  assert.equal(crawlable.nodes[0].explanation, 'Blocking Directive Source: X-Robots-Tag: noindex');
});

// axe nests the related nodes of a failure — the cells a header should cover —
// as sub-items: they are not where the rule failed, and are not listed as if.
test('the DOM nodes nested as sub-items are left out', () => {
  const [finding] = axe({
    categories: { accessibility: { auditRefs: [{ id: 'td-has-header' }] } },
    audits: { 'td-has-header': { score: 0, title: 't', details: {
      headings: [{ key: 'node', valueType: 'node', subItemsHeading: { key: 'relatedNode', valueType: 'node' }, label: 'Failing Elements' }],
      items: [{ node: { type: 'node', selector: 'table', snippet: '<table>', nodeLabel: 'table', explanation: 'Fix all of the following:\n  Some non-empty data cells do not have table headers', path: '1,HTML' },
        subItems: { type: 'subitems', items: [{ relatedNode: { type: 'node', selector: 'td', snippet: '<td>' } }] } }],
      debugData: { type: 'debugdata', impact: 'critical' },
    } } },
  });

  assert.equal(finding.nodes.length, 1);
  assert.equal(finding.nodes[0].explanation, 'Fix all of the following:\n  Some non-empty data cells do not have table headers');
});

test('a rule that failed as a whole carries what Lighthouse said of it', () => {
  const findings = moderate(report('best-practices', {
    doctype: { explanation: 'Document must contain a doctype' },
    'http-status-code': { displayValue: '404' },
    'meta-description': {},
    // With items listed, the display value only counts them again.
    'link-text': {
      displayValue: '1 link found',
      headings: [{ key: 'href', valueType: 'url', label: 'Link destination' }, { key: 'text', valueType: 'text', label: 'Link Text' }],
      items: [{ href: 'http://localhost:4173/more', text: 'click here' }],
    },
  }));

  assert.deepEqual(findings.map((f) => [f.rule, f.count, f.detail]), [
    ['doctype', 0, 'Document must contain a doctype'],
    ['http-status-code', 0, '404'],
    ['meta-description', 0, undefined],
    ['link-text', 1, undefined],
  ]);
  assert.deepEqual(findings[3].nodes[0], { selector: '', snippet: '', label: '', explanation: 'Link Text: click here', path: '', url: 'http://localhost:4173/more' });
});

test('the informative audits of a group are kept as facts, one line per item, and only the ones that listed something', () => {
  const lhr = report('best-practices', {
    'csp-xss': {
      score: 1, scoreDisplayMode: 'informative', title: 'Ensure CSP is effective against XSS attacks',
      headings: [
        { key: 'description', valueType: 'text', label: 'Description' },
        { key: 'directive', valueType: 'code', label: 'Directive' },
        { key: 'severity', valueType: 'text', label: 'Severity' },
      ],
      items: [
        { severity: 'High', description: 'No CSP found in enforcement mode' },
        { severity: 'Medium', description: 'Missing base-uri allows injected <base> tags', directive: 'base-uri' },
      ],
    },
    'has-hsts': { score: 1, scoreDisplayMode: 'informative', items: [] },
    // Informative, but filed under another group.
    'js-libraries': {
      score: 1, scoreDisplayMode: 'informative',
      headings: [{ key: 'name', valueType: 'text', label: 'Name' }], items: [{ name: 'Vue' }],
    },
    // Scored, so a finding or nothing — never a note.
    'is-on-https': { score: 0, items: [{ url: 'http://a/' }], headings: [{ key: 'url', valueType: 'url', label: 'URL' }] },
  });
  for (const ref of lhr.categories['best-practices'].auditRefs) {
    ref.group = ref.id === 'js-libraries' ? 'best-practices-general' : 'best-practices-trust-safety';
  }

  assert.deepEqual(extractInformative(lhr, { category: 'best-practices', group: 'best-practices-trust-safety' }), [
    { rule: 'csp-xss', title: 'Ensure CSP is effective against XSS attacks', items: [
      'Description: No CSP found in enforcement mode; Severity: High',
      'Description: Missing base-uri allows injected <base> tags; Directive: base-uri; Severity: Medium',
    ] },
  ]);
});

// Keyed on an empty selector, every console error of the second form factor
// would read as one already seen.
test('aggregate tells apart failures that are no DOM element by what is said of them', () => {
  const error = (description) => ({ selector: '', snippet: '', label: '', explanation: description, path: '', url: 'http://localhost:4173/app.js:1:0' });
  const [finding] = aggregate({
    mobile: [{ rule: 'errors-in-console', title: 't', impact: 'moderate', count: 1, nodes: [error('boom')] }],
    desktop: [{ rule: 'errors-in-console', title: 't', impact: 'moderate', count: 2, nodes: [error('boom'), error('bang')] }],
  });

  assert.deepEqual(finding.nodes.map((n) => n.explanation), ['boom', 'bang']);
});

// A form factor's worth of findings, for evaluateFindings.
const loads = (current, baseline = null) => ({
  formFactors: { mobile: { current: { findings: current }, baseline: baseline && { findings: baseline } }, desktop: { current: null, baseline: null } },
  baselineAudited: baseline != null,
});
const finding = (rule, impact, count = 1) => ({ rule, title: rule, impact, count, nodes: [] });

// The noindex every preview host sends: true of the deployment, not of the code.
test('an ignored rule is neither reported nor judged, on either page, and the report says it was ignored', () => {
  const result = evaluateFindings(
    loads([finding('is-crawlable', 'critical'), finding('meta-description', 'moderate')], [finding('canonical', 'serious')]),
    { ignore: ['is-crawlable', 'canonical'] },
  );

  assert.deepEqual(result.levels, { 'meta-description': 'warn' });
  assert.deepEqual(result.fixed, [], 'an ignored rule is not "fixed" either');
  assert.deepEqual(result.ignore, ['is-crawlable', 'canonical']);
});

test('ignore takes one rule or a list, and nothing else', () => {
  const page = loads([finding('is-crawlable', 'critical')]);
  assert.deepEqual(evaluateFindings(page, { ignore: 'is-crawlable' }).levels, {});
  assert.deepEqual(evaluateFindings(page, { ignore: { rule: 'is-crawlable' } }).ignore, []);
  assert.deepEqual(evaluateFindings(page, {}).ignore, []);
});

test('a finding is counted in elements when they are all in the DOM, in items otherwise, and not at all when none was listed', () => {
  assert.equal(countLabel({ count: 51, nodes: [{ selector: 'p' }] }), '51 elements');
  assert.equal(countLabel({ count: 1, nodes: [{ selector: '', url: 'http://localhost:4173/favicon.ico' }] }), '1 item');
  assert.equal(countLabel({ count: 0, nodes: [] }), '');
});

test('an element is placed by its selector, else its tag, else the URL it names', () => {
  assert.equal(elementWhere({ selector: 'body > img', snippet: '<img>', url: 'http://a/b.png' }), 'body > img');
  assert.equal(elementWhere({ selector: '', snippet: '<meta name="robots">', url: '' }), '<meta name="robots">');
  assert.equal(elementWhere({ selector: '', snippet: '', url: 'http://a/app.js:3:1' }), 'http://a/app.js:3:1');
});

// --- the declared states of a page ------------------------------------------------

// A rule broken in the menu is not the same finding as that rule broken on the
// page as it loads: two places to go and fix, each compared and judged on its
// own. And a project that declares no state sees exactly what it saw before.
const at = (state, rule, impact, count = 1) => ({ ...finding(rule, impact, count), at: state });

test('a rule broken in two states is two findings, and its level says where', () => {
  const result = evaluateFindings(loads([finding('color-contrast', 'serious'), at('menu', 'color-contrast', 'serious', 3)]));

  assert.deepEqual(result.findings.map(({ rule, at: where, count }) => [rule, where, count]), [
    ['color-contrast', undefined, 1],
    ['color-contrast', 'menu', 3],
  ]);
  assert.deepEqual(result.levels, { 'color-contrast': 'fail', 'color-contrast@menu': 'fail' });
});

test('aggregate folds a rule state by state, across form factors', () => {
  const folded = aggregate({
    mobile: [at('menu', 'button-name', 'critical'), finding('button-name', 'critical')],
    desktop: [at('menu', 'button-name', 'critical', 2)],
  });

  assert.deepEqual(folded.map(({ rule, at: where, count, formFactors }) => [rule, where, count, formFactors]), [
    ['button-name', 'menu', 2, ['mobile', 'desktop']],
    ['button-name', undefined, 1, ['mobile']],
  ]);
});

test('a state is compared with the same state of the baseline, never with its page as it loads', () => {
  const { findings, fixed } = compare(
    [finding('color-contrast', 'serious', 2), at('menu', 'color-contrast', 'serious', 2)],
    [finding('color-contrast', 'serious', 2), at('signup', 'label', 'critical')],
  );

  assert.deepEqual(findings.map(({ at: where, state }) => [where, state]), [[undefined, 'inherited'], ['menu', 'new']]);
  assert.deepEqual(fixed, [{ rule: 'label', at: 'signup', title: 'label', impact: 'critical', count: 1 }]);
});

// The change renamed the button that opens the menu: the page under audit
// reaches the menu, the baseline cannot. What is found there has nothing to be
// compared with, and is judged as it stands — not called new.
test('a state the baseline could not reach leaves what is found there unjudged against it', () => {
  const unreached = { probe: 'axe', rules: ['color-contrast', 'label'], error: 'nothing visible to click at #open', at: 'menu' };
  const result = evaluateFindings({
    formFactors: {
      mobile: {
        current: { findings: [finding('color-contrast', 'serious'), at('menu', 'color-contrast', 'serious')] },
        baseline: { findings: [], probeFailures: [unreached] },
      },
      desktop: { current: null, baseline: null },
    },
    baselineAudited: true,
  });

  assert.deepEqual(result.findings.map(({ at: where, state }) => [where ?? null, state]), [[null, 'new'], ['menu', null]]);
  assert.deepEqual(result.probeFailures, [{ ...unreached, side: 'baseline', formFactor: 'mobile' }]);
});

test('what the baseline broke in a state the page under audit could not reach is not fixed', () => {
  const result = evaluateFindings({
    formFactors: {
      mobile: {
        current: { findings: [], probeFailures: [{ probe: 'axe', rules: ['label'], error: 'timed out after 30s', at: 'signup' }] },
        baseline: { findings: [at('signup', 'label', 'critical'), finding('image-alt', 'critical')] },
      },
      desktop: { current: null, baseline: null },
    },
    baselineAudited: true,
  });

  assert.deepEqual(result.fixed.map(({ rule, at: where }) => [rule, where]), [['image-alt', undefined]]);
});

test('an ignored rule is ignored in every state', () => {
  const result = evaluateFindings(loads([finding('region', 'moderate'), at('menu', 'region', 'moderate'), at('menu', 'label', 'critical')]), { ignore: ['region'] });
  assert.deepEqual(result.levels, { 'label@menu': 'fail' });
});
