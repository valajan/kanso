import { test } from 'node:test';
import assert from 'node:assert/strict';
import seo from '../index.js';

// A Lighthouse report whose SEO category failed the given rules, each on one
// element.
function lhr(...rules) {
  return {
    categories: { seo: { auditRefs: [...rules, 'canonical', 'structured-data'].map((id) => ({ id })) } },
    audits: {
      ...Object.fromEntries(rules.map((id) => [id, {
        id, score: 0, scoreDisplayMode: 'binary', title: `${id} failed`,
        details: { type: 'table', headings: [{ key: 'node', valueType: 'node', label: '' }], items: [{ node: { type: 'node', selector: 'head > meta', snippet: '<meta>', path: '0,HTML' } }] },
      }])),
      // A page with a valid canonical: one without is a finding of its own.
      canonical: { id: 'canonical', score: 1, scoreDisplayMode: 'binary', title: 'canonical' },
      'structured-data': { id: 'structured-data', score: null, scoreDisplayMode: 'manual', title: 'structured data' },
    },
  };
}

function evaluate(current, { baseline = null, config = { fail_on: 'serious' }, artifacts, baselineArtifacts } = {}) {
  const extracted = seo.extract(current, { artifacts });
  const before = baseline && seo.extract(baseline, { artifacts: baselineArtifacts });
  return seo.evaluate({
    formFactors: {
      mobile: { current: extracted, baseline: before },
      desktop: { current: extracted, baseline: before },
    },
    baselineAudited: baseline != null,
  }, config);
}

// Two rules of the category are axe's, and accessibility already judges them
// with the impact axe gives them.
test('the axe rules of the SEO category are left to accessibility', () => {
  const { findings } = seo.extract(lhr('document-title', 'image-alt', 'meta-description'));
  assert.deepEqual(findings.map((f) => f.rule), ['meta-description']);
});

test('a page search engines are told to leave out fails; a missing description warns', () => {
  const result = evaluate(lhr('is-crawlable', 'meta-description', 'link-text'));

  assert.deepEqual(result.levels, { 'is-crawlable': 'fail', 'meta-description': 'warn', 'link-text': 'warn' });
  assert.deepEqual(result.findings.map((f) => [f.rule, f.impact]), [
    ['is-crawlable', 'critical'], ['meta-description', 'moderate'], ['link-text', 'minor'],
  ]);
});

// Upgrading Lighthouse must not turn a build red on its own.
test('a rule Kanso has not ranked yet is reported, and warns', () => {
  const result = evaluate(lhr('some-future-rule'));
  assert.equal(result.findings[0].impact, 'moderate');
  assert.equal(result.levels['some-future-rule'], 'warn');
});

// The case preview hosts create, and the two ways out of it.
test('a noindex the baseline already has is inherited, and an ignored one is not looked at', () => {
  const page = lhr('is-crawlable');

  assert.equal(evaluate(page, { baseline: page }).levels['is-crawlable'], 'pass');
  assert.equal(evaluate(page, { baseline: lhr() }).levels['is-crawlable'], 'fail', 'added by the change');
  assert.deepEqual(evaluate(page, { config: { fail_on: 'serious', ignore: ['is-crawlable'] } }).levels, {});
});

test('the module always wants the baseline', () => {
  assert.equal(seo.needsBaseline({ fail_on: 'critical' }), true);
});

// --- what Lighthouse holds and does not report --------------------------------

function withoutCanonical(report) {
  report.audits.canonical = { id: 'canonical', score: null, scoreDisplayMode: 'notApplicable', title: 'canonical' };
  return report;
}

// Lighthouse's MetaElements artifact, as it gathers it: `name` lowercased,
// `property` as written, and the node the tag is.
function metas(tags) {
  return {
    MetaElements: Object.entries(tags).map(([property, content]) => ({
      name: '', property, content,
      node: { selector: 'head > meta', snippet: `<meta property="${property}" content="${content}">`, nodeLabel: '', devtoolsNodePath: `1,HTML,0,HEAD,${property}` },
    })),
  };
}

