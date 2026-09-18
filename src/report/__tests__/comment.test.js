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

// --- findings sections ------------------------------------------------------

const accessibility = (findings, extra = {}) => ({
  accessibility: { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings, ...extra },
});

test('renders a findings section with the failing elements folded away', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature',
    modules: accessibility([
      { rule: 'image-alt', title: 'Images lack an alt attribute.', impact: 'critical', count: 2, state: 'new', level: 'fail', nodes: [{ selector: 'img.logo' }, { selector: 'img.hero' }] },
      { rule: 'heading-order', title: 'Headings skip a level.', impact: 'moderate', count: 1, state: 'new', level: 'warn', nodes: [{ selector: 'h3.sub' }] },
    ]),
  });

  assert.ok(body.includes('### ♿ Accessibility'));
  assert.ok(body.includes('| `image-alt` | critical | 2 | new | ❌ |'));
  assert.ok(body.includes('| `heading-order` | moderate | 1 | new | ⚠️ |'));
  assert.ok(body.includes('<details><summary>Failing elements</summary>'));
  assert.ok(body.includes('- `img.logo`'));
  assert.ok(body.includes('_failing from `serious` up_'));
});

test('the failing elements say what is wrong with them, once when it is the same', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature',
    modules: accessibility([
      { rule: 'image-alt', title: 't', impact: 'critical', count: 2, state: null, level: 'fail', nodes: [
        { selector: 'img.logo', snippet: '<img src="/logo.png">', explanation: 'Fix any of the following:\n  Element does not have an alt attribute' },
        { selector: 'img.hero', explanation: 'Fix any of the following:\n  Element does not have an alt attribute' },
      ] },
      { rule: 'color-contrast', title: 't', impact: 'serious', count: 2, state: null, level: 'fail', nodes: [
        { selector: 'p.muted', label: 'Get\n  started', explanation: 'Fix any of the following:\n  Element has insufficient color contrast of 4.27' },
        { selector: 'a.cta', explanation: 'Fix any of the following:\n  Element has an <svg> with role=*img*' },
      ] },
    ]),
  });

  assert.ok(body.includes('**`image-alt`** — t\nElement does not have an alt attribute\n- `img.logo` `<img src="/logo.png">`\n- `img.hero`'));
  assert.ok(body.includes('- `p.muted` “Get started” — Element has insufficient color contrast of 4.27'));
  assert.ok(body.includes('- `a.cta` — Element has an \\<svg\\> with role=\\*img\\*'), 'axe\'s text is not read as markup');
});

test('the verdict counts the findings alongside the metrics', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature',
    modules: accessibility([
      { rule: 'image-alt', title: 't', impact: 'critical', count: 1, state: 'new', level: 'fail', nodes: [] },
      { rule: 'label', title: 't', impact: 'serious', count: 1, state: 'inherited', level: 'pass', nodes: [] },
    ]),
  });

  assert.ok(body.includes('> ❌ 1 accessibility finding\n'), body.split('\n').slice(0, 6).join('\n'));
});

// A reader cannot tell a clean page from a page whose findings were all there
// before, unless the report says which it is.
test('a compared section says what was inherited and what was fixed', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature', baseRef: 'trunk',
    modules: accessibility(
      [{ rule: 'label', title: 't', impact: 'serious', count: 2, state: 'inherited', level: 'pass', nodes: [] }],
      { comparedToBaseline: true, fixed: [{ rule: 'link-name', title: 't', impact: 'serious', count: 1 }] },
    ),
  });

  assert.ok(body.includes('| `label` | serious | 2 | inherited | ✅ |'));
  assert.ok(body.includes('_failing from `serious` up · 1 already on `trunk` · 1 fixed_'));
  assert.ok(!body.includes('<details>'), 'nothing to fix, nothing to unfold');
});

test('a module that found nothing says so, and the ones that ran nothing say nothing', () => {
  const clean = formatComment(scoresPrOnly, { headRef: 'feature', modules: accessibility([]) });
  assert.ok(clean.includes('_No findings — nothing failed an accessibility rule._'));

  const absent = formatComment(scoresPrOnly, { headRef: 'feature', modules: accessibility(null) });
  assert.ok(!absent.includes('### ♿ Accessibility'));
});
