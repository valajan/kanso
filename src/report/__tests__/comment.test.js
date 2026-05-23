import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatComment } from '../comment.js';

const mobileScore  = { performance: 95, lcp: 2.0, tbt: 100, cls: 0.05, fcp: 1.2 };
const desktopScore = { performance: 98, lcp: 1.5, tbt: 50,  cls: 0.02, fcp: 0.9 };

const scoresPrOnly = {
  mobile:  { pr: mobileScore,  ref: null },
  desktop: { pr: desktopScore, ref: null },
};

test('renders the header with branch refs and source', () => {
  const body = formatComment(scoresPrOnly, { headRef: 'feature', baseRef: 'main', source: 'Netlify Preview' });
  assert.ok(body.includes('`feature` → `main` · Netlify Preview detected automatically'));
});

test('falls back to a URL header when no head ref is given', () => {
  const body = formatComment(scoresPrOnly, { previewUrl: 'https://preview.example' });
  assert.ok(body.includes('🔗 URL: https://preview.example'));
});

test('renders Mobile and Desktop sections side by side', () => {
  const body = formatComment(scoresPrOnly, { headRef: 'feature' });
  assert.ok(body.includes('### 📱 Mobile'));
  assert.ok(body.includes('### 💻 Desktop'));
  // mobile perf cell
  assert.ok(body.includes('| Performance | — | 95 |'));
  // desktop perf cell
  assert.ok(body.includes('| Performance | — | 98 |'));
});

test('shows the no-reference note when no form factor has a main score and no budget', () => {
  const body = formatComment(scoresPrOnly, { headRef: 'feature' });
  assert.ok(body.includes('No reference score for main yet'));
});

test('omits the no-reference note once a budget is configured', () => {
  const body = formatComment(scoresPrOnly, { headRef: 'feature', budget: { lcp: 3.0 } });
  assert.ok(!body.includes('No reference score for main yet'));
});

test('omits the no-reference note when at least one form factor has a main score', () => {
  const scores = {
    mobile:  { pr: mobileScore,  ref: { performance: 90, lcp: 2.5, tbt: 150, cls: 0.08, fcp: 1.5 } },
    desktop: { pr: desktopScore, ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature' });
  assert.ok(!body.includes('No reference score for main yet'));
});

test('renders deltas and a celebration icon when the PR improves on main', () => {
  const refMobile = { performance: 90, lcp: 2.5, tbt: 150, cls: 0.08, fcp: 1.5 };
  const scores = {
    mobile:  { pr: mobileScore,  ref: refMobile },
    desktop: { pr: desktopScore, ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature' });
  assert.ok(body.includes('| Performance | 90 | 95 | +5 | 🎉 |'));
  assert.ok(body.includes('| LCP | 2.5s | 2.0s | -0.5s | 🎉 |'));
});

test('marks a metric outside its budget as failed', () => {
  const refMobile = { performance: 95, lcp: 2.0, tbt: 100, cls: 0.05, fcp: 1.2 };
  const regressed = { ...mobileScore, lcp: 5.0 };
  const scores = {
    mobile:  { pr: regressed,    ref: refMobile },
    desktop: { pr: desktopScore, ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature', budget: { lcp: 4.0 } });
  assert.ok(body.includes('| LCP | 2.0s | 5.0s | +3.0s | ❌ |'));
});

test('reports a failed audit for a missing form factor', () => {
  const scores = {
    mobile:  { pr: mobileScore, ref: null },
    desktop: { pr: null,        ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature' });
  assert.ok(body.includes('### 💻 Desktop'));
  assert.ok(body.includes('Lighthouse audit failed'));
});