const PREVIEW = { 'og:title': 'Kanso', 'og:description': 'Audits', 'og:image': 'https://kanso.sh/og.png' };

test('a page naming no canonical URL warns, and is said where Kanso looked', () => {
  const result = evaluate(withoutCanonical(lhr()));

  assert.deepEqual(result.levels, { 'canonical-missing': 'warn' });
  const [finding] = result.findings;
  assert.equal(finding.impact, 'moderate');
  assert.equal(finding.count, 0, 'nothing to count: the rule fails as a whole');
  assert.match(finding.detail, /Link header/);
});

// A canonical that is there is Lighthouse's to judge — valid or not — and a
// canonical Lighthouse could not judge is no evidence of a missing one.
test('only a canonical Lighthouse found absent is reported missing', () => {
  const invalid = lhr();
  invalid.audits.canonical = { id: 'canonical', score: 0, scoreDisplayMode: 'binary', title: 'canonical', details: { items: [] } };
  assert.deepEqual(evaluate(invalid).findings.map((f) => f.rule), ['canonical']);
  const errored = lhr();
  errored.audits.canonical = { id: 'canonical', score: null, scoreDisplayMode: 'error', title: 'canonical' };
  assert.deepEqual(evaluate(errored).findings, []);
});

test('each Open Graph tag a link preview lacks is an item, and the finding warns', () => {
  const result = evaluate(lhr(), { artifacts: metas({ 'og:title': 'Kanso' }) });

  assert.deepEqual(result.levels, { 'open-graph': 'warn' });
  const [finding] = result.findings;
  assert.equal(finding.impact, 'minor');
  assert.equal(finding.count, 2);
  assert.deepEqual(finding.nodes.map((node) => node.explanation), ['og:description is missing', 'og:image is missing']);
  assert.deepEqual(finding.nodes[0], { selector: '', snippet: '', label: '', explanation: 'og:description is missing' },
    'a missing tag is nowhere');
});

// Scrapers fetch the image from the tag alone, with no page to resolve it against.
test('an og:image a scraper cannot fetch is an item, on the tag that says it', () => {
  const { findings } = evaluate(lhr(), { artifacts: metas({ ...PREVIEW, 'og:image': '/og.png' }) });

  assert.equal(findings[0].count, 1);
  assert.equal(findings[0].nodes[0].explanation, 'og:image is not an absolute URL: /og.png');
  assert.equal(findings[0].nodes[0].snippet, '<meta property="og:image" content="/og.png">');
});

test('tags named rather than propertied, and empty ones, are read as scrapers read them', () => {
  const artifacts = metas(PREVIEW);
  artifacts.MetaElements[0] = { ...artifacts.MetaElements[0], property: null, name: 'og:title' };
  assert.deepEqual(evaluate(lhr(), { artifacts }).findings, [], 'name="og:title" counts');

  const empty = metas({ ...PREVIEW, 'og:description': '  ' });
  assert.deepEqual(evaluate(lhr(), { artifacts: empty }).findings[0].nodes.map((n) => n.explanation), ['og:description is missing']);
});

// No artifact is no look at the page, not a page without tags.
test('without the meta elements, nothing is said of Open Graph', () => {
  assert.deepEqual(evaluate(lhr()).findings, []);
  assert.deepEqual(evaluate(lhr(), { artifacts: {} }).findings, []);
});

test('Open Graph is compared like any finding: one more missing tag is worse', () => {
  const result = evaluate(lhr(), {
    artifacts: metas({ 'og:title': 'Kanso' }),
    baseline: lhr(),
    baselineArtifacts: metas({ 'og:title': 'Kanso', 'og:description': 'Audits' }),
  });
  assert.equal(result.findings[0].state, 'worse');

  const same = evaluate(withoutCanonical(lhr()), { artifacts: metas(PREVIEW), baseline: withoutCanonical(lhr()), baselineArtifacts: metas(PREVIEW) });
  assert.deepEqual(same.levels, { 'canonical-missing': 'pass' }, 'inherited');
});
