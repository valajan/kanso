import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatComment } from '../comment.js';

const prScore = { performance: 95, lcp: 2.0, tbt: 100, cls: 0.05, fcp: 1.2 };

test('renders the header with branch refs and source', () => {
  const body = formatComment(prScore, null, { headRef: 'feature', baseRef: 'main', source: 'Netlify Preview' });
  assert.ok(body.includes('`feature` → `main` · Netlify Preview detected automatically'));
});

test('falls back to a URL header when no head ref is given', () => {
  const body = formatComment(prScore, null, { previewUrl: 'https://preview.example' });
  assert.ok(body.includes('🔗 URL: https://preview.example'));
});

test('shows the no-reference note when there is no main score and no budget', () => {
  const body = formatComment(prScore, null, { headRef: 'feature' });
  assert.ok(body.includes('No reference score for main yet'));
});

test('omits the no-reference note once a budget is configured', () => {
  const body = formatComment(prScore, null, { headRef: 'feature', budget: { lcp: 3.0 } });
  assert.ok(!body.includes('No reference score for main yet'));
});

test('renders deltas and a celebration icon when the PR improves on main', () => {
  const refScore = { performance: 90, lcp: 2.5, tbt: 150, cls: 0.08, fcp: 1.5 };
  const body = formatComment(prScore, refScore, { headRef: 'feature' });
  // performance improved (95 > 90) and LCP improved (2.0 < 2.5) → 🎉
  assert.ok(body.includes('| Performance | 90 | 95 | +5 | 🎉 |'));
  assert.ok(body.includes('| LCP | 2.5s | 2.0s | -0.5s | 🎉 |'));
});

test('marks a metric outside its budget as failed', () => {
  const refScore = { performance: 95, lcp: 2.0, tbt: 100, cls: 0.05, fcp: 1.2 };
  const regressed = { ...prScore, lcp: 5.0 };
  const body = formatComment(regressed, refScore, { headRef: 'feature', budget: { lcp: 4.0 } });
  assert.ok(body.includes('| LCP | 2.0s | 5.0s | +3.0s | ❌ |'));
});
