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
      canonical: { id: 'canonical', score: null, scoreDisplayMode: 'notApplicable', title: 'canonical' },
      'structured-data': { id: 'structured-data', score: null, scoreDisplayMode: 'manual', title: 'structured data' },
    },
  };
}

function evaluate(current, { baseline = null, config = { fail_on: 'serious' } } = {}) {
  const extracted = seo.extract(current);
  return seo.evaluate({
    formFactors: {
      mobile: { current: extracted, baseline: baseline && seo.extract(baseline) },
      desktop: { current: extracted, baseline: baseline && seo.extract(baseline) },
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
