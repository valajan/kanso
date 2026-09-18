import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatComment, formatReport, REPORT_MARKER } from '../comment.js';

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

// The same report lands in a job summary through `kanso audit --out`, where no
// re-run will ever look for a marker, and no branch names what was audited.
test('the comment is the report behind its marker, and the report can name its own page', () => {
  const options = { headRef: 'feature', baseRef: 'main', source: 'CI', detected: false };
  assert.equal(formatComment(scoresPrOnly, options), `${REPORT_MARKER}\n${formatReport(scoresPrOnly, options)}`);

  const report = formatReport(scoresPrOnly, { header: '🔗 `dist`', refLabel: 'budget', referenceKind: 'budgets', currentLabel: 'current' });
  assert.match(report, /^## Kanso \| Audit Report\n\n🔗 `dist`\n/);
  assert.match(report, /\| Metric \| budget \| current \| Δ \| \|/);
  assert.doesNotMatch(report, /kanso:report/);
});

test('falls back to a URL header when no head ref is given', () => {
  const body = formatComment(scoresPrOnly, { previewUrl: 'https://preview.example' });
  assert.ok(body.includes('🔗 URL: https://preview.example'));
});

test('renders Mobile and Desktop sections side by side', () => {
  const body = formatComment(scoresPrOnly, { headRef: 'feature' });
  assert.ok(body.includes('### 📱 Mobile'));
  assert.ok(body.includes('### 💻 Desktop'));
  // mobile perf cell: Lighthouse's "poor" boundary as the budget, no main score
  assert.ok(body.includes('| Performance | 49 | — | 95 |'));
  // desktop perf cell
  assert.ok(body.includes('| Performance | 49 | — | 98 |'));
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
  assert.ok(body.includes('| Metric | budget | main | PR | Δ | |'));
  assert.ok(body.includes('| Performance | 49 | 90 | 95 | +5 | ✅ |'));
  assert.ok(body.includes('| LCP | 4000ms | 2500ms | 2000ms | -500ms | ✅ |'));
});

test('marks a metric outside its budget as failed', () => {
  const refMobile = { performance: 95, lcp: 2000, tbt: 100, cls: 0.05, fcp: 1200 };
  const regressed = { ...mobileScore, lcp: 5000 };
  const scores = {
    mobile:  { pr: regressed,    ref: refMobile },
    desktop: { pr: desktopScore, ref: null },
  };
  const body = formatComment(scores, { headRef: 'feature', budget: { lcp: 4000 } });
  assert.ok(body.includes('| LCP | 4000ms | 2000ms | 5000ms | +3000ms | ❌ |'));
});

// The icon is read against the budget, the Δ against main: a PR scoring what
// main scores still fails a budget both miss, and the row says which.
test('a metric equal to main that fails its budget shows the budget it fails', () => {
  const scores = {
    mobile:  { pr: mobileScore, ref: mobileScore },
    desktop: { pr: desktopScore, ref: desktopScore },
  };
  const body = formatComment(scores, { headRef: 'feature', budget: { performance: 101 } });
  assert.ok(body.includes('| Performance | 101 | 95 | 95 | +0 | ❌ |'));
});

test('against budgets alone, the budget is the reference column and Δ the distance to it', () => {
  const body = formatComment(scoresPrOnly, { headRef: 'feature', budget: { lcp: 3000 }, refLabel: 'budgets', referenceKind: 'budgets' });
  assert.ok(body.includes('| Metric | budgets | PR | Δ | |'));
  assert.ok(body.includes('| LCP | 3000ms | 2000ms | -1000ms | ✅ |'));
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
  assert.ok(body.includes('| `image-alt` | critical | 2 elements | new | ❌ |'));
  assert.ok(body.includes('| `heading-order` | moderate | 1 element | new | ⚠️ |'));
  assert.ok(body.includes('<details><summary>What failed, and where</summary>'));
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

  assert.ok(body.includes('> ❌ 1 Accessibility finding\n'), body.split('\n').slice(0, 6).join('\n'));
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

  assert.ok(body.includes('| `label` | serious | 2 elements | inherited | ✅ |'));
  assert.ok(body.includes('_failing from `serious` up · 1 already on `trunk` · 1 fixed_'));
  assert.ok(!body.includes('<details>'), 'nothing to fix, nothing to unfold');
});

// A change that fixed every finding leaves an empty section, which still has
// to say what was fixed — and has nothing to say of what was already there.
test('an emptied section says what was fixed', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature', baseRef: 'trunk',
    modules: accessibility([], { comparedToBaseline: true, fixed: [{ rule: 'link-name', title: 't', impact: 'serious', count: 1 }] }),
  });

  assert.ok(body.includes('_No findings — every rule checked passed._\n\n_failing from `serious` up · 1 fixed_'));
  assert.ok(!body.includes('already on'));
});

