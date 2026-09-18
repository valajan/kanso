import { test } from 'node:test';
import assert from 'node:assert/strict';
import bestPractices from '../index.js';

const CSP = {
  id: 'csp-xss', score: 1, scoreDisplayMode: 'informative', title: 'Ensure CSP is effective against XSS attacks',
  details: { type: 'table', headings: [{ key: 'description', valueType: 'text', label: 'Description' }], items: [{ description: 'No CSP found in enforcement mode' }] },
};

// A Lighthouse report whose Best Practices category failed the given rules, and
// carries one informative audit.
function lhr(...rules) {
  return {
    categories: { 'best-practices': { auditRefs: [
      ...rules.map((id) => ({ id })),
      { id: 'csp-xss', group: 'best-practices-trust-safety' },
    ] } },
    audits: {
      ...Object.fromEntries(rules.map((id) => [id, { id, score: 0, scoreDisplayMode: 'binary', title: `${id} failed` }])),
      'csp-xss': CSP,
    },
  };
}

function evaluate(mobile, desktop = mobile) {
  return bestPractices.evaluate({
    formFactors: { mobile: { current: mobile, baseline: null }, desktop: { current: desktop, baseline: null } },
    baselineAudited: false,
  }, { fail_on: 'serious' });
}

test('a page served insecurely fails; a console error warns', () => {
  const result = evaluate(bestPractices.extract(lhr('is-on-https', 'errors-in-console', 'image-size-responsive')));

  assert.deepEqual(result.levels, { 'is-on-https': 'fail', 'errors-in-console': 'warn', 'image-size-responsive': 'warn' });
  assert.deepEqual(result.findings.map((f) => f.impact), ['serious', 'moderate', 'minor']);
});

// The security headers Lighthouse reports without scoring are passed through,
// and judge nothing: a build served locally has none of the headers its host
// would add.
test('the security headers are reported, never judged', () => {
  const result = evaluate(bestPractices.extract(lhr()));

  assert.deepEqual(result.levels, {});
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.informative, [{ rule: 'csp-xss', title: CSP.title, items: ['Description: No CSP found in enforcement mode'] }]);
});

test('the informative audits come from the first form factor that loaded, and are null when none did', () => {
  const desktop = bestPractices.extract(lhr());
  assert.equal(evaluate(null, desktop).informative, desktop.informative);
  assert.equal(evaluate(null, null).informative, null);
});
