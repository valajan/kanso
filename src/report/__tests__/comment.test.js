import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatComment } from '../comment.js';

const mobileScore  = { performance: 95, lcp: 2000, tbt: 100, cls: 0.05, fcp: 1200 };
const desktopScore = { performance: 98, lcp: 1500, tbt: 50,  cls: 0.02, fcp: 900 };

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
  const body = formatComment(scoresPrOnly, { headRef: 'feature', budget: { lcp: 3000 } });
  assert.ok(!body.includes('No reference score for main yet'));
});

test('omits the no-reference note when at least one form factor has a main score', () => {
  const scores = {
    mobile:  { pr: mobileScore,  ref: { performance: 90, lcp: 2500, tbt: 150, cls: 0.08, fcp: 1500 } },
    desktop: { pr: desktopScore, ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature' });
  assert.ok(!body.includes('No reference score for main yet'));
});

test('renders deltas and a pass icon when the PR improves on main', () => {
  const refMobile = { performance: 90, lcp: 2500, tbt: 150, cls: 0.08, fcp: 1500 };
  const scores = {
    mobile:  { pr: mobileScore,  ref: refMobile },
    desktop: { pr: desktopScore, ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature' });
  assert.ok(body.includes('| Performance | 90 | 95 | +5 | ✅ |'));
  assert.ok(body.includes('| LCP | 2500ms | 2000ms | -500ms | ✅ |'));
});

test('marks a metric outside its budget as failed', () => {
  const refMobile = { performance: 95, lcp: 2000, tbt: 100, cls: 0.05, fcp: 1200 };
  const regressed = { ...mobileScore, lcp: 5000 };
  const scores = {
    mobile:  { pr: regressed,    ref: refMobile },
    desktop: { pr: desktopScore, ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature', budget: { lcp: 4000 } });
  assert.ok(body.includes('| LCP | 2000ms | 5000ms | +3000ms | ❌ |'));
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