test('the verdict names metrics as the tables do', () => {
  const failing = { mobile: { pr: { ...mobileScore, performance: 40, lcp: 5000, tbt: 300 }, ref: null }, desktop: { pr: desktopScore, ref: null } };
  const body = formatComment(failing, { headRef: 'feature' });
  assert.ok(body.includes('> ❌ Performance, LCP failed · ⚠️ TBT warning'));
});

test('a module that found nothing says so, and the ones that ran nothing say nothing', () => {
  const clean = formatComment(scoresPrOnly, { headRef: 'feature', modules: accessibility([]) });
  assert.ok(clean.includes('_No findings — every rule checked passed._\n\n_failing from `serious` up_'));

  const absent = formatComment(scoresPrOnly, { headRef: 'feature', modules: accessibility(null) });
  assert.ok(!absent.includes('### ♿ Accessibility'));
});

// SEO and best practices report through the same section as accessibility,
// and their failures are not all DOM elements: a console error is a script and
// a line, a missing doctype is nothing at all.
test('a failure with no DOM element is shown by what it names, or by what Lighthouse says of it', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature',
    modules: {
      'best-practices': { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings: [
        { rule: 'doctype', title: 'Page lacks the HTML doctype', impact: 'moderate', count: 0, state: null, level: 'warn', nodes: [], detail: 'Document must contain a doctype' },
        { rule: 'errors-in-console', title: 'Browser errors were logged to the console', impact: 'moderate', count: 1, state: null, level: 'warn', nodes: [
          { selector: '', snippet: '', label: '', explanation: 'Description: Failed to load resource: 404', url: 'http://localhost:4173/favicon.ico:1:0' },
        ] },
      ] },
    },
  });

  assert.ok(body.includes('### 🧰 Best Practices'));
  assert.ok(body.includes('| `doctype` | moderate |  | — | ⚠️ |'), 'a rule broken as a whole has no element count');
  assert.ok(body.includes('| `errors-in-console` | moderate | 1 item | — | ⚠️ |'));
  assert.ok(body.includes('**`doctype`** — Page lacks the HTML doctype\nDocument must contain a doctype'));
  assert.ok(body.includes('Description: Failed to load resource: 404\n- `http://localhost:4173/favicon.ico:1:0`'));
});

test('a missing tag is listed by what is missing, with no empty place before it', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature',
    modules: {
      seo: { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings: [
        { rule: 'open-graph', title: 'Open Graph tags are missing or unusable', impact: 'minor', count: 2, state: null, level: 'warn', nodes: [
          { selector: '', snippet: '', label: '', explanation: 'og:description is missing' },
          { selector: 'head > meta', snippet: '<meta property="og:image" content="/og.png">', label: '', explanation: 'og:image is not an absolute URL: /og.png' },
        ] },
      ] },
    },
  });

  assert.ok(body.includes('| `open-graph` | minor | 2 items | — | ⚠️ |'));
  assert.ok(body.includes('**`open-graph`** — Open Graph tags are missing or unusable\n- og:description is missing\n- `head > meta` `<meta property="og:image" content="/og.png">` — og:image is not an absolute URL: /og.png'));
});

test('a probe that did not run is said under its section, with the rules it left unchecked', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature',
    modules: accessibility([], { probeFailures: [{ probe: 'reflow', rules: ['reflow-scroll', 'reflow-clip'], side: 'baseline', formFactor: 'mobile', error: 'timed out after 30s' }] }),
  });

  assert.ok(body.includes('_failing from `serious` up_\n_⚠️ `reflow` did not run on the mobile reference (timed out after 30s): `reflow-scroll`, `reflow-clip` unchecked_'));
});

test('each module reporting findings gets its own section, and says what it ignored', () => {
  const body = formatComment(scoresPrOnly, {
    headRef: 'feature',
    modules: { seo: { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings: [], ignore: ['is-crawlable'] } },
  });

  assert.ok(body.includes('### 🔍 SEO'));
  assert.ok(body.includes('_No findings — every rule checked passed._\n\n_failing from `serious` up · ignoring `is-crawlable`_'), 'what was not looked at is said');
});
